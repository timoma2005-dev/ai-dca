/**
 * 实盘切换复盘（纯函数）。
 *
 * 一次切换 = 账户流水里用 switchPairId 配对的 SELL(A) + BUY(B)，只看雷达池内 12 只纳指 ETF。
 * 一轮持有从买入 B 开始，到下一次把 B 切出（或至今）结束。
 *
 * 核心口径（换了比不换多赚多少）：
 *   相对收益 = (B 期末价 / B 买入价) ÷ (A 期末价 / A 卖出价) − 1 − 估算佣金
 * 归因（百分点）：卖出方溢价变化 + 买入方溢价变化 + 净值/汇率差 − 成本 = 相对收益；
 * 另列「执行损耗」= 成交时的实际溢价差 − 前一晚雷达信号价差（不计入恒等式，单独看执行好坏）。
 * 价格/净值/溢价/申购上限都来自雷达快照 data.series（收盘口径，净值为当晚已披露的最新净值）。
 */

import { ETF_SHORT_NAMES } from './radarScoreModel.js';

export const COMMISSION_PCT_PER_SIDE = 0.01; // 单边佣金估算（%）
const MIN_GAIN_FOR_TOO_LONG = 0.5; // 期间最高相对收益比期末多 ≥0.5pp 视为持有过久

const POOL = new Set(Object.keys(ETF_SHORT_NAMES));

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clip01(x) {
  return Math.max(0, Math.min(1, x));
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** 从流水里找出池内 ETF 的切换（SELL.switchPairId → BUY.id，或两边共用同一 switchPairId） */
export function extractSwitches(transactions = []) {
  const txs = Array.isArray(transactions) ? transactions.filter((tx) => tx && typeof tx === 'object') : [];
  const byId = new Map(txs.filter((tx) => tx.id).map((tx) => [String(tx.id), tx]));
  const seen = new Set();
  const out = [];
  for (const sell of txs) {
    if (sell.type !== 'SELL' || !sell.switchPairId) continue;
    const pid = String(sell.switchPairId);
    let buy = byId.get(pid);
    if (!buy || buy.type !== 'BUY') {
      buy = txs.find((tx) => tx.type === 'BUY' && String(tx.switchPairId || '') === pid && String(tx.code) !== String(sell.code));
    }
    if (!buy || String(buy.code) === String(sell.code)) continue;
    const sellCode = String(sell.code); const buyCode = String(buy.code);
    if (!POOL.has(sellCode) || !POOL.has(buyCode)) continue;
    const key = `${sell.id || ''}|${buy.id || ''}|${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sp = num(sell.price); const bp = num(buy.price);
    if (!(sp > 0) || !(bp > 0)) continue;
    out.push({
      id: String(sell.id || pid),
      date: String(buy.date || sell.date || '').slice(0, 10),
      sell: { code: sellCode, price: sp, shares: num(sell.shares), date: String(sell.date || '').slice(0, 10) },
      buy: { code: buyCode, price: bp, shares: num(buy.shares), date: String(buy.date || '').slice(0, 10) },
      fee: (num(sell.fee) || 0) + (num(buy.fee) || 0),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return out;
}

function seriesIndex(series, date, { strictBefore = false } = {}) {
  const dates = Array.isArray(series?.dates) ? series.dates : [];
  let idx = -1;
  for (let i = 0; i < dates.length; i += 1) {
    if (strictBefore ? dates[i] < date : dates[i] <= date) idx = i;
    else break;
  }
  return idx;
}

function seriesValue(series, code, field, idx) {
  if (idx < 0) return null;
  const arr = series?.etfs?.[code]?.[field];
  return Array.isArray(arr) ? num(arr[idx]) : null;
}

/** 持有期间的份额事件：买入方放大 ≥2 倍 / 不设限，或卖出方收紧 ≥2 倍 */
function quotaEventsBetween(series, sellCode, buyCode, fromIdx, toIdx) {
  const events = [];
  const scan = (code, kind) => {
    const arr = series?.etfs?.[code]?.limit || [];
    for (let i = Math.max(1, fromIdx + 1); i <= toIdx; i += 1) {
      const a = arr[i]; const b = arr[i - 1];
      if (a == null || b == null) continue;
      const A = a < 0 ? Infinity : a; const B = b < 0 ? Infinity : b;
      if (kind === 'relax' && A > B && A >= B * 2) events.push({ code, kind, date: series.dates[i], from: b, to: a });
      if (kind === 'tight' && A < B && A <= B / 2) events.push({ code, kind, date: series.dates[i], from: b, to: a });
    }
  };
  scan(buyCode, 'relax');
  scan(sellCode, 'tight');
  return events;
}

const REASONS = {
  quota: '份额事件反向',
  converge: '价差未收敛或扩大',
  exec: '执行损耗',
  cost: '成本吞噬',
  nav: '净值/汇率口径差',
  long: '持有过久',
};

/** 把切换串成持有轮次并计算收益与归因 */
export function buildRounds(switches = [], series = null) {
  const lastIdx = (series?.dates?.length || 0) - 1;
  return switches.map((sw, index) => {
    const next = switches.slice(index + 1).find((later) => later.sell.code === sw.buy.code && later.date >= sw.date);
    const A = sw.sell.code; const B = sw.buy.code;
    const startIdx = seriesIndex(series, sw.date);
    const signalIdx = seriesIndex(series, sw.date, { strictBefore: true });
    const endDate = next ? next.date : series?.dates?.[lastIdx] || '';
    const endIdx = next ? seriesIndex(series, next.date) : lastIdx;
    const base = {
      id: sw.id,
      date: sw.date,
      sell: { ...sw.sell, short: ETF_SHORT_NAMES[A] || A },
      buy: { ...sw.buy, short: ETF_SHORT_NAMES[B] || B },
      open: !next,
      endDate,
      holdDays: endIdx >= startIdx && startIdx >= 0 ? endIdx - startIdx : null,
    };
    const aEnd = next ? seriesValue(series, A, 'price', endIdx) : seriesValue(series, A, 'price', lastIdx);
    const bEnd = next ? next.sell.price : seriesValue(series, B, 'price', lastIdx);
    if (startIdx < 0 || !(aEnd > 0) || !(bEnd > 0)) {
      return { ...base, status: 'insufficient', note: '雷达日线不覆盖这次切换（早于雷达数据起点），暂不能复盘' };
    }

    const gross = ((bEnd / sw.buy.price) / (aEnd / sw.sell.price) - 1) * 100;
    const feePct = sw.fee > 0 && sw.sell.shares > 0 ? (sw.fee / (sw.sell.price * sw.sell.shares)) * 100 : null;
    // 只计这次切换的双边佣金；下一次切出的成本算到下一轮
    const cost = feePct != null ? feePct : COMMISSION_PCT_PER_SIDE * 2;
    const net = gross - cost;

    const navA0 = seriesValue(series, A, 'nav', startIdx); const navB0 = seriesValue(series, B, 'nav', startIdx);
    const navA1 = seriesValue(series, A, 'nav', endIdx); const navB1 = seriesValue(series, B, 'nav', endIdx);
    const pA0 = navA0 > 0 ? (sw.sell.price / navA0 - 1) * 100 : null;
    const pB0 = navB0 > 0 ? (sw.buy.price / navB0 - 1) * 100 : null;
    const pA1 = navA1 > 0 ? (aEnd / navA1 - 1) * 100 : null;
    const pB1 = navB1 > 0 ? (bEnd / navB1 - 1) * 100 : null;
    const sellPrem = pA0 != null && pA1 != null ? pA0 - pA1 : null;
    const buyPrem = pB0 != null && pB1 != null ? pB1 - pB0 : null;
    const navPart = sellPrem != null && buyPrem != null ? gross - sellPrem - buyPrem : null;

    const sigA = seriesValue(series, A, 'premium', signalIdx); const sigB = seriesValue(series, B, 'premium', signalIdx);
    const signalSpread = sigA != null && sigB != null ? sigA - sigB : null;
    const execSpread = pA0 != null && pB0 != null ? pA0 - pB0 : null;
    const execLoss = signalSpread != null && execSpread != null ? execSpread - signalSpread : null;
    const sellScore = seriesValue(series, A, 'sell', signalIdx);
    const buyScore = seriesValue(series, B, 'buy', signalIdx);
    const signalScore = signalSpread != null && sellScore != null && buyScore != null
      ? Math.round(0.45 * clip01(signalSpread / 4) * 100 + 0.30 * sellScore + 0.25 * buyScore)
      : null;

    // 持有路径：每日相对收益，用于「持有过久」
    const path = [];
    for (let i = startIdx; i <= endIdx; i += 1) {
      const a = seriesValue(series, A, 'price', i); const b = seriesValue(series, B, 'price', i);
      if (a > 0 && b > 0) path.push({ date: series.dates[i], rel: round(((b / sw.buy.price) / (a / sw.sell.price) - 1) * 100 - cost, 2) });
    }
    if (path.length) path[path.length - 1] = { date: endDate, rel: round(net, 2) };
    const peak = path.reduce((best, p) => (p.rel > (best?.rel ?? -Infinity) ? p : best), null);

    const events = quotaEventsBetween(series, A, B, startIdx, endIdx);
    const parts = [
      { key: 'exec', label: '执行损耗', value: execLoss, context: true },
      { key: 'sell', label: '卖出方溢价变化', value: sellPrem },
      { key: 'buy', label: '买入方溢价变化', value: buyPrem },
      { key: 'nav', label: '净值 / 汇率差', value: navPart },
      { key: 'cost', label: '佣金与成本', value: -cost },
    ].map((p) => ({ ...p, value: round(p.value, 2) }));

    let reason = null;
    if (net <= 0) {
      const adverse = events.length > 0;
      const cands = [
        { key: 'quota', v: adverse ? Math.min(sellPrem ?? 0, 0) + Math.min(buyPrem ?? 0, 0) : 0 },
        { key: 'converge', v: !adverse ? Math.min((sellPrem ?? 0) + (buyPrem ?? 0), 0) : 0 },
        { key: 'exec', v: Math.min(execLoss ?? 0, 0) },
        { key: 'nav', v: Math.min(navPart ?? 0, 0) },
        { key: 'cost', v: signalSpread != null && signalSpread < cost * 2 ? -cost : 0 },
      ].filter((c) => c.v < 0).sort((x, y) => x.v - y.v);
      if (peak && peak.rel - net >= MIN_GAIN_FOR_TOO_LONG && peak.rel > 0 && peak.date !== endDate) {
        reason = { key: 'long', label: REASONS.long, detail: `${peak.date.slice(5)} 曾领先 ${peak.rel.toFixed(2)}pp，之后回吐` };
      } else if (cands.length) {
        const top = cands[0];
        let detail = '';
        if (top.key === 'quota') {
          detail = events.map((e) => `${ETF_SHORT_NAMES[e.code] || e.code} ${e.date.slice(5)} ${e.kind === 'relax' ? '放开额度' : '收紧额度'}`).join('，');
        } else if (top.key === 'exec') detail = `信号价差 ${signalSpread?.toFixed(2)}pp，成交时只剩 ${execSpread?.toFixed(2)}pp`;
        else if (top.key === 'converge') detail = '期间没有份额事件，两边溢价差没有收敛';
        else if (top.key === 'cost') detail = `信号价差 ${signalSpread?.toFixed(2)}pp 不够覆盖双边成本`;
        else if (top.key === 'nav') detail = '两只基金净值或汇率口径不同步';
        reason = { key: top.key, label: REASONS[top.key], detail };
      }
    }

    return {
      ...base,
      status: 'ok',
      aEnd: round(aEnd, 4),
      bEnd: round(bEnd, 4),
      grossPct: round(gross, 2),
      costPct: round(cost, 3),
      netPct: round(net, 2),
      extraYuan: sw.sell.shares > 0 && sw.buy.shares > 0 ? Math.round(bEnd * sw.buy.shares - aEnd * sw.sell.shares - (sw.buy.price * sw.buy.shares - sw.sell.price * sw.sell.shares)) : null,
      signalSpread: round(signalSpread, 2),
      execSpread: round(execSpread, 2),
      signalScore,
      realization: signalSpread > 0 ? round(net / signalSpread, 2) : null,
      parts,
      events,
      path,
      reason,
    };
  });
}

export function summarizeRounds(rounds = []) {
  const ok = rounds.filter((r) => r.status === 'ok');
  const wins = ok.filter((r) => r.netPct > 0);
  const sumNet = ok.reduce((s, r) => s + r.netPct, 0);
  const sumSignal = ok.reduce((s, r) => s + (r.signalSpread > 0 ? r.signalSpread : 0), 0);
  const reasonCounts = {};
  for (const r of ok) if (r.reason) reasonCounts[r.reason.label] = (reasonCounts[r.reason.label] || 0) + 1;
  const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0] || null;
  const buckets = [
    { label: '≥ 85', min: 85, max: Infinity },
    { label: '70–84', min: 70, max: 85 },
    { label: '55–69', min: 55, max: 70 },
    { label: '< 55', min: -Infinity, max: 55 },
  ].map((b) => {
    const rs = ok.filter((r) => r.signalScore != null && r.signalScore >= b.min && r.signalScore < b.max);
    return {
      label: b.label,
      count: rs.length,
      winRate: rs.length ? round(rs.filter((r) => r.netPct > 0).length / rs.length, 2) : null,
      avgNet: rs.length ? round(rs.reduce((s, r) => s + r.netPct, 0) / rs.length, 2) : null,
    };
  });
  return {
    total: rounds.length,
    reviewed: ok.length,
    open: ok.filter((r) => r.open).length,
    winRate: ok.length ? round(wins.length / ok.length, 2) : null,
    avgNet: ok.length ? round(sumNet / ok.length, 2) : null,
    realization: sumSignal > 0 ? round(sumNet / sumSignal, 2) : null,
    extraYuan: ok.reduce((s, r) => s + (r.extraYuan || 0), 0),
    topReason: topReason ? { label: topReason[0], count: topReason[1] } : null,
    buckets,
  };
}

export function reviewFromLedger(transactions, data) {
  const rounds = buildRounds(extractSwitches(transactions), data?.series || null).reverse();
  return { rounds, summary: summarizeRounds(rounds) };
}
