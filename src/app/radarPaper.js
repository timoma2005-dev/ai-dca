/**
 * 纸面记录（纯函数）：把雷达每天给出的换基建议当作「如果照做」的模拟切换，统计切换收益与胜率。
 *
 * 数据：快照 data.series.paper（Worker buildRadarSeries 生成，与 series.dates 对齐）
 *   pair[i]   = [卖出代码, 买入代码, 换基分] 主换基建议
 *   parity[i] = [卖出代码, 买入代码, 分数差] 平价换基（溢价差 ≤0.5pp）
 *   backfill[i] = 1 表示上线前用当时数据回算，0 表示当天实时给出
 *
 * 口径（保守）：信号在 T 日 21:35 收盘后算出，T+1 收盘成交，持有 k 个交易日后在 T+1+k 收盘比较。
 *   切换收益 = (买入方 期末价 / 成交价) ÷ (卖出方 期末价 / 成交价) − 1 − 交易成本
 *   即「换了比不换多赚多少」。交易成本默认 0.15%（两边点差 + 佣金的保守估计）。
 *   另列溢价收敛 = 买入方溢价变化 − 卖出方溢价变化（pp），用来区分是溢价收敛还是净值差带来的。
 */

import { shortName } from './radarScoreModel.js';

export const PAPER_COST_PCT = 0.15;
export const PAPER_HOLD_DAYS = Object.freeze([1, 5, 10]);
export const PAPER_KINDS = Object.freeze({ pair: '主建议', parity: '平价换基' });

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function hasPaper(data) {
  const s = data?.series;
  return Boolean(Array.isArray(s?.dates) && s?.paper && (Array.isArray(s.paper.pair) || Array.isArray(s.paper.parity)));
}

/**
 * 逐条记录。
 * @param {object} data 雷达快照
 * @param {object} opts { kind: 'pair'|'parity', hold: 天数, dedupe: 同一建议连续出现只记首日, cost: % }
 */
export function paperRecords(data, { kind = 'pair', hold = 5, dedupe = true, cost = PAPER_COST_PCT } = {}) {
  if (!hasPaper(data)) return [];
  const { dates, etfs, paper } = data.series;
  const sigs = Array.isArray(paper[kind]) ? paper[kind] : [];
  const backfill = Array.isArray(paper.backfill) ? paper.backfill : [];
  const px = (code, i) => num(etfs?.[code]?.price?.[i]);
  const pm = (code, i) => num(etfs?.[code]?.premium?.[i]);
  const out = [];
  let prevKey = '';
  for (let i = 0; i < dates.length; i += 1) {
    const sig = sigs[i];
    if (!Array.isArray(sig) || !sig[0] || !sig[1]) {
      prevKey = '';
      continue;
    }
    const [sell, buy, score] = sig;
    const key = `${sell}>${buy}`;
    const repeat = key === prevKey;
    prevKey = key;
    if (dedupe && repeat) continue;
    const e = i + 1; // T+1 收盘成交
    const x = e + hold;
    const rec = {
      date: dates[i],
      kind,
      sell: { code: String(sell), short: shortName(sell), premium: pm(sell, i) },
      buy: { code: String(buy), short: shortName(buy), premium: pm(buy, i) },
      spread: round((pm(sell, i) ?? NaN) - (pm(buy, i) ?? NaN), 2),
      score: num(score),
      backfill: backfill[i] === 1,
      entryDate: dates[e] || null,
      exitDate: dates[x] || null,
      ret: null,
      convergence: null,
      status: 'pending',
    };
    if (x < dates.length) {
      const s0 = px(sell, e); const s1 = px(sell, x); const b0 = px(buy, e); const b1 = px(buy, x);
      if (s0 > 0 && s1 > 0 && b0 > 0 && b1 > 0) {
        rec.ret = round(((b1 / b0) / (s1 / s0) - 1) * 100 - cost, 3);
        const ps0 = pm(sell, e); const ps1 = pm(sell, x); const pb0 = pm(buy, e); const pb1 = pm(buy, x);
        if ([ps0, ps1, pb0, pb1].every((v) => v !== null)) rec.convergence = round((pb1 - pb0) - (ps1 - ps0), 3);
        rec.status = 'done';
      } else {
        rec.status = 'nodata';
      }
    }
    out.push(rec);
  }
  return out;
}

/** 汇总：笔数、胜率、平均 / 中位收益、累计（逐笔相加）、进行中笔数 */
export function paperStats(records = []) {
  const done = records.filter((r) => r.status === 'done' && Number.isFinite(r.ret));
  const rets = done.map((r) => r.ret).sort((a, b) => a - b);
  const n = rets.length;
  const sum = rets.reduce((a, b) => a + b, 0);
  const conv = done.map((r) => r.convergence).filter(Number.isFinite);
  return {
    total: records.length,
    done: n,
    pending: records.filter((r) => r.status === 'pending').length,
    winRate: n ? round((rets.filter((v) => v > 0).length / n) * 100, 0) : null,
    avgRet: n ? round(sum / n, 3) : null,
    medianRet: n ? round(n % 2 ? rets[(n - 1) / 2] : (rets[n / 2 - 1] + rets[n / 2]) / 2, 3) : null,
    sumRet: n ? round(sum, 2) : null,
    best: n ? rets[n - 1] : null,
    worst: n ? rets[0] : null,
    avgConvergence: conv.length ? round(conv.reduce((a, b) => a + b, 0) / conv.length, 3) : null,
  };
}

/** 按来源拆分：回算 / 实时 / 全部 */
export function paperSummary(data, opts = {}) {
  const records = paperRecords(data, opts);
  return {
    records,
    all: paperStats(records),
    live: paperStats(records.filter((r) => !r.backfill)),
    backfill: paperStats(records.filter((r) => r.backfill)),
  };
}
