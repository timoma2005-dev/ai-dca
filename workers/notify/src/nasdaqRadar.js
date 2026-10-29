/**
 * 纳指ETF套利雷达：每日净值发布后扫描12只纳指ETF，找出最优套利对。
 *
 * 数据流：
 * 1. cron (35 13 * * MON-FRI，即北京时间21:35，当日净值已发布) 触发 computeNasdaqRadar()
 * 2. 获取12只ETF当日收盘价与单位净值，计算NAV口径溢价率：(收盘价 − 当日净值) / 当日净值 ×100
 * 3. 找出溢价最高/最低对，计算价差
 * 4. 从KV读取近20天价差历史，计算当前分位数
 * 5. 结果存入 KV `nasdaq-radar:latest` 和 `nasdaq-radar:history`
 *
 * 前端通过 /api/nasdaq-radar 接口读取。
 */

import { fetchSwitchOrderBooks, parseFundMobApiReferences } from './switchMarketCollector.js';
import { fetchFundMetricsForCodes } from './getNav.js';
import { isChinaMarketHoliday } from './holdingsNavSupport.js';
import { effectiveSubscribeLimit, scoreRadar } from './radarScoring.js';

const EASTMONEY_FUNDMOB_URL = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo';

// 雷达专用：直接从东方财富 fundmob 获取收盘价与当日净值（不要求2分钟新鲜度）
async function fetchRadarPremiums(codes) {
  const params = new URLSearchParams({
    pageIndex: '1',
    pageSize: '200',
    plat: 'Android',
    appType: 'ttjj',
    product: 'EFund',
    Version: '1',
    deviceid: 'ai-dca-radar',
    Fcodes: codes.join(',')
  });
  const response = await fetch(EASTMONEY_FUNDMOB_URL + '?' + params.toString(), {
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: 'https://fund.eastmoney.com/',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Eastmoney fundmob failed: HTTP ' + response.status);
  const payload = await response.json().catch(() => null);
  if (!payload || payload.Success === false || !Array.isArray(payload.Datas)) {
    throw new Error('Eastmoney fundmob invalid response');
  }
  return parseFundMobApiReferences(payload);
}

// 12只标准纳斯达克100ETF（剔除159509纳指科技ETF、161128信息科技LOF）
export const NASDAQ_ETFS = Object.freeze([
  { code: '159513', name: '大成纳斯达克100ETF' },
  { code: '159941', name: '广发纳斯达克100ETF' },
  { code: '513100', name: '国泰纳斯达克100ETF' },
  { code: '159696', name: '易方达纳斯达克100ETF' },
  { code: '159632', name: '华安纳斯达克100ETF' },
  { code: '513390', name: '博时纳斯达克100ETF' },
  { code: '513300', name: '华夏纳斯达克100ETF' },
  { code: '159501', name: '嘉实纳斯达克100ETF' },
  { code: '513870', name: '富国纳斯达克100ETF' },
  { code: '159660', name: '汇添富纳斯达克100ETF' },
  { code: '513110', name: '华泰柏瑞纳斯达克100ETF' },
  { code: '159659', name: '招商纳斯达克100ETF' },
]);

const KV_LATEST = 'nasdaq-radar:latest';
const KV_HISTORY = 'nasdaq-radar:history';
const KV_FEATURE_HISTORY = 'nasdaq-radar:feature-history:v1';
// 2026-10-29 回填 360 个交易日（收盘价 × 前一披露净值，口径与每日计算一致），上限放到 400 天。
const HISTORY_DAYS = 400; // 每日最优价差历史（存储）
const SPREAD_PERCENTILE_DAYS = 60; // 价差分位只看最近 60 个交易日
const FEATURE_HISTORY_DAYS = 400;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonNegativeNumber(value) {
  const n = finiteNumber(value);
  return n != null && n >= 0 ? n : null;
}

function roundNumber(value, precision = 4) {
  const n = finiteNumber(value);
  if (n == null) return null;
  const factor = 10 ** precision;
  return Math.round(n * factor) / factor;
}

function navPremiumFromRef(ref = {}) {
  const price = finiteNumber(ref?.price);
  const nav = finiteNumber(ref?.latestNav);
  return price != null && price > 0 && nav != null && nav > 0
    ? ((price - nav) / nav) * 100
    : null;
}

function normalizeOrderBookFeatures(bookEntry = null) {
  const book = bookEntry?.orderBook && typeof bookEntry.orderBook === 'object' ? bookEntry.orderBook : null;
  if (!book) {
    return {
      bidPrice: null,
      askPrice: null,
      bidAskSpreadBps: null,
      depth1: null,
      depth5: null,
      orderBookSource: '',
      orderBookAsOf: ''
    };
  }
  const levels = Array.isArray(book.levels) ? book.levels.slice(0, 5) : [];
  const top = levels.find((item) => Number(item?.level) === 1) || levels[0] || book;
  const bidPrice = finiteNumber(top?.bidPrice ?? book?.bidPrice);
  const askPrice = finiteNumber(top?.askPrice ?? book?.askPrice);
  const mid = bidPrice != null && askPrice != null && bidPrice > 0 && askPrice > 0
    ? (bidPrice + askPrice) / 2
    : null;
  const bidAskSpreadBps = mid != null && mid > 0
    ? roundNumber(((askPrice - bidPrice) / mid) * 10000, 4)
    : null;
  const depthAmount = (item) => {
    const bp = finiteNumber(item?.bidPrice);
    const bv = nonNegativeNumber(item?.bidVolume);
    const ap = finiteNumber(item?.askPrice);
    const av = nonNegativeNumber(item?.askVolume);
    return (bp != null && bv != null ? bp * bv : 0) + (ap != null && av != null ? ap * av : 0);
  };
  const normalizedLevels = levels.length ? levels : [top];
  return {
    bidPrice: roundNumber(bidPrice, 4),
    askPrice: roundNumber(askPrice, 4),
    bidAskSpreadBps,
    depth1: roundNumber(depthAmount(normalizedLevels[0]), 2),
    depth5: roundNumber(normalizedLevels.reduce((sum, item) => sum + depthAmount(item), 0), 2),
    orderBookSource: String(bookEntry?.source || book?.source || '').trim(),
    orderBookAsOf: String(bookEntry?.asOf || '').trim()
  };
}

async function collectRadarFeatureSnapshot(env, codes, refs) {
  const fundKinds = Object.fromEntries(codes.map((code) => [code, 'exchange']));
  const [metricsResult, booksResult] = await Promise.allSettled([
    fetchFundMetricsForCodes(env, codes, { refresh: true, fundKinds }),
    fetchSwitchOrderBooks(codes)
  ]);
  const metrics = metricsResult.status === 'fulfilled' && metricsResult.value && typeof metricsResult.value === 'object'
    ? metricsResult.value
    : {};
  const booksPayload = booksResult.status === 'fulfilled' && booksResult.value && typeof booksResult.value === 'object'
    ? booksResult.value
    : {};
  const books = booksPayload.books && typeof booksPayload.books === 'object' ? booksPayload.books : {};

  if (metricsResult.status === 'rejected') {
    console.log('[nasdaq-radar] fund metrics collection failed:', metricsResult.reason?.message || String(metricsResult.reason));
  }
  if (booksResult.status === 'rejected') {
    console.log('[nasdaq-radar] order book collection failed:', booksResult.reason?.message || String(booksResult.reason));
  }

  const etfs = {};
  for (const meta of NASDAQ_ETFS) {
    const ref = refs?.[meta.code] || {};
    const metric = metrics?.[meta.code] || {};
    etfs[meta.code] = {
      code: meta.code,
      name: String(ref?.name || metric?.name || meta.name).trim(),
      premium: roundNumber(navPremiumFromRef(ref), 4),
      premiumSource: 'eastmoney-fundmobapi-nav',
      price: roundNumber(ref?.price ?? metric?.price ?? metric?.currentPrice, 4),
      iopv: roundNumber(ref?.iopv ?? metric?.iopv, 4),
      latestNav: roundNumber(ref?.latestNav ?? metric?.latestNav, 4),
      volume: nonNegativeNumber(metric?.volume),
      turnover: nonNegativeNumber(metric?.turnover ?? metric?.amount),
      marketCapital: nonNegativeNumber(metric?.marketCapital ?? metric?.marketCap),
      totalShares: nonNegativeNumber(metric?.totalShares ?? metric?.total_shares),
      fundMetricsSource: String(metric?.source || '').trim(),
      fundMetricsAsOf: String(metric?.asOf || '').trim(),
      ...normalizeOrderBookFeatures(books?.[meta.code])
    };
  }

  return {
    collectedAt: new Date().toISOString(),
    references: { nasdaq100: '^NDX', usdcny: 'CNY=X' },
    sources: {
      premium: 'eastmoney-fundmobapi-nav',
      fundMetrics: 'markets/fund-metrics',
      orderBook: booksPayload.source || 'tencent+sina-fallback',
      benchmarkKline: 'markets/r2:yahoo'
    },
    etfs
  };
}

async function readFeatureHistory(env) {
  try {
    const stored = await env.NOTIFY_STATE.get(KV_FEATURE_HISTORY, 'json');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

async function upsertFeatureHistory(env, today, featureSnapshot, currentHistory = null) {
  let history = Array.isArray(currentHistory) ? currentHistory : await readFeatureHistory(env);
  history = history.filter((item) => item?.date !== today);
  history.push({ date: today, ...featureSnapshot });
  history.sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));
  history = history.slice(-FEATURE_HISTORY_DAYS);
  await env.NOTIFY_STATE.put(KV_FEATURE_HISTORY, JSON.stringify(history));
  return history;
}

const LIMIT_LOOKBACK_DAYS = 22;
const KV_SCORE_HISTORY = 'nasdaq-radar:score-history:v1';
const SERIES_DAYS = 360; // 复盘用日线序列
const KV_LIMIT_HISTORY = 'nasdaq-radar:limit-history:v1'; // 申购上限汇总 { etfs: { code: [[date, limit(-1=不设限)]] } }
const LIMIT_READ_DAYS = 30; // KV 单次调用有读次数上限：12 只 × 30 天 = 360 次

/**
 * 从 etf-shares 的 KV（FUND_LIMIT_KV，只读）读取近 N 个交易日的 PCF 申购上限。
 * 键：etf-pcf:{code}:{yyyymmdd}。缺绑定 / 读失败返回空，评分按「暂无额度数据」处理。
 */
export async function readLimitHistory(env, codes, dates) {
  const kv = env?.FUND_LIMIT_KV;
  const out = Object.fromEntries(codes.map((code) => [code, []]));
  if (!kv || typeof kv.get !== 'function') return out;
  const jobs = [];
  for (const code of codes) {
    for (const date of dates) {
      jobs.push([code, date, `etf-pcf:${code}:${date.replaceAll('-', '')}`]);
    }
  }
  const results = await Promise.all(jobs.map(async ([code, date, key]) => {
    try {
      const raw = await kv.get(key, 'json');
      return [code, date, raw ? effectiveSubscribeLimit(raw) : null];
    } catch {
      return [code, date, null];
    }
  }));
  for (const [code, date, limit] of results) {
    if (limit !== null) out[code].push({ date, limit });
  }
  for (const code of codes) out[code].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * 申购上限全历史：汇总键（回填一年 + 每日并入）+ 最近 LIMIT_READ_DAYS 天逐键读取（逐键优先），
 * 合并后写回汇总键。KV 单次调用读次数有限，所以长历史只能走汇总键。
 */
export async function readLimitHistoryAll(env, codes, dates) {
  let stored = null;
  try { stored = await env.NOTIFY_STATE.get(KV_LIMIT_HISTORY, 'json'); } catch { stored = null; }
  const merged = Object.fromEntries(codes.map((code) => [code, new Map(
    (stored?.etfs?.[code] || []).map(([date, limit]) => [date, limit === -1 ? Infinity : limit])
  )]));
  const recent = await readLimitHistory(env, codes, dates.slice(-LIMIT_READ_DAYS));
  for (const code of codes) for (const item of recent[code]) merged[code].set(item.date, item.limit);
  const out = {};
  const etfs = {};
  for (const code of codes) {
    const rows = [...merged[code].entries()].filter(([, limit]) => limit !== null && limit !== undefined)
      .sort((a, b) => a[0].localeCompare(b[0])).slice(-FEATURE_HISTORY_DAYS);
    out[code] = rows.map(([date, limit]) => ({ date, limit }));
    etfs[code] = rows.map(([date, limit]) => [date, limit === Infinity ? -1 : limit]);
  }
  try {
    await env.NOTIFY_STATE.put(KV_LIMIT_HISTORY, JSON.stringify({ updatedAt: new Date().toISOString(), etfs }));
  } catch (err) {
    console.log('[nasdaq-radar] limit history write failed:', err?.message || String(err));
  }
  return out;
}

/** 每日每只 ETF 的 [卖出分, 买入分]，供复盘按「当时的分数」分档统计胜率 */
export function compactScores(scoring) {
  const etfs = {};
  for (const [code, item] of Object.entries(scoring?.etfs || {})) etfs[code] = [item.sellScore, item.buyScore];
  return etfs;
}

async function upsertScoreHistory(env, today, scoring) {
  let history = [];
  try {
    const stored = await env.NOTIFY_STATE.get(KV_SCORE_HISTORY, 'json');
    if (Array.isArray(stored)) history = stored;
  } catch {
    history = [];
  }
  history = history.filter((item) => item?.date !== today);
  const entry = { date: today, version: scoring.version, etfs: compactScores(scoring) };
  // 纸面跟踪：记下当天的换基建议与平价换基信号（卖出/买入代码、两边溢价、分数），复盘时按后续溢价算收敛
  const paper = (pair, extra) => (pair ? { s: pair.sell.code, b: pair.buy.code, sp: pair.sell.premium, bp: pair.buy.premium, ...extra } : null);
  const rec = paper(scoring.recommendedPair, { score: scoring.recommendedPair?.score });
  const par = paper(scoring.parityPair, { edge: scoring.parityPair?.edge });
  if (rec) entry.pair = rec;
  if (par) entry.parity = par;
  history.push(entry);
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  history = history.slice(-FEATURE_HISTORY_DAYS);
  await env.NOTIFY_STATE.put(KV_SCORE_HISTORY, JSON.stringify(history));
  return history;
}

/** 复盘用的紧凑日线：收盘价、净值（计算溢价所用的最新净值）、溢价、当日申购上限 */
export function buildRadarSeries(featureHistory = [], limitHistory = {}, days = SERIES_DAYS, scoreHistory = []) {
  const rows = featureHistory.slice(-days);
  const dates = rows.map((day) => day.date);
  const scoresByDate = new Map((Array.isArray(scoreHistory) ? scoreHistory : []).map((item) => [item?.date, item?.etfs || {}]));
  const etfs = {};
  for (const meta of NASDAQ_ETFS) {
    const limits = new Map((limitHistory[meta.code] || []).map((item) => [item.date, item.limit]));
    etfs[meta.code] = {
      sell: rows.map((day) => scoresByDate.get(day.date)?.[meta.code]?.[0] ?? null),
      buy: rows.map((day) => scoresByDate.get(day.date)?.[meta.code]?.[1] ?? null),
      price: rows.map((day) => roundNumber(day?.etfs?.[meta.code]?.price, 4)),
      nav: rows.map((day) => roundNumber(day?.etfs?.[meta.code]?.latestNav, 4)),
      premium: rows.map((day) => roundNumber(day?.etfs?.[meta.code]?.premium, 3)),
      limit: rows.map((day) => {
        const v = limits.get(day.date);
        if (v === undefined || v === null) return null;
        return v === Infinity ? -1 : v; // -1 = 不设限
      }),
    };
  }
  return { dates, etfs };
}

function shanghaiDateStr(d = new Date()) {
  // 北京时间日期 YYYY-MM-DD
  const shanghai = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
  return shanghai.toISOString().slice(0, 10);
}

/**
 * 数据成熟度等级（基于 feature history 天数）
 * 1天=实验评分，10天=参考评分，20天=较稳定，30天+=完整评分
 */
function maturityLevel(days) {
  if (days >= 30) return { level: 5, label: '完整评分', dots: '●●●●●' };
  if (days >= 20) return { level: 4, label: '较稳定', dots: '●●●●○' };
  if (days >= 10) return { level: 3, label: '参考评分', dots: '●●●○○' };
  if (days >= 5) return { level: 2, label: '初步参考', dots: '●●○○○' };
  return { level: 1, label: '实验评分', dots: '●○○○○' };
}

/**
 * 根据成熟度返回启用的权重组
 */
function enabledWeightGroups(days) {
  const groups = {
    // 第1天即可用
    base: ['规模', '当前流动性', 'ADTV20', 'Amihud20', '当前Spread', 'TrackingDifference', 'TrackingError'],
    // 20天后启用
    premiumStats20: days >= 20 ? ['PremiumStd20', 'PremiumMAD20', 'PremiumIQR20'] : [],
    // 30天后启用
    liquidityStats30: days >= 30 ? ['MedianSpread30', 'DepthStability30'] : [],
  };
  return groups;
}

/**
 * 计算分位数：value 在 sorted 数组中的百分位 (0-100)
 */
function percentile(sorted, value) {
  if (!sorted.length) return 50;
  let count = 0;
  for (const v of sorted) {
    if (v <= value) count++;
  }
  return Math.round((count / sorted.length) * 100);
}

/**
 * 每日雷达计算（cron 调用）
 */
export async function computeNasdaqRadar(env, { force = false } = {}) {
  const today = shanghaiDateStr();

  // 法定节假日跳过：不写任何 KV，直接返回现有 latest（节假日无交易，写快照会污染 feature history）
  if (!force && isChinaMarketHoliday(today)) {
    console.log(`[nasdaq-radar] ${today} is China market holiday, skip computation`);
    try {
      const latest = await env.NOTIFY_STATE.get(KV_LATEST, 'json');
      if (latest) return latest;
    } catch {}
    return null;
  }

  // 读取历史价差（幂等保护与分位数计算共用）
  let history = [];
  try {
    const stored = await env.NOTIFY_STATE.get(KV_HISTORY, 'json');
    if (Array.isArray(stored)) history = stored;
  } catch {}

  // 数据源快照与雷达结果都完成后才直接复用；这样新版本上线当天也能补齐 feature history。
  const existingFeatureHistory = await readFeatureHistory(env);
  const radarComputedToday = history.some((item) => item?.date === today);
  const featuresCollectedToday = existingFeatureHistory.some((item) => item?.date === today);
  if (!force && radarComputedToday && featuresCollectedToday) {
    try {
      const latest = await env.NOTIFY_STATE.get(KV_LATEST, 'json');
      if (latest) {
        console.log(`[nasdaq-radar] already computed with features for ${today}, return existing latest`);
        return latest;
      }
    } catch {}
  }

  console.log(`[nasdaq-radar] computing for ${today}, force=${force}`);

  const codes = NASDAQ_ETFS.map(e => e.code);
  // 雷达专用数据源：东方财富 fundmob 收盘价 + 当日净值（21:35 当日净值已发布）
  let refs;
  try {
    refs = await fetchRadarPremiums(codes);
  } catch (err) {
    console.log('[nasdaq-radar] premium fetch failed:', err?.message || String(err));
    throw new Error('获取溢价数据失败: ' + (err?.message || String(err)));
  }
  console.log(`[nasdaq-radar] fetched ${Object.keys(refs).length} refs`);

  // 评分层暂不启用，先把流动性、盘口、规模与基准数据源完整采集并开始积累历史。
  const featureSnapshot = await collectRadarFeatureSnapshot(env, codes, refs);
  const featureHistory = await upsertFeatureHistory(env, today, featureSnapshot, existingFeatureHistory);

  // 提取溢价率：NAV口径 (收盘价 − 当日净值) / 当日净值 ×100
  const ranked = [];
  const skipped = [];
  for (const meta of NASDAQ_ETFS) {
    const ref = refs[meta.code];
    // Number.isFinite 不做 null→0 强转，缺失即跳过（finiteNumber 会把 null 变 0）
    const price = Number.isFinite(ref?.price) ? ref.price : null;
    const nav = Number.isFinite(ref?.latestNav) ? ref.latestNav : null;
    if (price === null || nav === null || price <= 0 || nav <= 0) { skipped.push(`${meta.code}:no-price-or-nav`); continue; }
    ranked.push({
      code: meta.code,
      name: ref?.name || meta.name,
      premium: ((price - nav) / nav) * 100,
      price,
    });
  }
  console.log(`[nasdaq-radar] ranked=${ranked.length}, skipped=[${skipped.join(',')}]`);

  if (ranked.length < 2) {
    throw new Error(`有效数据不足: 仅${ranked.length}只ETF有溢价数据 (跳过: ${skipped.join(',')})`);
  }

  ranked.sort((a, b) => b.premium - a.premium);
  const highest = ranked[0];
  const lowest = ranked[ranked.length - 1];
  const spread = +(highest.premium - lowest.premium).toFixed(4);

  // 计算分位数
  const spreads = history.filter((h) => h?.date && h.date < today).slice(-SPREAD_PERCENTILE_DAYS)
    .map(h => h.spread).filter(v => typeof v === 'number').sort((a, b) => a - b);
  const pct = percentile(spreads, spread);

  // 更新历史（同日覆盖，保留近 HISTORY_DAYS 天）
  history = history.filter((item) => item?.date !== today);
  history.push({ date: today, spread, high: highest.code, low: lowest.code });
  history = history.slice(-HISTORY_DAYS);

  const result = {
    date: today,
    computedAt: new Date().toISOString(),
    premiumSource: 'eastmoney-fundmobapi-nav',
    etfs: ranked.map(e => ({ code: e.code, name: e.name, premium: +e.premium.toFixed(2) })),
    bestPair: {
      sell: { code: highest.code, name: highest.name, premium: +highest.premium.toFixed(2) },
      buy: { code: lowest.code, name: lowest.name, premium: +lowest.premium.toFixed(2) },
      spread,
      percentile: pct,
      historyDays: spreads.length,
    },
    // 近期机会（历史价差前3）
    recentOpportunities: history
      .slice(-5)
      .reverse()
      .map(h => ({ date: h.date, pair: `${h.high} → ${h.low}`, spread: h.spread })),
    dataCoverage: {
      featureHistoryDays: featureHistory.length,
      maxFeatureHistoryDays: FEATURE_HISTORY_DAYS,
      benchmarkSymbols: featureSnapshot.references,
      sources: featureSnapshot.sources,
      featureCompleteness: {
        total: codes.length,
        premium: codes.filter((code) => Number.isFinite(featureSnapshot.etfs?.[code]?.premium)).length,
        turnover: codes.filter((code) => Number.isFinite(featureSnapshot.etfs?.[code]?.turnover)).length,
        marketCapital: codes.filter((code) => Number.isFinite(featureSnapshot.etfs?.[code]?.marketCapital)).length,
        totalShares: codes.filter((code) => Number.isFinite(featureSnapshot.etfs?.[code]?.totalShares)).length,
        spread: codes.filter((code) => Number.isFinite(featureSnapshot.etfs?.[code]?.bidAskSpreadBps)).length,
        depth5: codes.filter((code) => Number.isFinite(featureSnapshot.etfs?.[code]?.depth5)).length,
      },
    },
    // 数据成熟度：评分权重据此自动启用
    maturity: {
      days: featureHistory.length,
      ...maturityLevel(featureHistory.length),
      enabledWeights: enabledWeightGroups(featureHistory.length),
    },
  };

  // 评分 v2（影子运行，只展示不通知）：失败不影响主快照。
  try {
    const limitDates = [...new Set([...featureHistory.map((day) => day.date), today])].sort();
    const limitHistory = await readLimitHistoryAll(env, codes, limitDates);
    const recentLimits = Object.fromEntries(codes.map((code) => [code, limitHistory[code].filter((item) => limitDates.slice(-LIMIT_LOOKBACK_DAYS).includes(item.date))]));
    result.scoring = scoreRadar({
      etfs: featureSnapshot.etfs,
      featureHistory,
      limitHistory: recentLimits,
      spreadHistory: spreads,
      date: today,
    });
    result.scoring.quotaDate = today;
    const scoreHistory = await upsertScoreHistory(env, today, result.scoring);
    result.series = buildRadarSeries(featureHistory, limitHistory, SERIES_DAYS, scoreHistory);
    result.dataCoverage.featureCompleteness.quota = codes.filter((code) => result.scoring.etfs?.[code]?.quota?.state && result.scoring.etfs[code].quota.state !== 'unknown').length;
  } catch (err) {
    console.log('[nasdaq-radar] scoring failed:', err?.message || String(err));
    result.scoringError = err?.message || String(err);
  }

  await env.NOTIFY_STATE.put(KV_LATEST, JSON.stringify(result));
  await env.NOTIFY_STATE.put(KV_HISTORY, JSON.stringify(history));

  console.log(`[nasdaq-radar] done: ${highest.code}(${highest.premium}%) → ${lowest.code}(${lowest.premium}%), spread=${spread}%, p${pct}`);
  return result;
}

/**
 * 早盘份额刷新：交易所 PCF 在交易日早上发布当天的申购上限，而雷达快照是上一交易日 21:35 算的。
 * 当天 PCF 到齐（≥ 半数）后，用「上一交易日收盘溢价 + 当天申购上限」重算评分，写回 latest.scoring
 * 并标 quotaDate = 今天；评分历史同日覆盖（复盘按交易当日实际看到的分数统计）。每天只成功一次。
 */
export async function refreshRadarQuota(env, { today = shanghaiDateStr() } = {}) {
  if (isChinaMarketHoliday(today)) return { skipped: 'holiday' };
  let latest = null;
  try { latest = await env.NOTIFY_STATE.get(KV_LATEST, 'json'); } catch { latest = null; }
  if (!latest?.scoring || !latest.date || today <= latest.date) return { skipped: 'snapshot-is-today' };
  if (String(latest.scoring.quotaDate || latest.date) >= today) return { skipped: 'already-refreshed' };
  const codes = NASDAQ_ETFS.map((meta) => meta.code);
  // 先只探测今天的 12 个键，PCF 没到齐就不做全量读取
  const probe = await readLimitHistory(env, codes, [today]);
  const ready = codes.filter((code) => probe[code].length).length;
  if (ready < Math.ceil(codes.length / 2)) return { skipped: 'pcf-pending', ready };

  const featureHistory = (await readFeatureHistory(env)).filter((day) => day?.date && day.date <= latest.date);
  const snap = featureHistory.find((day) => day.date === latest.date);
  if (!snap?.etfs) return { skipped: 'no-feature-snapshot' };
  const limitDates = [...new Set([...featureHistory.map((day) => day.date), today])].sort().slice(-LIMIT_READ_DAYS);
  const limitHistory = await readLimitHistory(env, codes, limitDates.filter((date) => date !== today));
  for (const code of codes) limitHistory[code].push(...probe[code]);
  const lookback = new Set(limitDates.slice(-LIMIT_LOOKBACK_DAYS));
  const recentLimits = Object.fromEntries(codes.map((code) => [code, limitHistory[code].filter((item) => lookback.has(item.date))]));
  let history = [];
  try {
    const stored = await env.NOTIFY_STATE.get(KV_HISTORY, 'json');
    if (Array.isArray(stored)) history = stored;
  } catch { history = []; }
  const spreads = history.filter((h) => h?.date && h.date < latest.date).slice(-SPREAD_PERCENTILE_DAYS).map((h) => h.spread).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const scoring = scoreRadar({ etfs: snap.etfs, featureHistory, limitHistory: recentLimits, spreadHistory: spreads, date: latest.date });
  scoring.quotaDate = today;
  scoring.quotaRefreshedAt = new Date().toISOString();
  const next = { ...latest, scoring };
  if (next.dataCoverage?.featureCompleteness) {
    next.dataCoverage.featureCompleteness.quota = codes.filter((code) => scoring.etfs?.[code]?.quota?.state && scoring.etfs[code].quota.state !== 'unknown').length;
  }
  await upsertScoreHistory(env, latest.date, scoring);
  await env.NOTIFY_STATE.put(KV_LATEST, JSON.stringify(next));
  console.log(`[nasdaq-radar] quota refreshed for ${today} (premium ${latest.date}), pcf ready ${ready}/${codes.length}`);
  return { refreshed: true, quotaDate: today, ready };
}

/**
 * 获取雷达数据（API 调用）
 */
export async function getNasdaqRadar(env) {
  try {
    const data = await env.NOTIFY_STATE.get(KV_LATEST, 'json');
    return data || null;
  } catch {
    return null;
  }
}

export async function getNasdaqRadarFeatureHistory(env) {
  return readFeatureHistory(env);
}
