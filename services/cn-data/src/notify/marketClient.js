import { getTodayShanghaiDate, resolveHoldingKindAsync } from './detectionSupport.js';
export const MARKETS_BASE = process.env.MARKETS_BASE_URL || 'http://127.0.0.1:18080/api/markets';
const BENCHMARK_SYMBOL_MAP = {'nas-daq100':'^NDX'};
const EXCHANGE_PREFIXES = new Set(['15','50','51','52','54','56','58']);
function resolveMarketSymbol(symbol = '') {
  const raw = String(symbol || '').trim();
  return BENCHMARK_SYMBOL_MAP[raw] || raw;
}

function isSixDigitFundCode(symbol = '') {
  return /^\d{6}$/.test(String(symbol || '').trim());
}

function isExchangeFundCode(symbol = '') {
  const code = String(symbol || '').trim();
  return isSixDigitFundCode(code) && EXCHANGE_PREFIXES.has(code.slice(0, 2));
}

function normalizeQuoteEntry(symbol, item = {}) {
  const rawSymbol = String(symbol || '').trim();
  const price = Number(item?.price ?? item?.currentPrice ?? item?.close ?? item?.latestNav ?? item?.navBase ?? item?.iopv) || 0;
  const currency = String(item?.currency || '').trim() || (isSixDigitFundCode(rawSymbol) ? '¥' : '$');
  return {
    code: rawSymbol,
    symbol: rawSymbol,
    name: String(item?.name || rawSymbol).trim(),
    currency,
    current_price: price,
    price,
    previous_close: Number(item?.previousClose ?? item?.previousNav) || 0,
    change: Number(item?.change) || 0,
    change_percent: Number(item?.changePercent) || 0,
    premium_rate: Number(item?.premiumPercent ?? item?.premium_rate),
    premiumPercent: Number(item?.premiumPercent ?? item?.premium_rate),
    date: String(item?.quoteDate || item?.latestNavDate || item?.date || '').trim(),
    datetime: String(item?.asOf || item?.updatedAt || '').trim(),
    source: String(item?.source || '').trim() || 'markets'
  };
}

function marketCandleToDailyBar(candle = {}, timeZone = 'America/New_York') {
  const t = Number(candle?.t);
  const close = Number(candle?.c);
  if (!Number.isFinite(t) || !Number.isFinite(close) || close <= 0) return null;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(t * 1000));
  return {
    date,
    open: Number(candle?.o) || close,
    high: Number(candle?.h) || close,
    low: Number(candle?.l) || close,
    close,
    volume: Number(candle?.v) || 0
  };
}


async function marketJson(path, init = {}) {
  const response = await fetch(`${MARKETS_BASE.replace(/\/+$/, '')}${path}`, {...init, signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`行情接口 HTTP ${response.status}`);
  return response.json();
}
export async function fetchFundMetrics(codes, {fundKinds = {}, forceRefresh = false} = {}) {
  if (!codes.length) return {};
  const payload = await marketJson('/fund-metrics', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({codes, fundKinds, ...(forceRefresh ? {refresh:true} : {})})});
  return Object.fromEntries((Array.isArray(payload.items) ? payload.items : []).filter(i => i?.code && i.ok !== false).map(i => [i.code, i]));
}
export async function fetchQuotes(symbols) {
  try { return (await marketJson(`/quotes?symbols=${encodeURIComponent(symbols.join(','))}`)).quotes || {}; } catch { return {}; }
}
export async function fetchKlineDailyBars(symbol) {
  try {
    const payload = await marketJson(`/kline/${encodeURIComponent(resolveMarketSymbol(symbol))}?tf=1d`);
    return (payload.candles || []).map(c => marketCandleToDailyBar(c, payload.market === 'cn' ? 'Asia/Shanghai' : 'America/New_York')).filter(Boolean);
  } catch { return []; }
}
export async function loadLatestMarketMap(rulesOrSymbols = [], {forceRefresh = false} = {}) {
  const symbols = new Set(); const fundKinds = {};
  for (const item of rulesOrSymbols) {
    if (typeof item === 'string') { if (item.trim()) symbols.add(item.trim()); continue; }
    if (item?.symbol) {
      const symbol = String(item.symbol).trim(); symbols.add(symbol);
      const kind = item.fundKind || item.kind || item.requestedFundKind;
      if (/^\d{6}$/.test(symbol) && ['exchange','otc','qdii'].includes(kind)) fundKinds[symbol] = kind;
    }
    if (item?.referenceSymbol) symbols.add(String(item.referenceSymbol).trim());
  }
  const funds = [...symbols].filter(isSixDigitFundCode); const others = [...symbols].filter(s => !isSixDigitFundCode(s)); const result = {};
  try { for (const [code, item] of Object.entries(await fetchFundMetrics(funds, {fundKinds, forceRefresh}))) result[code] = normalizeQuoteEntry(code, item); } catch { /* 源站异常降级，不阻断其它标的。 */ }
  if (others.length) {
    const quotes = await fetchQuotes(others.map(resolveMarketSymbol));
    for (const symbol of others) { const item = quotes[resolveMarketSymbol(symbol)] || quotes[symbol]; if (item && !item.error) result[symbol] = normalizeQuoteEntry(symbol, item); }
  }
  return result;
}
export async function loadDailyBars(cache, code) {
  code = String(code || '').trim(); if (!code) return [];
  if (cache.has(code)) return cache.get(code);
  const pending = (async () => {
    if (isSixDigitFundCode(code) && !isExchangeFundCode(code)) {
      const today = getTodayShanghaiDate(); const from = new Date(`${today}T00:00:00Z`); from.setUTCDate(from.getUTCDate()-900);
      return (await fetchDanjuanNavHistory(code, from.toISOString().slice(0,10), today)).map(i => ({date:i.date, open:i.nav, high:i.nav, low:i.nav, close:i.nav, volume:0}));
    }
    return fetchKlineDailyBars(code);
  })();
  cache.set(code, pending); const bars = await pending; cache.set(code, bars); return bars;
}
export async function fetchHoldingSnapshots(codes, {bucketKindByCode = {}, todayShanghai = getTodayShanghaiDate()} = {}) {
  let metrics = {}; const kinds = {};
  for (const code of codes) kinds[code] = await resolveHoldingKindAsync(code, bucketKindByCode[code]);
  try { metrics = await fetchFundMetrics([...new Set(codes)], {fundKinds:kinds}); } catch { /* 行情失败返回缺失快照。 */ }
  const result = {};
  for (const code of codes) {
    const item = metrics[code]; if (!item || item.ok === false) {result[code] = {code, ok:false}; continue;}
    if (kinds[code] === 'exchange') {
      const price = Number(item.price ?? item.close); const previousClose = Number(item.previousClose);
      result[code] = {code, price, currentPrice:price, close:Number(item.close) || price, previousClose, previousNav:previousClose, latestNav:Number(item.latestNav)>0?Number(item.latestNav):price, latestNavDate:item.quoteDate||item.date||todayShanghai, quoteDate:item.quoteDate||item.date||todayShanghai, source:'fund-metrics', valueType:'price', ok:true};
    } else {
      const latestNav = Number(item.latestNav), previousNav = Number(item.previousNav);
      result[code] = {code, latestNav, latestNavDate:item.latestNavDate, previousNav, previousNavDate:item.previousNavDate, source:'fund-metrics', valueType:'nav', ok:Number.isFinite(latestNav)&&latestNav>0&&Number.isFinite(previousNav)&&previousNav>0};
    }
  }
  return result;
}
async function fetchDanjuanNavHistoryRaw(code, fromDate, toDate) {
  const normalized = String(code || '').trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw new Error('蛋卷净值历史接口请求失败：无效基金代码。');
  }

  const headers = {
    accept: 'application/json, text/plain, */*',
    referer: 'https://danjuanfunds.com/',
    'user-agent': 'Mozilla/5.0'
  };
  const items = [];
  const pageSize = 100;
  for (let page = 1; page <= 50; page++) {
    const url = new URL(`https://danjuanfunds.com/djapi/fund/nav/history/${encodeURIComponent(normalized)}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', String(pageSize));

    const response = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      throw new Error(`${normalized} 蛋卷净值历史接口请求失败：HTTP ${response.status}`);
    }
    const rawText = await response.text();
    let payload;
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch (_error) {
      throw new Error(`${normalized} 蛋卷净值历史接口返回了非 JSON 响应。`);
    }

    const rows = Array.isArray(payload?.data?.items) ? payload.data.items : [];
    if (!rows.length) break;

    let reachedBeforeRange = false;
    for (const row of rows) {
      const date = String(row?.date || '').slice(0, 10);
      const nav = Number(row?.nav ?? row?.value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (date < fromDate) {
        reachedBeforeRange = true;
        continue;
      }
      if (date > toDate || !Number.isFinite(nav) || nav <= 0) continue;
      items.push({ date, nav: Number(nav.toFixed(4)) });
    }

    const totalItems = Number(payload?.data?.total_items) || 0;
    if (reachedBeforeRange || (totalItems > 0 && page * pageSize >= totalItems)) break;
  }

  items.sort((a, b) => a.date.localeCompare(b.date));
  return items;
}
export async function fetchDanjuanNavHistory(code, fromDate, toDate) { try { return await fetchDanjuanNavHistoryRaw(code, fromDate, toDate); } catch { return []; } }
