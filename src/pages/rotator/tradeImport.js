import { minuteLabel } from './rotatorCharts.js';

// 券商成交截图（OCR 出来的 rows）→ 一串换车：同一只连续成交合并，卖一只配买一只；
// 截图里的名字（「纳指」「纳斯达克」）对不上代码，用当天每分钟价格区间去对；没有成交时间时顺便估一个时间。
const SIDE = { 买入: 'buy', 买: 'buy', buy: 'buy', 卖出: 'sell', 卖: 'sell', sell: 'sell' };
const TOL = 0.0015;
const MINUTES = 241;
const isCode = (s) => /^\d{6}$/.test(s);

// 和 tradingMinute 一样的分钟轴（上海无夏令时，直接 +8h），逐点调用 Intl 太慢
function minuteOf(ts) {
  const v = Math.floor((((ts + 8 * 3600) % 86400) + 86400) % 86400 / 60);
  return v <= 690 ? Math.max(0, v - 570) : v < 780 ? 120 : Math.min(240, 120 + v - 780);
}

export function normalizeTrades(rows) {
  return (rows || []).map((r, i) => {
    const d = String(r?.date || '');
    const tm = d.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const dm = d.match(/20\d{2}-\d{2}-\d{2}/);
    const price = Number(r?.price);
    const shares = Number(r?.shares);
    return {
      i,
      name: String(r?.code || r?.name || '').trim(),
      side: SIDE[String(r?.type || '').trim().toLowerCase()] || SIDE[String(r?.type || '').trim()],
      price,
      shares,
      amount: Number(r?.amount) > 0 ? Number(r.amount) : price * shares,
      time: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}:${tm[3] || '00'}` : '',
      day: dm ? dm[0] : ''
    };
  }).filter((t) => t.side && t.name && t.price > 0 && t.shares > 0);
}

function mergeFills(list) {
  const out = [];
  for (const t of list) {
    const p = out[out.length - 1];
    if (p && p.side === t.side && p.name === t.name) {
      p.shares += t.shares;
      p.amount += t.amount;
      p.price = Math.round((p.amount / p.shares) * 1e4) / 1e4;
      p.fills += 1;
    } else out.push({ ...t, fills: 1 });
  }
  return out;
}

function pairLegs(trades, timed, warnings) {
  if (timed) {
    const list = mergeFills(trades.slice().sort((a, b) => a.time.localeCompare(b.time) || a.i - b.i));
    const legs = [];
    for (let k = 0; k < list.length; k += 1) {
      const a = list[k];
      const b = list[k + 1];
      if (b && a.side !== b.side) {
        legs.push(a.side === 'sell' ? { sell: a, buy: b, time: a.time } : { sell: b, buy: a, time: a.time });
        k += 1;
      } else warnings.push(`${a.time} ${a.side === 'sell' ? '卖出' : '买入'} ${a.name} 没有配对的另一边，已跳过`);
    }
    return legs;
  }
  const list = mergeFills(trades);
  const sells = list.filter((t) => t.side === 'sell');
  const buys = list.filter((t) => t.side === 'buy');
  const pairs = sells.flatMap((s) => buys.map((b) => ({ s, b, d: Math.abs(s.amount - b.amount) / s.amount })))
    .sort((x, y) => x.d - y.d);
  const used = new Set();
  const legs = [];
  for (const { s, b } of pairs) {
    if (used.has(s) || used.has(b) || s.name === b.name) continue;
    used.add(s); used.add(b);
    legs.push({ sell: s, buy: b, time: '' });
  }
  for (const t of list) if (!used.has(t)) warnings.push(`${t.side === 'sell' ? '卖出' : '买入'} ${t.name} 没有配对的另一边，已跳过`);
  // 顺序：上一次买入的就是下一次卖出的；接不上时按券商列表「新的在上」倒过来
  const byIdx = legs.slice().sort((x, y) => Math.max(y.sell.i, y.buy.i) - Math.max(x.sell.i, x.buy.i));
  const head = byIdx.find((l) => !legs.some((o) => o !== l && o.buy.name === l.sell.name)) || byIdx[0];
  const chain = head ? [head] : [];
  while (chain.length < legs.length) {
    const next = legs.find((l) => !chain.includes(l) && l.sell.name === chain[chain.length - 1].buy.name);
    if (!next) break;
    chain.push(next);
  }
  return chain.length === legs.length ? chain : byIdx;
}

export function minuteRanges(series) {
  const out = new Array(MINUTES).fill(null);
  for (const [ts, px] of series || []) {
    const m = Math.min(MINUTES - 1, minuteOf(ts));
    const r = out[m];
    out[m] = r ? [Math.min(r[0], px), Math.max(r[1], px)] : [px, px];
  }
  let last = null;
  for (let m = 0; m < MINUTES; m += 1) {
    if (out[m]) last = out[m];
    else if (last) out[m] = [last[1], last[1]];
  }
  return out;
}

function miss(r, px) {
  if (!r) return 50;
  const d = px < r[0] ? r[0] - px : px > r[1] ? px - r[1] : 0;
  return (Math.max(0, d - TOL) / px) * 1e4;
}

function timeWindow(time) {
  if (!time) return null;
  const [h, mi] = time.split(':').map(Number);
  const v = h * 60 + mi;
  const m = v <= 690 ? Math.max(0, v - 570) : v < 780 ? 120 : Math.min(240, 120 + v - 780);
  return [Math.max(0, m - 1), Math.min(MINUTES - 1, m + 1)];
}

// 每次换车选一个分钟（严格递增），让卖价、买价都落在那一分钟的价格区间里
function fitTimes(legs, codesOf, R) {
  const cost = legs.map((l, i) => {
    const [cs, cb] = codesOf(i);
    const w = timeWindow(l.time);
    return Array.from({ length: MINUTES }, (_, m) => (w && (m < w[0] || m > w[1]) ? Infinity : miss(R[cs]?.[m], l.sell.price) + miss(R[cb]?.[m], l.buy.price)));
  });
  const dp = cost.map(() => new Array(MINUTES).fill(Infinity));
  const from = cost.map(() => new Array(MINUTES).fill(-1));
  for (let m = 0; m < MINUTES; m += 1) dp[0][m] = cost[0][m];
  for (let i = 1; i < legs.length; i += 1) {
    let best = Infinity;
    let arg = -1;
    for (let m = 0; m < MINUTES; m += 1) {
      if (m > 0 && dp[i - 1][m - 1] < best) { best = dp[i - 1][m - 1]; arg = m - 1; }
      dp[i][m] = best + cost[i][m];
      from[i][m] = arg;
    }
  }
  const lastRow = dp[legs.length - 1];
  let end = 0;
  for (let m = 1; m < MINUTES; m += 1) if (lastRow[m] < lastRow[end]) end = m;
  const mins = new Array(legs.length);
  for (let i = legs.length - 1, m = end; i >= 0; i -= 1) { mins[i] = m; m = from[i][m]; }
  return { total: lastRow[end], mins };
}

export function planImport({ rows, pool, seriesByCode, fixed = {} }) {
  const warnings = [];
  const trades = normalizeTrades(rows);
  if (!trades.length) return { error: '截图里没认出买入/卖出成交' };
  const timed = trades.every((t) => t.time);
  const legs = pairLegs(trades, timed, warnings);
  if (!legs.length) return { error: '没有能配成「卖一只买一只」的成交', warnings };

  const holds = [legs[0].sell.name, ...legs.map((l) => l.buy.name)];
  legs.forEach((l, i) => {
    if (i && l.sell.name !== legs[i - 1].buy.name) warnings.push(`第 ${i + 1} 次卖的是 ${l.sell.name}，上一次买的是 ${legs[i - 1].buy.name}，按卖出当时持仓算`);
    if (i && Math.abs(l.sell.shares - legs[i - 1].buy.shares) > 0.5) warnings.push(`第 ${i + 1} 次卖出 ${l.sell.shares} 份，和上次买入 ${legs[i - 1].buy.shares} 份不一致，按全部卖出算`);
  });

  const codes = (pool || []).map((r) => r.code);
  const R = Object.fromEntries(codes.map((c) => [c, minuteRanges(seriesByCode?.[c])]));
  const names = [...new Set(holds)];
  const pricesOf = (n) => legs.flatMap((l) => [l.sell.name === n ? l.sell.price : null, l.buy.name === n ? l.buy.price : null]).filter(Boolean);
  const candidates = Object.fromEntries(names.map((n) => {
    if (fixed[n] && codes.includes(fixed[n])) return [n, [fixed[n]]];
    if (isCode(n) && codes.includes(n)) return [n, [n]];
    const fit = codes.map((c) => ({ c, d: pricesOf(n).reduce((s, px) => s + Math.min(...R[c].map((r) => miss(r, px))), 0) })).sort((a, b) => a.d - b.d);
    const ok = fit.filter((f) => f.d === 0).map((f) => f.c);
    return [n, ok.length ? ok : fit.slice(0, 3).map((f) => f.c)];
  }));

  const combos = [];
  const pick = (k, chosen) => {
    if (combos.length > 5000) return;
    if (k === names.length) {
      const codeOf = (n) => chosen[names.indexOf(n)];
      const fitted = fitTimes(legs, (i) => [codeOf(holds[i]), codeOf(holds[i + 1])], R);
      combos.push({ chosen: chosen.slice(), ...fitted });
      return;
    }
    for (const c of candidates[names[k]]) if (!chosen.includes(c)) pick(k + 1, [...chosen, c]);
  };
  pick(0, []);
  if (!combos.length) return { error: '截图里的基金对不上轮动池', warnings };
  combos.sort((a, b) => a.total - b.total);
  const best = combos[0];
  const codeOf = (n) => best.chosen[names.indexOf(n)];
  const near = combos.filter((c) => c.total <= best.total + 0.5);
  const nameMap = names.map((n, k) => ({ name: n, code: best.chosen[k], alts: [...new Set(near.map((c) => c.chosen[k]))], fixed: Boolean(fixed[n]) }));
  if (best.total > 1) warnings.push('有成交价不在当天对应基金的价格范围里，请核对代码');

  return {
    day: trades.find((t) => t.day)?.day || '',
    timed,
    names: nameMap,
    startCode: codeOf(holds[0]),
    startShares: legs[0].sell.shares,
    switches: legs.map((l, i) => ({
      time: l.time || `${minuteLabel(best.mins[i])}:30`,
      est: !l.time,
      buyCode: codeOf(holds[i + 1]),
      sellPx: l.sell.price,
      buyPx: l.buy.price,
      buyShares: l.buy.shares
    })),
    warnings
  };
}
