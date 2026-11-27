// 日内轮动图表的纯计算：溢价偏离条形图 + 换车收益曲线。

const SHORT_NAME_RE = /纳斯达克100|纳斯达克|纳指100|纳指|纳100|ETF|QDII|LOF/g;

export function shortName(name, code = '') {
  const s = String(name || '').replace(SHORT_NAME_RE, '').trim();
  return s || String(name || code || '');
}

// dev_bps 是「现价相对今天基准价」的收益 bp，基准价 = IOPV × (1 + 基准溢价)
export function basePrice(row) {
  const iopv = Number(row?.iopv);
  const base = Number(row?.base_bps);
  if (!(iopv > 0) || row?.base_bps === null || row?.base_bps === undefined || !Number.isFinite(base)) return null;
  return iopv * (1 + base / 1e4);
}

export function deviationBars(rows) {
  const list = (rows || []).filter((r) => r && Number.isFinite(Number(r.dev_bps)) && r.dev_bps !== null);
  const maxAbs = list.reduce((m, r) => Math.max(m, Math.abs(Number(r.dev_bps))), 0) || 1;
  return list
    .map((r) => ({
      code: r.code,
      name: shortName(r.name, r.code),
      price: r.price,
      basePx: basePrice(r),
      dev: Number(r.dev_bps),
      ratio: Math.abs(Number(r.dev_bps)) / maxAbs
    }))
    .sort((a, b) => a.dev - b.dev);
}

// A 股连续交易分钟轴：09:30 = 0，11:30 = 120，13:00 也是 120（午休压掉），15:00 = 240
export function tradingMinute(ts) {
  const d = new Date(ts * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const m = get('hour') * 60 + get('minute') + get('second') / 60;
  if (m <= 690) return Math.max(0, m - 570);
  if (m < 780) return 120;
  return Math.min(240, 120 + (m - 780));
}

export function minuteLabel(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return '';
  const m = v <= 120 ? 570 + v : 780 + (v - 120);
  const hh = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' + 'HH:MM[:SS]'（上海时间）-> 秒
export function shanghaiTs(day, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(String(time || ''))) return null;
  const [h, m, s = '0'] = String(time).split(':');
  const ms = Date.parse(`${day}T${h.padStart(2, '0')}:${m}:${s.padStart(2, '0')}+08:00`);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export function defaultBuyShares(sellShares, sellPx, buyPx) {
  const n = Number(sellShares) * Number(sellPx) / Number(buyPx);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 100) * 100;
}

/**
 * 换车（卖 A 买 B）相对「拿着 A 不换」多赚多少元。
 * v(t) = 买入份额·B(t) + 找零 − 卖出份额·A(t) − 双边佣金；找零 = 卖出额 − 买入额。
 * seriesA/seriesB: [[ts, px], ...] 按时间升序。
 */
export function switchPnlSeries({ seriesA, seriesB, switchTs, sellPx, sellShares, buyPx, buyShares, commBps = 0 }) {
  const sp = Number(sellPx);
  const bp = Number(buyPx);
  const ns = Number(sellShares);
  const nb = Number(buyShares);
  if (!(sp > 0 && bp > 0 && ns > 0 && nb > 0) || !Number.isFinite(switchTs)) return null;
  const a = Array.isArray(seriesA) ? seriesA : [];
  const b = Array.isArray(seriesB) ? seriesB : [];
  const cash = ns * sp - nb * bp;
  const fees = (ns * sp + nb * bp) * Number(commBps || 0) / 1e4;
  const stamps = [...new Set([...a, ...b].map((p) => p[0]).filter((t) => t >= switchTs))].sort((x, y) => x - y);
  let ia = 0;
  let ib = 0;
  let pa = null;
  let pb = null;
  const points = [];
  for (const t of stamps) {
    while (ia < a.length && a[ia][0] <= t) pa = a[ia++][1];
    while (ib < b.length && b[ib][0] <= t) pb = b[ib++][1];
    if (pa === null || pb === null) continue;
    const v = nb * pb + cash - ns * pa - fees;
    points.push({ ts: t, x: tradingMinute(t), v: Math.round(v * 100) / 100, pa, pb });
  }
  if (!points.length) return { points, min: null, max: null, last: null, cash, fees };
  let min = points[0];
  let max = points[0];
  for (const p of points) {
    if (p.v < min.v) min = p;
    if (p.v > max.v) max = p;
  }
  return { points, min, max, last: points[points.length - 1], cash, fees };
}

// 序列里 ts 时刻（含）之前最后一个价格；ts 早于序列开头 5 分钟以内时取第一个价格
export function priceAt(series, ts) {
  const list = series || [];
  let px = null;
  for (const p of list) {
    if (p[0] > ts) break;
    px = p[1];
  }
  if (px === null && list.length && list[0][0] - ts <= 300) px = list[0][1];
  return px;
}

/**
 * 一天多次换车：从 startCode × startShares 出发，按时间依次「全部卖出当前持仓 → 买入下一只」。
 * switches: [{ ts, buyCode, sellPx?, buyPx?, buyShares? }]，价格留空按该时刻行情价，买入份额留空按可用资金折整百。
 * 返回两条线（相对第一次换车时的市值）：mine = 我（换了 N 次），base = 一直拿 startCode；
 * 以及每一次换车的明细（含「这一次比不换多赚多少」的单次曲线）。
 */
export function rotationPortfolio({ seriesByCode, startCode, startShares, switches, commBps = 0 }) {
  const n0 = Number(startShares);
  const S = seriesByCode || {};
  const comm = Number(commBps || 0) / 1e4;
  const list = (switches || []).filter((s) => Number.isFinite(s?.ts)).slice().sort((a, b) => a.ts - b.ts);
  if (!startCode || !(n0 > 0) || !list.length) return null;

  let code = startCode;
  let shares = n0;
  let cash = 0;
  const legs = [];
  for (const [i, s] of list.entries()) {
    const sp = Number(s.sellPx) > 0 ? Number(s.sellPx) : priceAt(S[code], s.ts);
    const bp = Number(s.buyPx) > 0 ? Number(s.buyPx) : priceAt(S[s.buyCode], s.ts);
    if (!s.buyCode || s.buyCode === code) return { error: `第 ${i + 1} 次换车：买入代码不能和当前持仓相同` };
    if (!(sp > 0 && bp > 0)) return { error: `第 ${i + 1} 次换车：缺少成交价（该时刻也没有行情）` };
    const proceeds = shares * sp;
    const nb = Number(s.buyShares) > 0 ? Number(s.buyShares) : Math.floor((proceeds + Math.max(cash, 0)) / bp / 100) * 100;
    if (!(nb > 0)) return { error: `第 ${i + 1} 次换车：买入份额为 0` };
    const fees = (proceeds + nb * bp) * comm;
    const single = switchPnlSeries({
      seriesA: S[code], seriesB: S[s.buyCode], switchTs: s.ts, sellPx: sp, sellShares: shares, buyPx: bp, buyShares: nb, commBps
    });
    legs.push({ n: i + 1, ts: s.ts, x: tradingMinute(s.ts), from: code, to: s.buyCode, sellPx: sp, sellShares: shares, buyPx: bp, buyShares: nb, fees, single });
    cash += proceeds - nb * bp - fees;
    code = s.buyCode;
    shares = nb;
  }

  const t0 = list[0].ts;
  const v0 = n0 * legs[0].sellPx;
  const codes = [...new Set([startCode, ...legs.map((l) => l.to)])];
  const stamps = [...new Set(codes.flatMap((c) => (S[c] || []).map((p) => p[0])).filter((t) => t >= t0))].sort((a, b) => a - b);
  const idx = Object.fromEntries(codes.map((c) => [c, 0]));
  const last = {};
  let li = -1;
  let hold = { code: startCode, shares: n0, cash: 0 };
  const states = legs.map((l, i) => ({ ts: l.ts, code: l.to, shares: l.buyShares, cash: legs.slice(0, i + 1).reduce((m, x) => m + x.sellPx * x.sellShares - x.buyPx * x.buyShares - x.fees, 0) }));
  const points = [];
  for (const t of stamps) {
    for (const c of codes) {
      const arr = S[c] || [];
      while (idx[c] < arr.length && arr[idx[c]][0] <= t) last[c] = arr[idx[c]++][1];
    }
    while (li + 1 < states.length && states[li + 1].ts <= t) hold = states[++li];
    const ph = last[hold.code];
    const pb = last[startCode];
    if (ph == null || pb == null) continue;
    const mine = Math.round((hold.shares * ph + hold.cash - v0) * 100) / 100;
    const base = Math.round((n0 * pb - v0) * 100) / 100;
    points.push({ ts: t, x: tradingMinute(t), mine, base, up: [base, Math.max(base, mine)], down: [Math.min(base, mine), base] });
  }
  for (const l of legs) l.y = points.find((p) => p.ts >= l.ts)?.mine ?? 0;
  return { points, legs, last: points[points.length - 1] || null, startCode, startShares: n0 };
}

// 没有偏离数据时按上海时间给提示（轮动进程交易日 10:25 启动，之后每 5 秒刷新）
export function emptyHint(now = Date.now()) {
  const d = new Date(now + 8 * 3600e3);
  const wd = d.getUTCDay();
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (wd === 0 || wd === 6) return ['今天休市', '下个交易日开盘后显示'];
  if (m < 10 * 60 + 25) return ['还没开盘', '开盘后显示（轮动 10:25 启动，之后每 5 秒刷新）'];
  if (m >= 11 * 60 + 30 && m < 13 * 60) return ['午休中', '13:00 开盘后显示'];
  if (m >= 15 * 60) return ['今天已收盘', '下个交易日开盘后显示'];
  return ['暂时没有行情', '可能休市或行情还没到，几秒后会自动刷新'];
}

const shDate = (now) => new Date(now + 8 * 3600e3);
export const shanghaiDay = (now = Date.now()) => shDate(now).toISOString().slice(0, 10);
export function inLunch(now = Date.now()) {
  const d = shDate(now);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return d.getUTCDay() % 6 !== 0 && m >= 11 * 60 + 30 && m < 13 * 60;
}
