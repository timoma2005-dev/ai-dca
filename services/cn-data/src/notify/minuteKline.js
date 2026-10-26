/* global process, fetch, AbortSignal */
// 换基「智能自动填充」用的分钟级行情与净值数据源。
//
// - 1m：腾讯 appstock day/query（最近 5 个交易日分时，"HHMM 价 累计量 额"），失败回退东财 push2his klt=1。
// - 5m：优先复用本机 market-collector /api/markets/kline/:code?tf=5m（约 500 根 ≈ 10+ 个交易日），失败回退东财 klt=5。
// - 净值：东财 fundmobapi FundMNHisNetList（最近 40 条单位净值）。
// 只保留有成交的分钟（停牌 / 无成交分钟的价格是陈旧价，不能参与溢价差计算）。
// 所有结果带短 TTL 内存缓存 + inflight 去重；上游失败时 15 分钟内的旧值可兜底，否则负缓存 60 秒。

export const MARKETS_BASE = process.env.MARKETS_BASE_URL || 'http://127.0.0.1:18080/api/markets';
export const MINUTE_CACHE_TTL_MS = Object.freeze({ '1m': 90_000, '5m': 180_000, nav: 30 * 60_000 });
const STALE_FALLBACK_MS = 15 * 60_000;
const NEGATIVE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 4000;
const UA = 'Mozilla/5.0 (compatible; ai-dca-cn-data/1.0)';

const cache = new Map();

export function clearMinuteKlineCache() { cache.clear(); }

async function cached(key, ttlMs, loader, now = Date.now) {
  const hit = cache.get(key);
  if (hit?.value !== undefined && now() - hit.at < ttlMs) return hit.value;
  if (hit?.error && now() - hit.at < NEGATIVE_TTL_MS) throw hit.error;
  if (hit?.promise) return hit.promise;
  const promise = (async () => {
    try {
      const value = await loader();
      cache.set(key, { at: now(), value });
      return value;
    } catch (error) {
      if (hit?.value !== undefined && now() - hit.at < STALE_FALLBACK_MS) {
        cache.set(key, { at: hit.at, value: hit.value });
        return hit.value;
      }
      // 失败短暂负缓存（停牌 / 无成交 / 源站故障），避免每次点击都重打上游。
      cache.set(key, { at: now(), error });
      throw error;
    }
  })();
  cache.set(key, { ...(hit || {}), promise });
  return promise;
}

async function fetchJson(url, { fetchImpl = fetch, headers = {} } = {}) {
  const response = await fetchImpl(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function exchangePrefix(code) { return String(code).startsWith('5') ? 'sh' : 'sz'; }
const emSecid = (code) => `${exchangePrefix(code) === 'sh' ? 1 : 0}.${code}`;
const inSession = (hhmm) => (hhmm >= '0930' && hhmm <= '1130') || (hhmm >= '1300' && hhmm <= '1500');

/** 腾讯分时（多日）→ 升序有成交的 1m bar：{ t:'YYYY-MM-DD HH:MM', date, close }。 */
export function parseTencentDayMinutes(payload, code) {
  const days = payload?.data?.[`${exchangePrefix(code)}${code}`]?.data;
  if (!Array.isArray(days)) throw new Error('腾讯分时格式异常');
  const bars = [];
  for (const day of [...days].sort((a, b) => String(a?.date).localeCompare(String(b?.date)))) {
    const raw = String(day?.date || '');
    if (!/^\d{8}$/.test(raw)) continue;
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    let prevVolume = 0;
    for (const line of Array.isArray(day?.data) ? day.data : []) {
      const [hhmm, price, volume] = String(line).trim().split(/\s+/);
      const close = Number(price);
      const cumulative = Number(volume);
      const traded = Number.isFinite(cumulative) && cumulative > prevVolume;
      if (traded) prevVolume = cumulative;
      if (!traded || !/^\d{4}$/.test(hhmm || '') || !inSession(hhmm) || !(close > 0)) continue;
      bars.push({ t: `${date} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`, date, close });
    }
  }
  return bars;
}

/** 东财 push2his kline（fields2=f51,f53,f56：时间,收盘,成交量）→ 升序有成交 bar。 */
export function parseEastmoneyKlines(payload) {
  const rows = payload?.data?.klines;
  if (!Array.isArray(rows)) throw new Error('东财 K 线格式异常');
  return rows.map((row) => {
    const [time, close, volume] = String(row).split(',');
    return { t: String(time).slice(0, 16), date: String(time).slice(0, 10), close: Number(close), volume: Number(volume) };
  }).filter((bar) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(bar.t) && bar.close > 0 && bar.volume > 0)
    .map(({ t, date, close }) => ({ t, date, close }));
}

/** market-collector 5m candles → 升序有成交 bar。 */
export function parseCollectorCandles(payload) {
  const candles = payload?.candles;
  if (!Array.isArray(candles)) throw new Error('collector K 线格式异常');
  return candles.map((item) => ({ t: String(item?.time || '').slice(0, 16), close: Number(item?.c), volume: Number(item?.v) }))
    .filter((bar) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(bar.t) && bar.close > 0 && bar.volume > 0)
    .map(({ t, close }) => ({ t, date: t.slice(0, 10), close }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

export function parseNavHistory(payload) {
  const rows = payload?.Datas;
  if (!Array.isArray(rows)) throw new Error('净值历史格式异常');
  return rows.map((row) => ({ date: String(row?.FSRQ || '').slice(0, 10), nav: Number(row?.DWJZ) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.nav > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function firstOk(attempts) {
  const errors = [];
  for (const [source, run] of attempts) {
    try {
      const bars = await run();
      if (bars.length) return { source, bars };
      errors.push(`${source}: 无数据`);
    } catch (error) {
      errors.push(`${source}: ${error?.message || error}`);
    }
  }
  throw Object.assign(new Error(errors.join('；')), { code: 'UPSTREAM_UNAVAILABLE' });
}

/** 取某只 ETF 的 1m / 5m 有成交 bar：{ source, bars }。 */
export function fetchMinuteBars(code, timeframe, { fetchImpl = fetch, now = Date.now } = {}) {
  const tf = timeframe === '5m' ? '5m' : '1m';
  return cached(`kline:${tf}:${code}`, MINUTE_CACHE_TTL_MS[tf], () => {
    const em = (klt, lmt) => async () => parseEastmoneyKlines(await fetchJson(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${emSecid(code)}&fields1=f1&fields2=f51,f53,f56&klt=${klt}&fqt=0&end=20500101&lmt=${lmt}`,
      { fetchImpl }));
    if (tf === '1m') {
      return firstOk([
        ['tencent-day-query', async () => parseTencentDayMinutes(await fetchJson(
          `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${exchangePrefix(code)}${code}`, { fetchImpl }), code)],
        ['eastmoney-klt1', em(1, 1250)]
      ]);
    }
    return firstOk([
      ['market-collector-5m', async () => parseCollectorCandles(await fetchJson(
        `${MARKETS_BASE.replace(/\/+$/, '')}/kline/${code}?tf=5m`, { fetchImpl }))],
      ['eastmoney-klt5', em(5, 960)]
    ]);
  }, now);
}

/** 最近约 40 个单位净值（升序）。 */
export function fetchNavHistory(code, { fetchImpl = fetch, now = Date.now } = {}) {
  return cached(`nav:${code}`, MINUTE_CACHE_TTL_MS.nav, async () => {
    const items = parseNavHistory(await fetchJson(
      `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?FCODE=${code}&pageIndex=1&pagesize=40&deviceid=ai-dca-cn&plat=Android&product=EFund&version=6.5.5`,
      { fetchImpl }));
    if (!items.length) throw Object.assign(new Error(`${code} 无净值历史`), { code: 'UPSTREAM_UNAVAILABLE' });
    return items;
  }, now);
}
