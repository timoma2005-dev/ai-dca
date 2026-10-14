import { jsonResponse } from './ocrHttp.js';
import { isWellFormedEtfPcfDateKey, shanghaiDateKey } from './etfPcfLimit.js';
import { sharesKey, validSharesPointer, validateSharesProjection } from './etfPcfSharesProjection.js';
export async function handleEtfPcfShares(
  request,
  env,
  _ctx,
  params = new URLSearchParams(),
  now = new Date()
) {
  const headers = { 'cache-control': 'no-store', allow: 'GET, OPTIONS' };
  let date = null;
  const error = (reason, status) => jsonResponse({ error: reason, reason, date }, status, headers);
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS'
      }
    });
  if (request.method !== 'GET') return error('method_not_allowed', 405);
  for (const key of params.keys()) if (key !== 'date') return error('unsupported_query_param', 400);
  if (params.getAll('date').length > 1) return error('duplicate_query_param', 400);
  const query = params.has('date') ? params.get('date') : 'latest';
  if (query !== 'latest') {
    date = query;
    if (!isWellFormedEtfPcfDateKey(date) || date < '2000-01-01' || date > shanghaiDateKey(now))
      return error('invalid_date', 400);
  }
  const kv = env?.FUND_LIMIT_KV;
  if (!kv) return error('kv_unavailable', 503);
  let pointer, data;
  const parse = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw);
  const get = async (key) => {
    let raw;
    try {
      raw = await kv.get(key);
    } catch {
      throw Error('kv_read_failed');
    }
    try {
      return parse(raw);
    } catch {
      return null;
    }
  };
  try {
    if (query === 'latest') {
      pointer = await get('etf-pcf-shares:latest');
      if (!validSharesPointer(pointer, now)) return error('cache_miss', 404);
      date = pointer.date;
    }
    data = await get(sharesKey(date));
  } catch {
    return error('kv_read_failed', 503);
  }
  if (
    !validateSharesProjection(data, { date, now }) ||
    (pointer && (pointer.fetchedAt !== data.fetchedAt || pointer.expiresAt !== data.expiresAt))
  )
    return error('cache_miss', 404);
  return jsonResponse(data, 200, headers);
}
