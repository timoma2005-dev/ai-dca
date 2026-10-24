// 竞价看板演示的真实行情：交易日 09:14–09:31 在 cn-data 进程内录制集合竞价（腾讯 ETF 行情 + 东财 NQ00Y + 东财参考净值），
// 竞价时段（09:15–09:25）实时下发，其它时间回放最近一个已录制的交易日（到 09:31 开盘结果为止）。
// 下发时每一帧只保留「偏离」绝对值最大的前 3 只 ETF 的行情与净值，其余标的不下发（看板显示为无行情）。
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const AUCTION_ETFS = ['sh513100', 'sz159501', 'sz159941', 'sz159696', 'sz159659', 'sz159632', 'sh513300', 'sh513870', 'sh513110', 'sz159660', 'sh513390', 'sz159513'];
export const AUCTION_TOP_N = 3;
const DIR = process.env.DEMO_AUCTION_DIR || '/var/lib/ai-dca-cn-data/auction-replay';
const QQ_URL = `https://qt.gtimg.cn/q=${AUCTION_ETFS.join(',')},${AUCTION_ETFS.map((c) => `jj${c.slice(2)}`).join(',')}`;
const EM_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=103.NQ00Y&fields1=f1,f2&fields2=f51,f53&ndays=2&iscr=0';
const FM_URL = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=200&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=nq-board&Fcodes=${AUCTION_ETFS.map((c) => c.slice(2)).join(',')}`;
const REC_START = 9 * 3600 + 14 * 60 + 30; // 09:14:30
const REC_END = 9 * 3600 + 31 * 60; // 09:31:00
const LIVE_START = 9 * 3600 + 15 * 60;
const LIVE_END = 9 * 3600 + 26 * 60; // 09:25 撮合结果出来后再给一分钟
const POLL_MS = 5000;

const p2 = (n) => String(n).padStart(2, '0');
/** 北京时间 { date: 'YYYY-MM-DD', sec: 当日秒数, weekday } */
export function shanghaiClock(now = Date.now()) {
  const d = new Date(now + 8 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(), weekday: d.getUTCDay() };
}

/* ---------- 解析（与 public/auction-board.html 的 loadETF / fromEM / loadFM 一致） ---------- */
export function parseQQ(text) {
  const etf = {};
  const nav = {};
  let etfTime = null;
  const vars = {};
  for (const m of String(text).matchAll(/v_([a-z0-9]+)="([^"]*)"/g)) vars[m[1]] = m[2];
  for (const key of AUCTION_ETFS) {
    const f = typeof vars[key] === 'string' ? vars[key].split('~') : [];
    if (f.length < 31) continue;
    etf[key] = { full: f[1], code: f[2], cur: +f[3] || 0, pre: +f[4] || 0, open: +f[5] || 0, b1: +f[9] || 0, b1v: +f[10] || 0, a1: +f[19] || 0, a1v: +f[20] || 0, t: f[30], vol: +f[6] || 0, flag: (f[40] || '').trim() };
    if (f[30] && (!etfTime || f[30] > etfTime)) etfTime = f[30];
    const tn = parseFloat(f[78]);
    if (tn > 0) nav[f[2]] = { nav: tn, date: '腾讯最新净值', src: 'qq' };
  }
  for (const key of AUCTION_ETFS) {
    const c = key.slice(2);
    const g = typeof vars[`jj${c}`] === 'string' ? vars[`jj${c}`].split('~') : [];
    const nv = parseFloat(g[5]);
    if (nv > 0 && /^\d{4}-\d\d-\d\d/.test(g[8] || '') && !nav[c]) nav[c] = { nav: nv, date: g[8].slice(0, 10), src: 'jj' };
  }
  return { etf, nav, etfTime };
}

export function parseFM(json) {
  const nav = {};
  for (const it of json?.Datas || []) {
    const nv = parseFloat(it.NAV);
    const z = parseFloat(it.ZJL);
    const np = parseFloat(it.NEWPRICE);
    let ref = null;
    if (Number.isFinite(z) && np > 0 && 1 - z / 100 > 0) ref = np / (1 - z / 100);
    if (ref > 0) nav[String(it.FCODE)] = { nav: ref, date: '东财参考净值', src: 'fm' };
    else if (nv > 0) nav[String(it.FCODE)] = { nav: nv, date: String(it.PDATE || '').slice(0, 10), src: 'fm' };
  }
  return nav;
}

export function parseEM(json) {
  const pts = [];
  for (const s of json?.data?.trends || []) {
    const a = String(s).split(',');
    const p = parseFloat(a[1]);
    if (a[0] && a[0].length >= 16 && Number.isFinite(p) && p > 0) pts.push({ t: a[0].slice(0, 16), p });
  }
  return pts;
}

/** 与看板 findBase(points, true) 一致：最近一个 ≤ now 的「日期 15:00」点，没有则取 14:00–15:00 间最后一点（approx）。 */
export function findBase(points, nowStamp) {
  const dates = [];
  const seen = new Set();
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const dd = points[i].t.slice(0, 10);
    if (!seen.has(dd)) { seen.add(dd); dates.push(dd); }
  }
  for (const day of dates) {
    const key = `${day} 15:00`;
    if (key > nowStamp) continue;
    let before = null;
    for (let k = points.length - 1; k >= 0; k -= 1) {
      const p = points[k];
      if (p.t === key) return { t: p.t, p: p.p, approx: false };
      if (!before && p.t < key && p.t >= `${day} 14:00`) before = p;
    }
    if (before) return { t: before.t, p: before.p, approx: true };
  }
  return null;
}

/* ---------- 前 3 只遮罩 ---------- */
/** 偏离（百分点）= ETF 相对昨收涨跌 − NQ 自前一交易日 15:00 涨跌；停牌 / 无价返回 null。 */
export function deviation(q, nqPct) {
  if (!q || q.flag === 'S' || !(q.cur > 0) || !(q.pre > 0) || !Number.isFinite(nqPct)) return null;
  return (q.cur / q.pre - 1 - nqPct) * 100;
}

export function topCodes(etf, nqPct, n = AUCTION_TOP_N) {
  return Object.entries(etf || {})
    .map(([key, q]) => ({ key, dev: deviation(q, nqPct) }))
    .filter((r) => r.dev != null)
    .sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev) || a.key.localeCompare(b.key))
    .slice(0, n)
    .map((r) => r.key);
}

/** 把录制文件压成下发结构：每帧只留前 3 只；净值只给出现过的标的。 */
export function maskRecording(rec, { untilSec = Infinity } = {}) {
  if (!rec || !Array.isArray(rec.frames) || !rec.frames.length) return null;
  const pts = Array.isArray(rec.nqPts) ? rec.nqPts : [];
  const base = rec.nqBase || null;
  const shown = new Set();
  const frames = rec.frames.filter((f) => f.s <= untilSec).map((f) => {
    const nqLast = f.nqLast || pts[pts.length - 1] || null;
    const nqPct = base && nqLast ? nqLast.p / base.p - 1 : NaN;
    const keep = topCodes(f.etf, nqPct);
    keep.forEach((k) => shown.add(k.slice(2)));
    return { s: f.s, etfTime: f.etfTime, nqLast, etf: Object.fromEntries(keep.map((k) => [k, f.etf[k]])) };
  });
  if (!frames.length) return null;
  const nav = Object.fromEntries(Object.entries(rec.nav || {}).filter(([code]) => shown.has(code)));
  return { date: rec.date, nq: { pts, base, src: '东方财富 NQ00Y' }, nav, frames, total: AUCTION_ETFS.length, topN: AUCTION_TOP_N };
}

/* ---------- 录制 ---------- */
function fileFor(date, dir = DIR) { return join(dir, `${date}.json`); }

export function readRecording(date, dir = DIR) {
  try { return JSON.parse(readFileSync(fileFor(date, dir), 'utf8')); } catch { return null; }
}

function writeRecording(rec, dir = DIR) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${fileFor(rec.date, dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, fileFor(rec.date, dir));
}

/** 最近一个录到 09:25 之后的交易日（排除 today 本身未完成的录制）。 */
export function latestCompleteDate(dir = DIR, { before = null } = {}) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort().reverse(); } catch { return null; }
  for (const f of files) {
    const date = f.slice(0, 10);
    if (before && date >= before) continue;
    const rec = readRecording(date, dir);
    const last = rec?.frames?.[rec.frames.length - 1];
    if (last && last.s >= 9 * 3600 + 25 * 60) return date;
  }
  return null;
}

async function getText(url, { gbk = false } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { referer: 'https://gu.qq.com/' } });
  if (!res.ok) throw new Error(`${url.split('/')[2]} ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return gbk ? new TextDecoder('gbk').decode(buf) : buf.toString('utf8');
}

export async function recordFrame({ now = Date.now(), dir = DIR, fetchText = getText } = {}) {
  const clock = shanghaiClock(now);
  const qq = parseQQ(await fetchText(QQ_URL, { gbk: true }));
  // 节假日 / 停市：行情时间不是今天就不录
  if (!qq.etfTime || qq.etfTime.slice(0, 8) !== clock.date.replace(/-/g, '')) return { skipped: 'stale-quotes' };
  const rec = readRecording(clock.date, dir) || { date: clock.date, nqPts: [], nqBase: null, nav: {}, frames: [] };
  let nqLast = null;
  try {
    const pts = parseEM(JSON.parse(await fetchText(EM_URL)));
    if (pts.length) {
      nqLast = pts[pts.length - 1];
      if (!rec.nqPts.length) {
        const stamp = `${clock.date} ${p2(Math.floor(clock.sec / 3600))}:${p2(Math.floor(clock.sec / 60) % 60)}`;
        rec.nqBase = findBase(pts, stamp);
        const from = rec.nqBase ? rec.nqBase.t : pts[0].t;
        rec.nqPts = pts.filter((p) => p.t >= from);
      }
    }
  } catch { /* NQ 失败沿用上一帧 */ }
  if (!Object.keys(rec.nav).length) {
    let nav = { ...qq.nav };
    try { nav = { ...nav, ...parseFM(JSON.parse(await fetchText(FM_URL))) }; } catch { /* 用腾讯净值 */ }
    rec.nav = nav;
  }
  if (!nqLast) nqLast = rec.frames.length ? rec.frames[rec.frames.length - 1].nqLast : rec.nqPts[rec.nqPts.length - 1] || null;
  rec.frames.push({ s: clock.sec, etfTime: qq.etfTime, nqLast, etf: qq.etf });
  writeRecording(rec, dir);
  return { frames: rec.frames.length };
}

export function startAuctionRecorder({ log = console } = {}) {
  let busy = false;
  const timer = setInterval(() => {
    const c = shanghaiClock();
    if (busy || c.weekday === 0 || c.weekday === 6 || c.sec < REC_START || c.sec > REC_END) return;
    busy = true;
    recordFrame().catch((error) => log.warn?.('[cn-data] auction record failed:', error?.message || error)).finally(() => { busy = false; });
  }, POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** GET /api/notify/demo-teaser/auction：竞价时段给今天实时帧，其余时间回放最近一个完整交易日。 */
export function auctionTeaser({ now = Date.now(), dir = DIR } = {}) {
  const c = shanghaiClock(now);
  if (c.weekday !== 0 && c.weekday !== 6 && c.sec >= LIVE_START && c.sec <= LIVE_END) {
    const live = maskRecording(readRecording(c.date, dir), { untilSec: c.sec });
    if (live) return { mode: 'live', ...live };
  }
  const date = latestCompleteDate(dir, { before: c.sec < REC_END ? c.date : null });
  const replay = date ? maskRecording(readRecording(date, dir)) : null;
  return replay ? { mode: 'replay', ...replay } : null;
}
