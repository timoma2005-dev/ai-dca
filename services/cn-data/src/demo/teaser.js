import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { auctionTeaser } from './auctionReplay.js';

// 付费功能演示的「公开数据预告」接口（游客可访问，只下发结论型数字）。
// 设计原则：真实数据证明功能有效，但不下发足以手动算出可操作结论的完整数据：
//   - 雷达：只给溢价前 3 名（卖出侧），其余标的只给数量；最佳配对的买入侧、历史配对代码一律不下发。
//   - 换基：用户自选一组（卖出/买入），只返回这一组的价差与是否达到阈值；每 IP 每天限 3 组。
// 数据源为 CF Worker 的雷达快照（与 /api/notify/nasdaq-radar 同源），进程内缓存 10 分钟。

export const TEASER_PREFIX = '/api/notify/demo-teaser/';
const RADAR_UPSTREAM = process.env.DEMO_TEASER_RADAR_URL || 'https://api.freebacktrack.tech/api/notify/nasdaq-radar';
const FEATURES_UPSTREAM = `${RADAR_UPSTREAM}/features`;
// Worker 直连需要共享密钥（CF secret RADAR_PROXY_KEY），服务端文件只有 root 可读
const RADAR_KEY_FILE = process.env.DEMO_TEASER_RADAR_KEY_FILE || '/etc/ai-dca/radar-proxy-key';

function radarKey() {
  try { return readFileSync(RADAR_KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

function upstreamHeaders() {
  const key = radarKey();
  return key ? { accept: 'application/json', 'x-radar-key': key } : { accept: 'application/json' };
}
const CACHE_MS = 10 * 60 * 1000;
export const TEASER_TOP_N = 3;
export const SWITCH_PAIRS_PER_DAY = 3;
export const SWITCH_THRESHOLD = 1; // 价差 ≥ 1% 视为出现换基机会（演示口径）

let cache = { at: 0, data: null, pending: null };
const switchQuota = new Map(); // `${day}|${ip}` -> Set(pairKey)

function shanghaiDay(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function clientIp(headers = {}) {
  // 经 Cloudflare 隧道进来时 X-Real-IP 是 127.0.0.1，优先用 CF-Connecting-IP
  const raw = headers['cf-connecting-ip'] || headers['x-real-ip'] || String(headers['x-forwarded-for'] || '').split(',')[0] || '';
  return String(raw).trim() || 'unknown';
}

export function resetTeaserState() {
  cache = { at: 0, data: null, pending: null };
  switchQuota.clear();
}

// 服务器到 CF 的 IPv4 建连常需数秒，fetch 的 happy-eyeballs（每地址 250ms）会误判超时，故用 https + family 4。
function httpsGetJson(target, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(target, { method: 'GET', family: 4, timeout: timeoutMs, headers: upstreamHeaders() }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`radar upstream ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('radar upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function getUpstream(fetchImpl, target) {
  if (!fetchImpl) return httpsGetJson(target);
  const res = await fetchImpl(target, { headers: upstreamHeaders() });
  if (!res.ok) throw new Error(`radar upstream ${res.status}`);
  return res.json();
}

async function fetchRadar(fetchImpl) {
  // 逐日逐只溢价只在服务端用于回测，不下发；与快照并行取（服务器到 CF 单次常要 5–10 秒）
  const featuresPromise = getUpstream(fetchImpl, FEATURES_UPSTREAM).catch((error) => {
    console.warn('[cn-data] demo teaser features failed:', error?.message || error);
    return null;
  });
  const json = await getUpstream(fetchImpl, RADAR_UPSTREAM);
  const data = json?.data;
  if (!data || !Array.isArray(data.etfs) || data.etfs.length < 2) throw new Error('radar upstream empty');
  const features = await featuresPromise;
  const premiumHistory = Array.isArray(features?.data) ? features.data : (cache.data?.premiumHistory || []);
  return { ...data, premiumHistory };
}

const DISK_CACHE = process.env.DEMO_TEASER_CACHE_FILE || '/var/lib/ai-dca-cn-data/demo-teaser-radar.json';

function readDiskCache() {
  try {
    const parsed = JSON.parse(readFileSync(DISK_CACHE, 'utf8'));
    return parsed?.data?.etfs ? parsed : null;
  } catch { return null; }
}

function writeDiskCache(entry) {
  try { writeFileSync(DISK_CACHE, JSON.stringify(entry)); } catch { /* 只是加速冷启动，失败忽略 */ }
}

async function fetchRadarWithRetry(fetchImpl) {
  try { return await fetchRadar(fetchImpl); } catch { return fetchRadar(fetchImpl); }
}

function refresh(fetchImpl, persist) {
  if (!cache.pending) {
    cache.pending = fetchRadarWithRetry(fetchImpl)
      .then((data) => {
        cache = { at: Date.now(), data, pending: null };
        if (persist) writeDiskCache({ at: cache.at, data });
        return data;
      })
      .catch((error) => { cache.pending = null; throw error; });
  }
  return cache.pending;
}

/** 过期后先返回旧数据并在后台刷新（上游到 CF 的建连偶尔要十几秒）。 */
export async function loadRadar({ fetchImpl = null, now = Date.now(), persist = !fetchImpl } = {}) {
  if (!cache.data && persist) {
    const disk = readDiskCache();
    if (disk) cache = { ...cache, at: Number(disk.at) || 0, data: disk.data };
  }
  if (cache.data) {
    if (now - cache.at >= CACHE_MS) refresh(fetchImpl, persist).catch((error) => console.warn('[cn-data] demo teaser refresh failed:', error?.message || error));
    return cache.data;
  }
  return refresh(fetchImpl, persist);
}

function ranked(data) {
  return data.etfs
    .filter((e) => e && typeof e.code === 'string' && Number.isFinite(Number(e.premium)))
    .map((e) => ({ code: e.code, name: String(e.name || ''), premium: Number(e.premium) }))
    .sort((a, b) => b.premium - a.premium || a.code.localeCompare(b.code));
}

/**
 * 评分 v2 预告：与正式雷达同一份 scoring。前 N 只给完整评分；其余只给份额状态（交易所 PCF 公开数据），
 * 不给溢价与分数；推荐组合的买入方不在前 N 时不下发（客户端遮罩）。
 */
export function buildScoringTeaser(data, visibleCodes) {
  const scoring = data?.scoring;
  if (!scoring || typeof scoring !== 'object' || !scoring.etfs || typeof scoring.etfs !== 'object') return null;
  const visible = new Set(visibleCodes);
  const etfs = {};
  for (const [code, item] of Object.entries(scoring.etfs)) {
    if (!item || typeof item !== 'object') continue;
    etfs[code] = visible.has(code) ? item : { code, name: item.name || '', quota: item.quota || null, hidden: true };
  }
  const pair = scoring.recommendedPair;
  let recommendedPair = null;
  if (pair?.sell && visible.has(pair.sell.code)) {
    const buyVisible = Boolean(pair.buy && visible.has(pair.buy.code));
    recommendedPair = {
      sell: pair.sell,
      buy: buyVisible ? pair.buy : null,
      spread: pair.spread,
      costPct: pair.costPct,
      netSpread: pair.netSpread,
      spreadScore: pair.spreadScore,
      sellScore: pair.sellScore,
      buyScore: buyVisible ? pair.buyScore : null,
      score: pair.score,
      blocked: '',
      reasons: buyVisible ? (pair.reasons || []) : (pair.reasons || []).filter((r) => String(r).startsWith(pair.sell.name || '\u0000')),
    };
  }
  return {
    version: scoring.version,
    mode: scoring.mode,
    date: scoring.date,
    quotaDate: scoring.quotaDate || scoring.date,
    peerMeanPremium: scoring.peerMeanPremium,
    weights: scoring.weights,
    etfs,
    recommendedPair,
    pairs: recommendedPair ? [recommendedPair] : [],
    blockedPairs: [],
  };
}

/** 额度阶梯只下发可见几只 */
function seriesTeaser(data, visibleCodes) {
  const series = data?.series;
  if (!series || !Array.isArray(series.dates) || !series.etfs) return null;
  const etfs = {};
  for (const code of visibleCodes) {
    const item = series.etfs[code];
    if (item && Array.isArray(item.limit)) etfs[code] = { limit: item.limit };
  }
  return { dates: series.dates, etfs };
}

/** 雷达预告：纯函数，便于测试。 */
export function buildRadarTeaser(data) {
  const list = ranked(data);
  const pair = data.bestPair || {};
  const recent = Array.isArray(data.recentOpportunities) ? data.recentOpportunities : [];
  const spread = Number(pair.spread);
  return {
    date: data.date || null,
    computedAt: data.computedAt || null,
    premiumSource: data.premiumSource || null,
    total: list.length,
    top: list.slice(0, TEASER_TOP_N),
    hiddenCount: Math.max(0, list.length - TEASER_TOP_N),
    bestPair: Number.isFinite(spread) ? {
      sell: list[0] ? { ...list[0] } : null,
      spread,
      percentile: Number.isFinite(Number(pair.percentile)) ? Number(pair.percentile) : null,
      historyDays: Number.isFinite(Number(pair.historyDays)) ? Number(pair.historyDays) : null,
      // 10 万元本金按价差一次换基的理论溢价差（元），仅作直观换算
      per100k: Math.round(spread * 1000),
    } : null,
    recent: recent
      .filter((r) => Number.isFinite(Number(r?.spread)))
      .map((r) => ({ date: r.date || null, spread: Number(r.spread) })),
    codes: list.map((e) => e.code).sort(), // 只给可选代码集合（无排序信息），供换基自选
    names: Object.fromEntries(list.map((e) => [e.code, e.name])),
    scoring: buildScoringTeaser(data, list.slice(0, TEASER_TOP_N).map((e) => e.code)),
    series: seriesTeaser(data, list.slice(0, TEASER_TOP_N).map((e) => e.code)),
  };
}

/**
 * 两只之间的轮动回测（服务端计算，只下发结论）：从持有 sell 开始，持有标的比另一只溢价高出 ≥ 阈值时换过去。
 * 收益按期末盯市、相对「一直拿着 sell」计算（假设两只跟踪同一指数、净值同涨跌）：
 *   每次换基份额按 (1+p_from)/(1+p_to) 放大，期末再乘 (1+p_持有)/(1+p_sell)。未计手续费与冲击成本。
 */
export function backtestPair(history, sell, buy, threshold = SWITCH_THRESHOLD) {
  const days = (Array.isArray(history) ? history : [])
    .filter((d) => Number.isFinite(Number(d?.premiums?.[sell])) && Number.isFinite(Number(d?.premiums?.[buy])))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (days.length < 5) return null;
  let holding = sell;
  let switches = 0;
  let units = 1;
  for (const day of days) {
    const other = holding === sell ? buy : sell;
    const from = Number(day.premiums[holding]);
    const to = Number(day.premiums[other]);
    if (from - to >= threshold) {
      units *= (1 + from / 100) / (1 + to / 100);
      switches += 1;
      holding = other;
    }
  }
  const last = days[days.length - 1].premiums;
  const relative = units * (1 + Number(last[holding]) / 100) / (1 + Number(last[sell]) / 100) - 1;
  const gainPct = +(relative * 100).toFixed(2);
  return { days: days.length, from: days[0].date, to: days[days.length - 1].date, switches, gainPct, per100k: Math.round(relative * 100000) };
}

export function buildSwitchTeaser(data, sell, buy) {
  const map = new Map(ranked(data).map((e) => [e.code, e]));
  const a = map.get(sell);
  const b = map.get(buy);
  if (!a || !b || sell === buy) return null;
  const spread = +(a.premium - b.premium).toFixed(2);
  const best = Number(data.bestPair?.spread);
  return {
    date: data.date || null,
    sell: { code: a.code, name: a.name },
    buy: { code: b.code, name: b.name },
    spread,
    triggered: spread >= SWITCH_THRESHOLD,
    threshold: SWITCH_THRESHOLD,
    per100k: Math.round(Math.max(0, spread) * 1000),
    // 与当日最优组合的差距（只给差值，不给最优组合是谁）
    gapToBest: Number.isFinite(best) ? +(best - spread).toFixed(2) : null,
    backtest: backtestPair(data.premiumHistory, a.code, b.code),
  };
}

function takeSwitchQuota(ip, pairKey, now) {
  const key = `${shanghaiDay(now)}|${ip}`;
  let used = switchQuota.get(key);
  if (!used) {
    if (switchQuota.size > 5000) switchQuota.clear();
    used = new Set();
    switchQuota.set(key, used);
  }
  if (used.has(pairKey)) return { ok: true, remaining: SWITCH_PAIRS_PER_DAY - used.size };
  if (used.size >= SWITCH_PAIRS_PER_DAY) return { ok: false, remaining: 0 };
  used.add(pairKey);
  return { ok: true, remaining: SWITCH_PAIRS_PER_DAY - used.size };
}

export async function handleDemoTeaserRoute(method, url, headers, { fetchImpl = null, now = Date.now() } = {}) {
  if (!url.pathname.startsWith(TEASER_PREFIX)) return null;
  if (method !== 'GET') return { status: 405, body: { ok: false, error: 'Method not allowed' } };
  const name = url.pathname.slice(TEASER_PREFIX.length);
  const cacheHeaders = { 'Cache-Control': 'no-store' };
  if (name === 'auction') {
    const result = auctionTeaser({ now });
    return result
      ? { body: { ok: true, data: result }, headers: cacheHeaders }
      : { status: 503, body: { ok: false, code: 'TEASER_UNAVAILABLE', error: '暂无已录制的集合竞价' } };
  }
  let data;
  try {
    data = await loadRadar({ fetchImpl, now });
  } catch (error) {
    console.warn('[cn-data] demo teaser upstream failed:', error?.message || error);
    return { status: 503, body: { ok: false, code: 'TEASER_UNAVAILABLE', error: '公开数据暂不可用' } };
  }
  if (name === 'radar') return { body: { ok: true, data: buildRadarTeaser(data) }, headers: cacheHeaders };
  if (name === 'switch') {
    const sell = String(url.searchParams.get('sell') || '');
    const buy = String(url.searchParams.get('buy') || '');
    const result = buildSwitchTeaser(data, sell, buy);
    if (!result) return { status: 400, body: { ok: false, code: 'BAD_PAIR', error: '请选择两只不同的纳指 ETF' } };
    const quota = takeSwitchQuota(clientIp(headers), `${sell}>${buy}`, now);
    if (!quota.ok) return { status: 429, body: { ok: false, code: 'TEASER_QUOTA', error: `演示每天最多查看 ${SWITCH_PAIRS_PER_DAY} 组，升级后不限`, remaining: 0 } };
    return { body: { ok: true, data: { ...result, remaining: quota.remaining } }, headers: cacheHeaders };
  }
  return { status: 404, body: { ok: false, error: 'Not found' } };
}
