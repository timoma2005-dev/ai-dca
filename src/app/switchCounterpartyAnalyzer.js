import { apiUrl } from './apiBase.js';
import { NASDAQ_ETFS } from './nasdaqCatalog.js';

export const DEFAULT_AUTO_LOWER_PCT = 1;
export const DEFAULT_AUTO_UPPER_PCT = 3;

const HISTORY_TTL_MS = 60 * 60 * 1000;
const historyCache = new Map();
const names = new Map(NASDAQ_ETFS.map(({ code, name }) => [code, name]));

export function clearCounterpartyHistoryCache() {
  historyCache.clear();
}

export function defaultCounterpartyPool(holdingCode) {
  return NASDAQ_ETFS.map(({ code }) => code)
    .filter((code) => /^\d{6}$/.test(code) && code !== holdingCode)
    .slice(0, 14);
}

async function fetchHistory(code) {
  const cached = historyCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) return cached.points;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(apiUrl(`/api/market-collector/premium/${code}?interval=1d&limit=180`), {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Array.isArray(payload?.points)
      || (payload.symbol != null && payload.symbol !== code)
      || (payload.interval != null && payload.interval !== '1d')) return null;
    const points = payload.points
      .filter((point) => Number.isFinite(point?.premiumPercent)
        && typeof point?.date === 'string' && point.date.trim())
      .map(({ date, premiumPercent }) => ({ date: date.trim(), premiumPercent }));
    historyCache.set(code, { fetchedAt: Date.now(), points });
    return points;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function backtestSpread(spread, { lowerPct = DEFAULT_AUTO_LOWER_PCT, upperPct = DEFAULT_AUTO_UPPER_PCT } = {}) {
  let entry = null;
  let trades = 0;
  let roundTrips = 0;
  let pnl = 0;
  for (const value of spread) {
    if (!Number.isFinite(value)) continue;
    if (entry === null && value < lowerPct) {
      entry = value;
      trades += 1;
    } else if (entry !== null && value > upperPct) {
      pnl += value - entry;
      entry = null;
      roundTrips += 1;
      trades += 1;
    }
  }
  return { trades, roundTrips, returnPct: pnl - trades * 0.1 };
}

export async function analyzeCounterparties(holdingCode, candidateCodes, {
  lowerPct = DEFAULT_AUTO_LOWER_PCT,
  upperPct = DEFAULT_AUTO_UPPER_PCT
} = {}) {
  const codes = [...new Set(candidateCodes)].filter((code) => code !== holdingCode);
  const [holding, ...histories] = await Promise.all([holdingCode, ...codes].map(fetchHistory));
  if (!holding || holding.length < 60) return [];
  const holdingByDate = new Map(holding.map(({ date, premiumPercent }) => [date, premiumPercent]));
  const ranked = [];
  histories.forEach((points, index) => {
    if (!points) return;
    const candidateByDate = new Map(points.map(({ date, premiumPercent }) => [date, premiumPercent]));
    const spread = [...holdingByDate.keys()]
      .filter((date) => candidateByDate.has(date))
      .sort()
      .map((date) => candidateByDate.get(date) - holdingByDate.get(date));
    const alignedCount = spread.length;
    if (alignedCount < 60) return;
    const meanSpread = spread.reduce((sum, value) => sum + value, 0) / alignedCount;
    const volatility = Math.sqrt(spread.reduce((sum, value) => sum + (value - meanSpread) ** 2, 0) / alignedCount);
    const crossingCount = spread.reduce((count, value, i) => (
      count + (i > 0 && (value - meanSpread) * (spread[i - 1] - meanSpread) < 0 ? 1 : 0)
    ), 0);
    const holdingIsLow = meanSpread >= 0;
    const hlSpread = holdingIsLow ? spread : spread.map((value) => -value);
    const { trades, roundTrips, returnPct } = backtestSpread(hlSpread, { lowerPct, upperPct });
    if (roundTrips < 1) return;
    const code = codes[index];
    ranked.push({ code, name: names.get(code) || '', meanSpread, volatility, crossingCount, alignedCount, trades, roundTrips, returnPct });
  });
  return ranked.sort((a, b) => b.returnPct - a.returnPct);
}

export async function selectBestCounterparty(holdingCode, candidateCodes = defaultCounterpartyPool(holdingCode), options = {}) {
  const [best] = await analyzeCounterparties(holdingCode, candidateCodes, options);
  if (!best) return null;
  const { code, name, ...stats } = best;
  return { code, name, stats };
}
