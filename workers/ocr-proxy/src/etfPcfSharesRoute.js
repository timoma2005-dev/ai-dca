import { jsonResponse } from './ocrHttp.js';
import {
  buildEtfPcfCacheKey,
  isWellFormedEtfPcfDateKey,
  shanghaiDateKey,
  validateEtfPcfCachedData,
  validateEtfPcfHistoryData
} from './etfPcfLimit.js';
import { mapLimit } from './fundLimit.js';
import { sharesKey, validSharesPointer, validateSharesProjection } from './etfPcfSharesProjection.js';

// PCF dates describe the snapshot, while share dates continue to describe the measured balances.
async function readPcfSnapshot(kv, records, date, now) {
  const validate = date < shanghaiDateKey(now) ? validateEtfPcfHistoryData : validateEtfPcfCachedData;
  const codes = records.filter((r) => r.code.startsWith('159')).map((r) => r.code);
  const results = await mapLimit(codes, 4, async (code) => {
    try {
      const raw = await kv.get(buildEtfPcfCacheKey(code, date));
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return validate(data, { code, date, now }).ok ? code : null;
    } catch {
      return null;
    }
  });
  const verifiedCodes = results.filter((code) => typeof code === 'string');
  return verifiedCodes.length ? { source: 'szse_pcf', date, codes: verifiedCodes } : null;
}
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
  const pcfSnapshot = await readPcfSnapshot(
    kv,
    data.records,
    query === 'latest' ? shanghaiDateKey(now) : date,
    now
  );
  // 名称统一用行情名称（腾讯行情，与 ai-dca-markets 的 tencent-quote 一致）；
  // 交易所规模接口给的是简称（如 513300「纳斯达克」），原值保留在 exchangeName。
  // env.ETF_NAME_LOOKUP = 'off' 可关闭（测试用）。
  const names =
    env?.ETF_NAME_LOOKUP === 'off' ? {} : await readEtfQuoteNames(kv, (data.records || []).map((r) => r?.code));
  const records = (data.records || []).map((r) =>
    r && names[r.code] && names[r.code] !== r.name ? { ...r, name: names[r.code], exchangeName: r.name } : r
  );
  return jsonResponse(
    Object.keys(names).length ? { ...data, records, nameSource: 'tencent_quote', pcfSnapshot } : { ...data, pcfSnapshot },
    200,
    headers
  );
}

const ETF_NAME_KV_KEY = 'etf-pcf-names:v1';
const ETF_NAME_TTL_SECONDS = 24 * 60 * 60;
function etfTencentSymbol(code) {
  const d = String(code || '').trim();
  if (!/^\d{6}$/.test(d)) return '';
  return (d.startsWith('5') || d.startsWith('6') ? 'sh' : 'sz') + d;
}
export async function fetchEtfTencentNames(codes, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const syms = codes.map(etfTencentSymbol).filter(Boolean);
  if (!syms.length) return {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://qt.gtimg.cn/?q=' + syms.join(','), {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://gu.qq.com/' },
      signal: ctl.signal,
      cf: { cacheTtl: 300 }
    });
    if (!res.ok) return {};
    const buf = await res.arrayBuffer();
    let text;
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      text = new TextDecoder().decode(buf);
    }
    const out = {};
    const re = /v_([^=]+)="([^"]*)";?/g;
    let m;
    while ((m = re.exec(text))) {
      const f = String(m[2] || '').split('~');
      const code = String(f[2] || '').trim();
      const name = String(f[1] || '').trim();
      if (/^\d{6}$/.test(code) && name) out[code] = name;
    }
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
export async function readEtfQuoteNames(kv, codes = [], options = {}) {
  const want = Array.from(new Set(codes.filter((c) => /^\d{6}$/.test(String(c || '')))));
  if (!want.length) return {};
  let cached = null;
  try {
    cached = await kv.get(ETF_NAME_KV_KEY, 'json');
  } catch {
    /* KV 读失败按未缓存处理 */
  }
  const map = cached && typeof cached.names === 'object' && cached.names ? { ...cached.names } : {};
  const missing = want.filter((c) => !map[c]);
  if (missing.length) {
    const fresh = await fetchEtfTencentNames(missing, options);
    if (Object.keys(fresh).length) {
      Object.assign(map, fresh);
      try {
        await kv.put(ETF_NAME_KV_KEY, JSON.stringify({ names: map, updatedAt: new Date().toISOString() }), {
          expirationTtl: ETF_NAME_TTL_SECONDS
        });
      } catch {
        /* 缓存写失败不影响返回 */
      }
    }
  }
  const out = {};
  for (const c of want) if (map[c]) out[c] = map[c];
  return out;
}
