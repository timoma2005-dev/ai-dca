/* global setTimeout, clearTimeout, console */
// POST /api/notify/switch/recommend：换基方案「智能自动填充」（CN 版）。
//
// 移植自 origin/test workers/notify/src/switchRecommendation.js 的选择语义（候选池 → 选对手方 →
// H/L 分组 → 双向阈值网格 → 回放触发次数 / 胜率；找不到持仓按 10000 元），但溢价改为用
// 最近交易日的 1m / 5m 盘中价计算，而不是日 K：
//   盘中溢价% = (分钟收盘价 / 参考净值 − 1) × 100，参考净值取「该交易日之前、两只基金都已公布的最新单位净值」；
//   价差% = H 溢价 − L 溢价（同一分钟、两只都有成交才算）。
// 阈值：在价差分布分位数（L→H 切回取 5%~50% 分位，H→L 切出取 50%~95% 分位）上做网格，
// 要求 切出 − 切回 ≥ 往返成本 = 2 ×（双边费率 feeWanRate×2 + 估计滑点 1 tick），
// 按分钟级回放的超额收益 > 胜率 > 完成轮数 选择；无有效信号时回退到 20%/80% 分位。
import { fetchMinuteBars, fetchNavHistory } from './minuteKline.js';

export const SWITCH_RECOMMEND_POOL = Object.freeze([
  ['513100', '国泰纳斯达克100ETF'], ['159501', '嘉实纳斯达克100ETF(QDII)'], ['159941', '广发纳斯达克100ETF'],
  ['159696', '易方达纳斯达克100ETF(QDII)'], ['159659', '招商纳斯达克100ETF(QDII)'], ['159632', '华安纳斯达克100ETF(QDII)'],
  ['513300', '华夏纳斯达克100ETF(QDII)'], ['513870', '富国纳斯达克100ETF(QDII)'], ['513110', '华泰柏瑞纳斯达克100ETF(QDII)'],
  ['159660', '汇添富纳斯达克100ETF'], ['513390', '博时纳斯达克100ETF(QDII)'], ['159513', '大成纳斯达克100ETF(QDII)']
].map(([code, name]) => Object.freeze({ code, name })));
const POOL_CODES = SWITCH_RECOMMEND_POOL.map((item) => item.code);
const POOL_NAME = Object.fromEntries(SWITCH_RECOMMEND_POOL.map((item) => [item.code, item.name]));

export const DEFAULT_HOLDING_NOTIONAL = 10000;
export const REQUEST_BUDGET_MS = 9500;
const TICK = 0.001;
const MIN_PAIR_BARS = { '1m': 240, '5m': 96 };
const LOWER_QS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
const UPPER_QS = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

const round = (value, digits = 4) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
};
const fail = (status, code, error) => ({ status, body: { ok: false, code, error } });

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 读取用户 cn-data 账本里某只基金的净持有份额（BUY − SELL）；没有则返回 null。 */
export function readLedgerHolding(db, userId, code) {
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  let txs = db.prepare('SELECT payload FROM account_holdings_transactions WHERE user_id = ? AND deleted = 0')
    .all(String(userId)).map((row) => parse(row.payload)).filter(Boolean);
  if (!txs.length) {
    const row = db.prepare("SELECT payload FROM account_resources WHERE user_id = ? AND resource = 'holdings/ledger' AND deleted = 0").get(String(userId));
    const ledger = row ? parse(row.payload) : null;
    txs = Array.isArray(ledger?.transactions) ? ledger.transactions : [];
  }
  let quantity = 0;
  let name = '';
  for (const tx of txs) {
    if (String(tx?.code || '').replace(/^(sh|sz)/i, '') !== code) continue;
    const shares = Number(tx?.shares);
    if (!Number.isFinite(shares)) continue;
    const type = String(tx?.type || '').toUpperCase();
    if (type === 'BUY') quantity += shares;
    else if (type === 'SELL') quantity -= shares;
    else continue;
    name = String(tx?.name || name);
  }
  return quantity > 1e-6 ? { quantity: round(quantity, 4), name } : null;
}

/** 两只基金同一分钟的溢价与价差（a − b），参考净值取 bar 日期之前两者共同的最新净值日。 */
export function buildPairSeries(barsA, barsB, navA, navB) {
  const navMapA = new Map(navA.map((item) => [item.date, item.nav]));
  const navMapB = new Map(navB.map((item) => [item.date, item.nav]));
  const navDates = [...navMapA.keys()].filter((date) => navMapB.has(date)).sort();
  const byTimeB = new Map(barsB.map((bar) => [bar.t, bar]));
  const rows = [];
  let pointer = -1;
  for (const barA of barsA) {
    const barB = byTimeB.get(barA.t);
    if (!barB) continue;
    while (pointer + 1 < navDates.length && navDates[pointer + 1] < barA.date) pointer += 1;
    if (pointer < 0) continue;
    const navDate = navDates[pointer];
    const premA = (barA.close / navMapA.get(navDate) - 1) * 100;
    const premB = (barB.close / navMapB.get(navDate) - 1) * 100;
    rows.push({ t: barA.t, date: barA.date, navDate, priceA: barA.close, priceB: barB.close, premA, premB, spread: premA - premB });
  }
  return rows;
}

/** 把 a/b 序列按 H/L 定向：spread = 溢价(H) − 溢价(L)。 */
function orient(rows, aIsHigh) {
  return rows.map((row) => aIsHigh
    ? { t: row.t, date: row.date, priceH: row.priceA, priceL: row.priceB, spread: row.spread }
    : { t: row.t, date: row.date, priceH: row.priceB, priceL: row.priceA, spread: -row.spread });
}

export function describeSpread(rows) {
  const values = rows.map((row) => row.spread);
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  const std = (list) => {
    const m = list.reduce((sum, value) => sum + value, 0) / (list.length || 1);
    return Math.sqrt(list.reduce((sum, value) => sum + (value - m) ** 2, 0) / (list.length || 1));
  };
  const days = [...new Set(rows.map((row) => row.date))];
  return {
    bars: rows.length,
    tradingDays: days.length,
    from: rows[0]?.t || null,
    to: rows[rows.length - 1]?.t || null,
    meanPct: round(mean),
    stdPct: round(std(values)),
    recentStdPct: round(std(values.slice(-60))),
    p05Pct: round(quantile(sorted, 0.05)),
    p25Pct: round(quantile(sorted, 0.25)),
    p50Pct: round(quantile(sorted, 0.5)),
    p75Pct: round(quantile(sorted, 0.75)),
    p95Pct: round(quantile(sorted, 0.95)),
    lastPct: round(values[values.length - 1])
  };
}

/** 分钟级回放：H 持有且价差 ≥ upper → 切 L；L 持有且价差 ≤ lower → 切回 H。按收盘价成交，每次切换扣 costPct。 */
export function replaySpread(rows, { startSide, lowerPct, upperPct, costPct }) {
  if (!rows.length) return { triggerCount: 0, cycleCount: 0, winCount: 0, winRatePct: null, excessReturnPct: null };
  const price = (side, row) => (side === 'H' ? row.priceH : row.priceL);
  const keep = 1 - costPct / 100;
  let side = startSide === 'L' ? 'L' : 'H';
  const start = side;
  let shares = 1 / price(side, rows[0]);
  let cycleBase = 0;
  let triggerCount = 0;
  let cycleCount = 0;
  let winCount = 0;
  for (const row of rows) {
    const next = side === 'H' && row.spread >= upperPct ? 'L' : side === 'L' && row.spread <= lowerPct ? 'H' : '';
    if (!next) continue;
    const value = shares * price(side, row);
    if (side === start) cycleBase = value / price(start, row);
    shares = (value * keep) / price(next, row);
    side = next;
    triggerCount += 1;
    if (side === start) {
      cycleCount += 1;
      if (shares > cycleBase) winCount += 1;
    }
  }
  const last = rows[rows.length - 1];
  const baseline = price(start, last) / price(start, rows[0]);
  return {
    triggerCount,
    cycleCount,
    winCount,
    winRatePct: cycleCount ? round((winCount / cycleCount) * 100, 1) : null,
    excessReturnPct: round(((shares * price(side, last)) / baseline - 1) * 100)
  };
}

/** 在价差分位数网格上选双向阈值。 */
export function selectThresholds(rows, { startSide, costPct }) {
  const sorted = rows.map((row) => row.spread).sort((a, b) => a - b);
  const minBandPct = round(2 * costPct, 4);
  const lowers = [...new Set(LOWER_QS.map((q) => round(quantile(sorted, q), 2)))];
  const uppers = [...new Set(UPPER_QS.map((q) => round(quantile(sorted, q), 2)))];
  const trials = [];
  for (const lowerPct of lowers) {
    for (const upperPct of uppers) {
      if (!(upperPct > lowerPct) || upperPct - lowerPct < minBandPct - 1e-9) continue;
      trials.push({ lowerPct, upperPct, ...replaySpread(rows, { startSide, lowerPct, upperPct, costPct }) });
    }
  }
  const eligible = trials.filter((item) => item.cycleCount > 0 && item.excessReturnPct > 0).sort((a, b) =>
    (b.excessReturnPct - a.excessReturnPct) || ((b.winRatePct ?? 0) - (a.winRatePct ?? 0))
    || (b.cycleCount - a.cycleCount) || ((b.upperPct - b.lowerPct) - (a.upperPct - a.lowerPct)));
  if (eligible.length) return { ...eligible[0], status: 'optimized', minBandPct, trialCount: trials.length };
  const lowerPct = round(quantile(sorted, 0.2), 2);
  const upperPct = round(Math.max(quantile(sorted, 0.8), lowerPct + Math.max(minBandPct, 0.01)), 2);
  return { lowerPct, upperPct, ...replaySpread(rows, { startSide, lowerPct, upperPct, costPct }), status: 'fallback', minBandPct, trialCount: trials.length };
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const consume = async () => { while (cursor < items.length) { const index = cursor++; output[index] = await worker(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return output;
}

async function loadMarketData(codes, deps) {
  const entries = await mapLimit(codes, 6, async (code) => {
    const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error: String(error?.message || error) }));
    const [m1, m5, nav] = await Promise.all([
      settle(fetchMinuteBars(code, '1m', deps)), settle(fetchMinuteBars(code, '5m', deps)), settle(fetchNavHistory(code, deps))
    ]);
    return [code, { m1, m5, nav }];
  });
  return Object.fromEntries(entries);
}

function pairForTimeframe(data, holdingCode, code, tf) {
  const key = tf === '1m' ? 'm1' : 'm5';
  const a = data[holdingCode]; const b = data[code];
  if (!a?.[key]?.value || !b?.[key]?.value || !a.nav.value || !b.nav.value) return [];
  return buildPairSeries(a[key].value.bars, b[key].value.bars, a.nav.value, b.nav.value);
}

/** 纯计算：给定已加载的行情，选对手方 / 分组 / 阈值。 */
export function computeRecommendation({ holdingCode, feeWanRate, data }) {
  const holding = data[holdingCode];
  if (!holding?.nav?.value || (!holding.m1?.value && !holding.m5?.value)) {
    const reasons = ['m1', 'm5', 'nav'].map((key) => holding?.[key]?.error).filter(Boolean).join('；');
    throw Object.assign(new Error(`${holdingCode} 分钟行情或净值获取失败${reasons ? `：${reasons}` : ''}`), { status: 502, code: 'UPSTREAM_UNAVAILABLE' });
  }
  const candidates = POOL_CODES.filter((code) => code !== holdingCode);
  const pairs = candidates.map((code) => ({ code, m1: pairForTimeframe(data, holdingCode, code, '1m'), m5: pairForTimeframe(data, holdingCode, code, '5m') }));
  const timeframe = pairs.some((pair) => pair.m1.length >= MIN_PAIR_BARS['1m']) ? '1m' : '5m';
  const key = timeframe === '1m' ? 'm1' : 'm5';
  const lastPrice = (holding.m1?.value?.bars.at(-1) || holding.m5?.value?.bars.at(-1))?.close;
  const scenarios = [];
  for (const pair of pairs) {
    const rows = pair[key];
    if (rows.length < MIN_PAIR_BARS[timeframe]) continue;
    const groupingRows = pair.m5.length >= MIN_PAIR_BARS['5m'] ? pair.m5 : rows;
    const medianAB = quantile(groupingRows.map((row) => row.spread).sort((x, y) => x - y), 0.5);
    const holdingIsHigh = medianAB >= 0;
    const oriented = orient(rows, holdingIsHigh);
    const avgPrice = (oriented.reduce((sum, row) => sum + row.priceH + row.priceL, 0) / (2 * oriented.length)) || lastPrice;
    const slippagePct = (TICK / avgPrice) * 100;
    const costPct = 2 * (feeWanRate / 100) + slippagePct;
    const holdingSide = holdingIsHigh ? 'H' : 'L';
    const selection = selectThresholds(oriented, { startSide: holdingSide, costPct });
    scenarios.push({ code: pair.code, pair, holdingIsHigh, holdingSide, oriented, slippagePct, costPct, selection });
  }
  if (!scenarios.length) {
    throw Object.assign(new Error('最近交易日没有足够的同时成交分钟数据，无法计算溢价差（可能停牌或数据源暂不可用）'), { status: 502, code: 'INSUFFICIENT_MINUTE_DATA' });
  }
  scenarios.sort((a, b) => (Number(b.selection.status === 'optimized') - Number(a.selection.status === 'optimized'))
    || ((b.selection.excessReturnPct ?? -Infinity) - (a.selection.excessReturnPct ?? -Infinity))
    || ((b.selection.winRatePct ?? 0) - (a.selection.winRatePct ?? 0))
    || (b.selection.cycleCount - a.selection.cycleCount));
  const best = scenarios[0];
  const otherTf = timeframe === '1m' ? '5m' : '1m';
  const otherRows = orient(best.pair[timeframe === '1m' ? 'm5' : 'm1'], best.holdingIsHigh);
  const crossCheck = otherRows.length >= MIN_PAIR_BARS[otherTf]
    ? { timeframe: otherTf, ...describeSpread(otherRows), ...replaySpread(otherRows, { startSide: best.holdingSide, lowerPct: best.selection.lowerPct, upperPct: best.selection.upperPct, costPct: best.costPct }) }
    : null;
  return { timeframe, best, crossCheck, lastPrice, scenarioCount: scenarios.length };
}

function buildRule({ holdingCode, feeWanRate, ledger, result, sources, dataIssues }) {
  const { timeframe, best, crossCheck, lastPrice } = result;
  const highCode = best.holdingIsHigh ? holdingCode : best.code;
  const lowCode = best.holdingIsHigh ? best.code : holdingCode;
  const stats = describeSpread(best.oriented);
  const holdingNotional = ledger && lastPrice > 0 ? round(ledger.quantity * lastPrice, 2) : DEFAULT_HOLDING_NOTIONAL;
  const sel = best.selection;
  const feeRatePct = feeWanRate / 100;
  const holdingNote = ledger ? `持仓取自账本 ${ledger.quantity} 份` : `账本未找到 ${holdingCode} 持仓，按 ${DEFAULT_HOLDING_NOTIONAL} 元估算费用`;
  const message = `基于最近 ${stats.tradingDays} 个交易日 ${timeframe} 盘中溢价差（${stats.from} ~ ${stats.to}，${stats.bars} 根）：`
    + `H=${highCode} / L=${lowCode}，价差中位 ${round(stats.p50Pct, 2)}%、当前 ${round(stats.lastPct, 2)}%；`
    + `切出 ≥ ${sel.upperPct}% / 切回 ≤ ${sel.lowerPct}%（往返成本 ${round(2 * best.costPct, 3)}%），`
    + `回放触发 ${sel.triggerCount} 次、完成 ${sel.cycleCount} 轮${sel.winRatePct === null ? '' : `、胜率 ${sel.winRatePct}%`}`
    + `${sel.status === 'fallback' ? '（窗口内无有效往返信号，阈值按 20%/80% 分位参考）' : ''}`
    + `${crossCheck ? `；${crossCheck.timeframe} 校验 ${crossCheck.tradingDays} 日触发 ${crossCheck.triggerCount} 次` : ''}；${holdingNote}。`;
  return {
    name: `${holdingCode} ⇄ ${best.code} 分钟溢价切换`,
    highCodes: [highCode],
    lowCodes: [lowCode],
    highCode,
    lowCode,
    lowerPct: sel.lowerPct,
    upperPct: sel.upperPct,
    holdingSide: best.holdingSide,
    holdingFundCode: holdingCode,
    holdingFundName: POOL_NAME[holdingCode] || ledger?.name || '',
    holdingQuantity: ledger ? ledger.quantity : null,
    holdingNotional,
    holdingSource: ledger ? 'ledger' : 'default',
    candidateFundCodes: POOL_CODES.filter((code) => code !== holdingCode),
    recommendedCandidate: { code: best.code, name: POOL_NAME[best.code] || '' },
    feeConfig: {
      mode: 'estimated_total',
      feeWanRate,
      sellCommissionRate: round(feeRatePct, 4),
      buyCommissionRate: round(feeRatePct, 4),
      slippagePct: round(best.slippagePct, 4),
      switchCostPct: round(best.costPct, 4),
      estimatedTotalFee: round(holdingNotional * (feeWanRate / 10000) * 2, 2)
    },
    backtestTimeframe: timeframe,
    backtest: {
      timeframe,
      ...stats,
      lowerPct: sel.lowerPct,
      upperPct: sel.upperPct,
      minBandPct: sel.minBandPct,
      triggerCount: sel.triggerCount,
      cycleCount: sel.cycleCount,
      winRatePct: sel.winRatePct,
      excessReturnPct: sel.excessReturnPct,
      selectionStatus: sel.status,
      trialCount: sel.trialCount,
      candidatesEvaluated: result.scenarioCount,
      crossCheck
    },
    dataSources: sources,
    dataIssues,
    message,
    generatedAt: new Date().toISOString()
  };
}

/** 路由处理：返回 { status?, body }。deps 可注入 fetchImpl / now / budgetMs（测试用）。 */
export async function handleSwitchRecommend(db, userId, body = {}, deps = {}) {
  const holdingCode = String(body?.holdingCode ?? body?.holdingFundCode ?? '').trim().replace(/^(sh|sz)/i, '');
  if (!/^\d{6}$/.test(holdingCode)) return fail(400, 'INVALID_HOLDING_CODE', '请填写 6 位当前持仓代码。');
  const feeWanRate = body?.feeWanRate === undefined || body?.feeWanRate === '' ? 1 : Number(body.feeWanRate);
  if (!Number.isFinite(feeWanRate) || feeWanRate < 0 || feeWanRate > 100) return fail(400, 'INVALID_FEE', '请填写有效的万分之交易费率（0–100）。');
  if (!POOL_CODES.includes(holdingCode)) {
    return fail(400, 'HOLDING_NOT_IN_POOL', `自动填充目前只支持纳指 100 QDII ETF 候选池：${POOL_CODES.join('、')}；${holdingCode} 不在池内，请手动配置。`);
  }
  const budgetMs = Number(deps.budgetMs) > 0 ? Number(deps.budgetMs) : REQUEST_BUDGET_MS;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fail(504, 'RECOMMEND_TIMEOUT', `分钟行情获取超时（>${Math.round(budgetMs / 1000)} 秒），请稍后重试。`)), budgetMs);
  });
  const work = (async () => {
    try {
      const data = await loadMarketData(POOL_CODES, deps);
      const result = computeRecommendation({ holdingCode, feeWanRate, data });
      const ledger = readLedgerHolding(db, userId, holdingCode);
      const used = [holdingCode, result.best.code];
      const sources = Object.fromEntries(used.map((code) => [code, {
        '1m': data[code].m1.value?.source || null, '5m': data[code].m5.value?.source || null, nav: data[code].nav.value ? 'eastmoney-fundmobapi' : null
      }]));
      const dataIssues = POOL_CODES.flatMap((code) => ['m1', 'm5', 'nav'].filter((key) => data[code][key].error)
        .map((key) => ({ code, kind: key, error: data[code][key].error })));
      return { body: { ok: true, rule: buildRule({ holdingCode, feeWanRate, ledger, result, sources, dataIssues }) } };
    } catch (error) {
      if (error?.status) return fail(error.status, error.code || 'RECOMMEND_FAILED', error.message);
      console.error('[cn-data] switch recommend failed:', error);
      return fail(500, 'RECOMMEND_FAILED', '自动填充计算失败，请稍后重试。');
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
