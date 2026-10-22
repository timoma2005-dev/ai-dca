import { eventKey, validateEventLog } from './etfPcfEvents.js';
import { isWellFormedEtfPcfDateKey, shanghaiDateKey } from './etfPcfLimit.js';
// ETF PCF 申赎限额路由：GET 只读缓存（绝不抓取上游），POST 单 code 手动刷新。
// 按 code 前缀分发：159xxx 走深交所，513100/513110/513300/513390/513870 走上交所，
// 其它合法 51xxxx 明确 404 unsupported_code（未覆盖，不触发外部请求与 KV），
// 其余前缀/非法 code 维持既有 400。客户端不控制 forceRefresh，也不支持 codes 数组批量刷新。
import { jsonResponse } from './util.js';
import { readEtfPcfLimitCache, fetchEtfPcfLimit, validateEtfPcfRequest } from './etfPcfLimit.js';
import {
  SSE_PCF_CODES,
  readSsePcfLimitCache,
  fetchSsePcfLimit,
  validateSsePcfRequest
} from './ssePcfLimit.js';

const SSE_PCF_CODE_SET = new Set(SSE_PCF_CODES);

function methodNotAllowedResponse() {
  return jsonResponse({ error: 'Method not allowed' }, 405, { allow: 'GET, POST, OPTIONS' });
}

function errorPayload(result, code, date) {
  const payload = { error: result.error, reason: result.reason };
  if (code !== undefined) payload.code = code;
  if (date !== undefined) payload.date = date;
  return payload;
}

function unsupportedCodeResponse(code, date) {
  return jsonResponse(
    {
      error: '该上交所 ETF 代码当前未覆盖，支持的沪市代码：' + SSE_PCF_CODES.join('/') + '。',
      reason: 'unsupported_code',
      code,
      date: date ?? null
    },
    404
  );
}

// code 分发：先做「六位数字字符串」的通用格式判断，再按前缀选市场，避免把 51xxxx
// 交给仅接受 159xxx 的深交所 validator。名单外 51xxxx 直接 404；格式非法或其它前缀
// 交由深交所 validator 产生与既有行为完全一致的 400（含错误文案与校验顺序）。
function classifyEtfPcfCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return 'invalid';
  if (/^159\d{3}$/.test(code)) return 'szse';
  if (/^51\d{4}$/.test(code)) return SSE_PCF_CODE_SET.has(code) ? 'sse' : 'unsupported_sse';
  return 'invalid';
}

export async function handleEtfPcfLimit(
  request,
  env,
  _ctx,
  searchParams = new URLSearchParams(),
  now = new Date()
) {
  if (request.method === 'GET') {
    // 重复 code/date query 参数直接 400，不做「取第一个」的洗白。
    if (searchParams.getAll('code').length > 1 || searchParams.getAll('date').length > 1) {
      return jsonResponse({ error: 'code/date 查询参数只能出现一次。', reason: 'duplicate_query_param' }, 400);
    }
    const rawCode = searchParams.get('code');
    // date 参数缺省（而不是空串）才默认上海当天。
    const rawDate = searchParams.has('date') ? searchParams.get('date') : undefined;
    if (rawCode == null || rawCode === '') {
      return jsonResponse({ error: '缺少 code 查询参数。', reason: 'missing_code' }, 400);
    }
    const market = classifyEtfPcfCode(rawCode);
    if (market === 'unsupported_sse') {
      return unsupportedCodeResponse(rawCode, rawDate);
    }
    const v = (market === 'sse' ? validateSsePcfRequest : validateEtfPcfRequest)({
      code: rawCode,
      date: rawDate,
      now
    });
    if (!v.ok) {
      return jsonResponse({ error: v.error, reason: v.reason, code: rawCode, date: rawDate ?? null }, 400);
    }
    // refresh=1 / force=1 一律忽略：GET 任何缓存状态都不触发外部请求。
    const readCache = market === 'sse' ? readSsePcfLimitCache : readEtfPcfLimitCache;
    const result = await readCache({ code: v.code, date: v.date, env, now });
    if (result.ok) {
      return jsonResponse(result.data);
    }
    return jsonResponse(errorPayload(result, v.code, v.date), result.status || 503);
  }

  if (request.method === 'POST') {
    let payload;
    try {
      payload = await request.json();
    } catch (_e) {
      return jsonResponse({ error: '请求体必须是合法 JSON 对象。', reason: 'invalid_json' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse({ error: '请求体必须是 JSON 对象。', reason: 'invalid_body' }, 400);
    }
    if (Array.isArray(payload.codes)) {
      return jsonResponse({ error: 'ETF PCF 手动刷新一次只能提交一个 code。', reason: 'batch_unsupported' }, 400);
    }
    const rawCode = payload.code;
    const rawDate = Object.prototype.hasOwnProperty.call(payload, 'date') ? payload.date : undefined;
    const market = classifyEtfPcfCode(rawCode);
    if (market === 'unsupported_sse') {
      return unsupportedCodeResponse(rawCode, rawDate);
    }
    const v = (market === 'sse' ? validateSsePcfRequest : validateEtfPcfRequest)({
      code: rawCode,
      date: rawDate,
      now
    });
    if (!v.ok) {
      return jsonResponse(
        { error: v.error, reason: v.reason, code: rawCode ?? null, date: rawDate ?? null },
        400
      );
    }
    if (market === 'sse') {
      // SSE 的 date 是「期望源站返回的清单日期」：缺省时保留缺省语义（抓最新清单，
      // 用接口 TRADING_DAY 入库，不以上海当天替代），指定时与 TRADING_DAY 核对，
      // 不一致 404 且不写 KV。
      const result = await fetchSsePcfLimit({
        code: v.code,
        date: v.dateDefaulted ? undefined : v.date,
        env,
        forceRefresh: true,
        now
      });
      if (result.ok) {
        return jsonResponse(result.data);
      }
      return jsonResponse(errorPayload(result, v.code, v.date), result.status || 502);
    }
    const result = await fetchEtfPcfLimit({ code: v.code, date: v.date, env, forceRefresh: true, now });
    if (result.ok) {
      return jsonResponse(result.data);
    }
    return jsonResponse(errorPayload(result, v.code, v.date), result.status || 502);
  }

  return methodNotAllowedResponse();
}

// 事件查询严格只读：不支持 refresh/force，不回源、不补写。
export async function handleEtfPcfEvents(request, env, _ctx, params = new URLSearchParams(), now = new Date()) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, { allow: 'GET, OPTIONS' });
  if (params.getAll('date').length > 1) return jsonResponse({ error: 'date 查询参数只能出现一次。', reason: 'duplicate_query_param' }, 400);
  const date = params.has('date') ? params.get('date') : shanghaiDateKey(now);
  if (!isWellFormedEtfPcfDateKey(date) || date < '2000-01-01' || date > shanghaiDateKey(now)) return jsonResponse({ error: '日期必须为合法历史日期。', reason: 'invalid_date' }, 400);
  if (!env?.FUND_LIMIT_KV) return jsonResponse({ error: '事件缓存不可用。', reason: 'kv_unavailable' }, 503);
  let raw;
  try { raw = await env.FUND_LIMIT_KV.get(eventKey(date)); } catch (_e) { return jsonResponse({ error: '事件缓存读取失败。', reason: 'kv_read_failed' }, 503); }
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_e) { /* 损坏缓存按 miss 返回 */ }
  if (!validateEventLog(data, date)) return jsonResponse({ error: '事件缓存未命中。', reason: 'cache_miss', date }, 404);
  return jsonResponse(data);
}
