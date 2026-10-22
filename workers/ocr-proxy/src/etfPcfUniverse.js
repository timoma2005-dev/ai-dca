// 深交所 ETF PCF universe 发现与每日全量刷新调度。
//
// 发现策略（plan 决策 (a)+(c)）：每日枚举 159000–159999 全部 1000 个合法代码，用
// HEAD 探测深交所当日 PCF 文件是否存在（HEAD 不支持时有限 GET 替代），与 KV 名单
// etf-pcf-universe:v1 做新增/消失 diff 与校准；发现失败或未完成时降级使用 7 天内
// 已校准旧名单。深交所文件探测是唯一事实来源，KV 名单不是另一个权威源。
//
// 调度：cron 0 1 * * *（UTC 01:00 = 北京时间 09:00）由 index.js 分支调用
// runEtfPcfScheduledRefresh，整个刷新经 ctx.waitUntil 托管：
// 探测发现 → 名单 diff/校准 → 对当日探测有效名单逐项抓取、解析、await 写 KV。
import { mapLimit } from './fundLimit.js';
import {
  isValidEtfPcfCode,
  isWellFormedEtfPcfDateKey,
  shanghaiDateKey,
  buildEtfPcfSourceUrl,
  fetchEtfPcfLimit
} from './etfPcfLimit.js';

export const ETF_PCF_UNIVERSE_KEY = 'etf-pcf-universe:v1';
const ETF_PCF_UNIVERSE_SCHEMA_VERSION = 1;
const ETF_PCF_UNIVERSE_SOURCE = 'szse_pcf_probe';
const ETF_PCF_UNIVERSE_TTL_SECONDS = 7 * 86400;
const ETF_PCF_UNIVERSE_MAX_AGE_MS = 7 * 86400 * 1000;
const ETF_PCF_UNIVERSE_MAX_AGE_SLACK_MS = 60000;

const ETF_PCF_PROBE_CONCURRENCY = 5;
const ETF_PCF_FETCH_CONCURRENCY = 5;
const ETF_PCF_PROBE_TIMEOUT_MS = 5000;
// 整个 job 的软 deadline：12 分钟，留 3 分钟给平台 15 分钟 wall time 汇总。
const ETF_PCF_JOB_DEADLINE_MS = 12 * 60 * 1000;
// 外部请求尝试总上限：正常 1000 探测 + 约 600 抓取；最坏 1000+1000 仍有余量。
const ETF_PCF_REQUEST_BUDGET = 2200;
// 某个 code 连续 5 个「有效校准日」消失才从持久名单移除。
const ETF_PCF_MISSING_REMOVE_THRESHOLD = 5;
// 相较旧名单骤降超过 20% 视为发布/源站异常。
const ETF_PCF_DROP_ANOMALY_RATIO = 0.2;

// ─── 外部请求预算（探测 + 抓取 + 重试共用） ─────────────────────────

export function createEtfPcfRequestBudget(requestLimit = ETF_PCF_REQUEST_BUDGET) {
  return {
    requestCount: 0,
    requestLimit,
    tryAcquire() {
      if (this.requestCount >= this.requestLimit) return false;
      this.requestCount += 1;
      return true;
    }
  };
}

// ─── 候选代码枚举 ──────────────────────────────────────────────────

export function listEtfPcfCandidateCodes() {
  const out = new Array(1000);
  for (let i = 0; i < 1000; i += 1) {
    out[i] = '159' + String(i).padStart(3, '0');
  }
  return out;
}

// ─── 单文件存在性探测（HEAD 优先，405/501 时有限 GET 替代） ──────────

async function cancelProbeBody(resp) {
  try {
    const body = resp && resp.body;
    if (body && typeof body.cancel === 'function') await body.cancel();
  } catch (_e) {
    // ignore
  }
}

function probeHttpErrorReason(status) {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'http_error';
}

function probeTransportError(error, { timedOut, externallyAborted }) {
  if (timedOut) return { status: 'error', reason: 'timeout' };
  if (externallyAborted) return { status: 'error', reason: 'aborted' };
  return { status: 'error', reason: 'fetch_failed' };
}

export async function probeEtfPcfExists({
  code,
  date,
  fetchImpl,
  signal,
  timeoutMs = ETF_PCF_PROBE_TIMEOUT_MS,
  budget,
  preferGet = false,
  style
}) {
  if (!isValidEtfPcfCode(code) || !isWellFormedEtfPcfDateKey(date)) {
    return { status: 'error', reason: 'invalid_params' };
  }
  const sourceUrl = buildEtfPcfSourceUrl(code, date);
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { status: 'error', reason: 'fetch_unavailable' };
  }
  const ctrl = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    externallyAborted = true;
    ctrl.abort();
  };
  let linked = false;
  if (signal) {
    if (signal.aborted) {
      externallyAborted = true;
      ctrl.abort();
    } else if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onExternalAbort);
      linked = true;
    }
  }
  try {
    if (preferGet) return await probeViaGet(fetchFn, sourceUrl, ctrl);
    let resp;
    try {
      // Workers 不支持 redirect:'error'（调用即抛 TypeError）；用 manual，
      // 3xx 由下面的显式分支拒绝，不跟随。
      resp = await fetchFn(sourceUrl, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
    } catch (e) {
      const r = probeTransportError(e, { timedOut, externallyAborted });
      if (r.reason === 'aborted' || r.reason === 'timeout') return r;
      // 个别网关对 HEAD 抛错而非 405，回退 GET 判定（计入预算）。
      if (budget && !budget.tryAcquire()) return { status: 'skipped', reason: 'budget' };
      const viaGet = await probeViaGet(fetchFn, sourceUrl, ctrl);
      if (viaGet.status === 'exists' || viaGet.status === 'not_found') {
        if (style) style.preferGet = true;
      }
      return viaGet;
    }
    if (!resp || typeof resp.status !== 'number') {
      return { status: 'error', reason: 'fetch_failed' };
    }
    if (resp.status === 200) return { status: 'exists' };
    if (resp.status === 404) return { status: 'not_found' };
    if (resp.status === 405 || resp.status === 501) {
      // HEAD 不支持：有限 GET 替代（计入预算），后续探测直接走 GET 避免双探测。
      if (style) style.preferGet = true;
      if (budget && !budget.tryAcquire()) return { status: 'skipped', reason: 'budget' };
      return await probeViaGet(fetchFn, sourceUrl, ctrl);
    }
    if (resp.status >= 300 && resp.status < 400) return { status: 'error', reason: 'http_error' };
    await cancelProbeBody(resp);
    return { status: 'error', reason: probeHttpErrorReason(resp.status) };
  } finally {
    clearTimeout(timer);
    if (linked && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function probeViaGet(fetchFn, sourceUrl, ctrl) {
  let resp;
  try {
    // 同上：Workers 下 'error' 非法，用 manual + 显式 3xx 拒绝。
    resp = await fetchFn(sourceUrl, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
  } catch (e) {
    return { status: 'error', reason: 'fetch_failed' };
  }
  if (!resp || typeof resp.status !== 'number') {
    return { status: 'error', reason: 'fetch_failed' };
  }
  const status = resp.status === 200 ? 'exists' : resp.status === 404 ? 'not_found' : null;
  if (status) {
    await cancelProbeBody(resp);
    return { status };
  }
  if (resp.status >= 300 && resp.status < 400) {
    await cancelProbeBody(resp);
    return { status: 'error', reason: 'http_error' };
  }
  await cancelProbeBody(resp);
  return { status: 'error', reason: probeHttpErrorReason(resp.status) };
}

// ─── KV 名单读取与校验 ─────────────────────────────────────────────

export async function readEtfPcfUniverseEntry({ env }) {
  if (!env || !env.FUND_LIMIT_KV) return { ok: false, reason: 'kv_unavailable' };
  let raw;
  try {
    raw = await env.FUND_LIMIT_KV.get(ETF_PCF_UNIVERSE_KEY);
  } catch (_e) {
    return { ok: false, reason: 'kv_read_failed' };
  }
  if (raw == null) return { ok: false, reason: 'missing' };
  try {
    return { ok: true, entry: JSON.parse(raw) };
  } catch (_e) {
    return { ok: false, reason: 'corrupt' };
  }
}

// 身份、source、时间、形态和计数均校验；未来时间与超龄（> 7 天）均判失效。
export function validateEtfPcfUniverseEntry(entry, { now = new Date() }) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: 'shape' };
  }
  if (entry.schemaVersion !== ETF_PCF_UNIVERSE_SCHEMA_VERSION) return { ok: false, reason: 'schema_version' };
  if (entry.source !== ETF_PCF_UNIVERSE_SOURCE) return { ok: false, reason: 'source' };
  if (!Array.isArray(entry.codes)) return { ok: false, reason: 'codes' };
  const codes = entry.codes;
  if (!codes.every((c) => isValidEtfPcfCode(c))) return { ok: false, reason: 'code_format' };
  // 去重 + 排序形态校验（严格升序即隐含去重）。
  for (let i = 1; i < codes.length; i += 1) {
    if (!(codes[i - 1] < codes[i])) return { ok: false, reason: 'codes_order' };
  }
  if (entry.total !== codes.length) return { ok: false, reason: 'total' };
  if (!entry.entries || typeof entry.entries !== 'object' || Array.isArray(entry.entries)) {
    return { ok: false, reason: 'entries' };
  }
  const entryKeys = Object.keys(entry.entries);
  if (entryKeys.length !== codes.length) return { ok: false, reason: 'entries_count' };
  const codeSet = new Set(codes);
  for (const key of entryKeys) {
    if (!codeSet.has(key)) return { ok: false, reason: 'entries_identity' };
    const item = entry.entries[key];
    if (!item || typeof item !== 'object') return { ok: false, reason: 'entries_shape' };
    if (item.lastSeenDate != null && !isWellFormedEtfPcfDateKey(item.lastSeenDate)) {
      return { ok: false, reason: 'entries_shape' };
    }
    const missing = item.missingCount;
    if (!Number.isSafeInteger(missing) || missing < 0 || missing >= ETF_PCF_MISSING_REMOVE_THRESHOLD) {
      return { ok: false, reason: 'entries_shape' };
    }
  }
  const fetchedAtMs = Date.parse(entry.fetchedAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(fetchedAtMs)) return { ok: false, reason: 'fetched_at' };
  const ageMs = nowMs - fetchedAtMs;
  if (ageMs < -ETF_PCF_UNIVERSE_MAX_AGE_SLACK_MS) return { ok: false, reason: 'future_fetched_at' };
  if (ageMs > ETF_PCF_UNIVERSE_MAX_AGE_MS) return { ok: false, reason: 'expired' };
  if (!isWellFormedEtfPcfDateKey(entry.lastProbeDate)) return { ok: false, reason: 'last_probe_date' };
  return { ok: true, codes, entries: entry.entries, fetchedAt: entry.fetchedAt, ageMs, lastProbeDate: entry.lastProbeDate };
}

// memory/KV 优先读取已校验名单，供日常刷新与发现失败降级；不以缓存替代每日探测。
export async function loadEtfPcfUniverse({ env, now = new Date() }) {
  const read = await readEtfPcfUniverseEntry({ env });
  if (!read.ok) return { ok: false, reason: read.reason };
  const checked = validateEtfPcfUniverseEntry(read.entry, { now });
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return {
    ok: true,
    source: 'kv_universe',
    codes: checked.codes,
    entries: checked.entries,
    fetchedAt: checked.fetchedAt,
    ageMs: checked.ageMs
  };
}

// ─── 每日发现：全部 1000 code 探测 + 名单 diff/校准 ─────────────────

function isTransientProbeReason(reason) {
  return reason === 'timeout' || reason === 'fetch_failed' || reason === 'rate_limited' || reason === 'server_error';
}

export async function discoverEtfPcfUniverse({
  env,
  date,
  concurrency = ETF_PCF_PROBE_CONCURRENCY,
  now = new Date(),
  fetchImpl,
  signal,
  timeoutMs,
  budget,
  deadlineAt
}) {
  if (!isWellFormedEtfPcfDateKey(date)) {
    return { ok: false, status: 400, reason: 'invalid_date', error: '日期必须是合法公历日期，格式 YYYY-MM-DD。' };
  }
  const dateKey = date;
  const candidates = listEtfPcfCandidateCodes();
  const probeStartMs = Date.now();
  // 单个瞬态错误最多额外一次；总重试不超过初始任务数的 10%。
  const retryLimit = Math.floor(candidates.length * 0.1);
  let retriesUsed = 0;
  // 首个 code 确认 HEAD 不被支持后，后续探测直接走 GET，避免每 code 双探测。
  const style = { preferGet: false };

  const results = await mapLimit(candidates, concurrency, async (code) => {
    if (budget && !budget.tryAcquire()) return { code, status: 'skipped', reason: 'budget' };
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      return { code, status: 'skipped', reason: 'deadline' };
    }
    let r = await probeEtfPcfExists({
      code,
      date: dateKey,
      fetchImpl,
      signal,
      timeoutMs,
      budget,
      preferGet: style.preferGet,
      style
    });
    if (r.status === 'error' && isTransientProbeReason(r.reason) && retriesUsed < retryLimit) {
      retriesUsed += 1;
      if (budget && !budget.tryAcquire()) return { code, status: 'skipped', reason: 'budget' };
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        return { code, status: 'skipped', reason: 'deadline' };
      }
      r = await probeEtfPcfExists({
        code,
        date: dateKey,
        fetchImpl,
        signal,
        timeoutMs,
        budget,
        preferGet: style.preferGet,
        style
      });
    }
    return { code, ...r };
  });

  const exists = [];
  let notFound = 0;
  const failed = [];
  const skipped = [];
  for (const r of results) {
    if (r.status === 'exists') exists.push(r.code);
    else if (r.status === 'not_found') notFound += 1;
    else if (r.status === 'skipped') skipped.push(r);
    else failed.push(r);
  }
  exists.sort();
  const stats = {
    probeTotal: candidates.length,
    probeExists: exists.length,
    probeNotFound: notFound,
    probeFailed: failed.length,
    probeSkippedDeadline: skipped.length,
    probeDurationMs: Date.now() - probeStartMs
  };
  // 探测分类合计必须等于 1000。
  const accounted = stats.probeExists + stats.probeNotFound + stats.probeFailed + stats.probeSkippedDeadline;
  if (accounted !== stats.probeTotal) {
    return { ok: false, status: 500, reason: 'probe_accounting_mismatch', error: '探测分类统计不等于 1000。', stats };
  }

  const complete = failed.length === 0 && skipped.length === 0;
  const outcome = {
    ok: true,
    complete,
    codes: exists,
    source: 'szse_pcf_probe',
    date: dateKey,
    stats,
    calibration: { status: complete ? 'pending' : 'incomplete', addedCodes: [], missingCodes: [], removedCodes: [] },
    universeWrite: complete ? 'pending' : 'incomplete'
  };
  if (failed.length > 0) {
    console.log('[etf-pcf] probe failed codes: ' + failed.map((r) => r.code).join(','));
  }
  if (!complete) {
    // 部分结果不得冒充完整名单：不写 universe，不做校准。
    return outcome;
  }

  const oldRead = await readEtfPcfUniverseEntry({ env });
  if (oldRead.reason === 'kv_unavailable' || oldRead.reason === 'kv_read_failed') {
    outcome.calibration = { status: 'kv_read_failed', addedCodes: [], missingCodes: [], removedCodes: [] };
    outcome.universeWrite = 'kv_read_failed';
    return outcome;
  }
  let old = null;
  if (oldRead.ok) {
    const checked = validateEtfPcfUniverseEntry(oldRead.entry, { now });
    // 旧名单损坏按冷启动处理，不做消失计数推断。
    if (checked.ok) old = checked;
  }

  const oldCodes = old ? old.codes : [];
  const oldEntries = old ? old.entries : {};
  const oldCount = oldCodes.length;
  // 非交易日/全量 404，或相较旧名单骤降超过 20%：保留名单、不推进消失计数。
  const allMissing = exists.length === 0;
  const dropAnomaly = oldCount > 0 && exists.length < oldCount * (1 - ETF_PCF_DROP_ANOMALY_RATIO);
  if (allMissing || dropAnomaly) {
    outcome.calibration = { status: 'kept_anomaly', addedCodes: [], missingCodes: [], removedCodes: [] };
    outcome.universeWrite = 'kept_anomaly';
    console.log(
      '[etf-pcf][alert] universe probe anomaly on ' +
        dateKey +
        ' (exists=' +
        exists.length +
        ', old=' +
        oldCount +
        '), keep list and skip missing counters'
    );
    return outcome;
  }

  const existsSet = new Set(exists);
  // 新增 = 当日探测到但旧名单没有；消失 = 旧名单有但当日未探测到。
  const oldSet = new Set(oldCodes);
  const added = exists.filter((c) => !oldSet.has(c));
  const missing = oldCodes.filter((c) => !existsSet.has(c));
  const removedCodes = [];
  const entries = {};
  for (const c of exists) {
    entries[c] = { lastSeenDate: dateKey, missingCount: 0 };
  }
  for (const c of missing) {
    const prev = oldEntries[c] || {};
    const prevCount = Number.isSafeInteger(prev.missingCount) ? prev.missingCount : 0;
    const next = prevCount + 1;
    if (next >= ETF_PCF_MISSING_REMOVE_THRESHOLD) {
      removedCodes.push(c);
    } else {
      entries[c] = { lastSeenDate: prev.lastSeenDate != null ? prev.lastSeenDate : null, missingCount: next };
    }
  }
  const finalCodes = exists.concat(missing.filter((c) => !removedCodes.includes(c))).sort();

  const newEntry = {
    schemaVersion: ETF_PCF_UNIVERSE_SCHEMA_VERSION,
    source: ETF_PCF_UNIVERSE_SOURCE,
    codes: finalCodes,
    total: finalCodes.length,
    fetchedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    lastProbeDate: dateKey,
    entries
  };
  if (env && env.FUND_LIMIT_KV) {
    try {
      await env.FUND_LIMIT_KV.put(ETF_PCF_UNIVERSE_KEY, JSON.stringify(newEntry), {
        expirationTtl: ETF_PCF_UNIVERSE_TTL_SECONDS
      });
      outcome.universeWrite = 'updated';
    } catch (_e) {
      outcome.universeWrite = 'kv_write_failed';
    }
  } else {
    outcome.universeWrite = 'kv_unavailable';
  }
  outcome.calibration = { status: 'updated', addedCodes: added, missingCodes: missing, removedCodes };
  if (added.length > 0) {
    console.log('[etf-pcf][alert] universe added ' + added.length + ' codes on ' + dateKey + ': ' + added.join(','));
  }
  if (missing.length > 0) {
    console.log('[etf-pcf][alert] universe missing ' + missing.length + ' codes on ' + dateKey + ': ' + missing.join(','));
  }
  if (removedCodes.length > 0) {
    console.log('[etf-pcf][alert] universe removed ' + removedCodes.length + ' codes on ' + dateKey + ': ' + removedCodes.join(','));
  }
  return outcome;
}

// ─── 批量刷新（逐项抓取、解析、await 写 KV；失败隔离） ────────────────

function classifyRefreshResult(r) {
  if (r && r.ok) return 'success';
  const reason = r && r.reason;
  if (reason === 'upstream_not_found') return 'notFound';
  if (reason === 'parse_failed' || reason === 'decode_failed') return 'parseFailed';
  if (reason === 'kv_write_failed' || reason === 'kv_unavailable') return 'kvWriteFailed';
  return 'fetchFailed'; // timeout / http_error / fetch_failed / aborted / invalid_params
}

function isTransientFetchResult(r) {
  if (!r) return false;
  if (r.reason === 'timeout' || r.reason === 'fetch_failed') return true;
  if (r.reason === 'http_error' && (r.httpStatus >= 500 || r.httpStatus === 429)) return true;
  return false;
}

// codes 省略时从 KV 名单读取（日常非发现刷新）；404、解码、解析错误不重试。
export async function refreshEtfPcfLimitCache({
  env,
  date,
  codes,
  concurrency = ETF_PCF_FETCH_CONCURRENCY,
  now = new Date(),
  fetchImpl,
  signal,
  timeoutMs,
  budget,
  deadlineAt,
  onSuccess
}) {
  if (!isWellFormedEtfPcfDateKey(date)) {
    return { ok: false, status: 400, reason: 'invalid_date', error: '日期必须是合法公历日期，格式 YYYY-MM-DD。' };
  }
  const todayKey = shanghaiDateKey(now);
  if (date > todayKey) {
    return { ok: false, status: 400, reason: 'invalid_date', error: '日期不能晚于上海当天。' };
  }
  let targets = null;
  let universeSourceAge = null;
  if (codes === undefined || codes === null) {
    const universe = await loadEtfPcfUniverse({ env, now });
    if (!universe.ok) {
      return { ok: false, status: 503, reason: 'universe_unavailable:' + universe.reason, error: 'ETF PCF 名单不可用。' };
    }
    targets = universe.codes.slice();
    universeSourceAge = universe.ageMs;
  } else {
    if (!Array.isArray(codes)) {
      return { ok: false, status: 400, reason: 'invalid_codes', error: 'codes 必须是数组。' };
    }
    const seen = new Set();
    targets = [];
    for (const c of codes) {
      if (isValidEtfPcfCode(c) && !seen.has(c)) {
        seen.add(c);
        targets.push(c);
      }
    }
    targets.sort();
  }

  const fetchStartMs = Date.now();
  const retryLimit = Math.floor(targets.length * 0.1);
  let retriesUsed = 0;
  const results = await mapLimit(targets, concurrency, async (code) => {
    if (budget && !budget.tryAcquire()) return { code, bucket: 'skippedDeadline', reason: 'budget' };
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      return { code, bucket: 'skippedDeadline', reason: 'deadline' };
    }
    let r = await fetchEtfPcfLimit({
      code,
      date,
      env,
      forceRefresh: true,
      now,
      fetchImpl,
      signal,
      timeoutMs
    });
    if (!r.ok && isTransientFetchResult(r) && retriesUsed < retryLimit) {
      retriesUsed += 1;
      if (budget && !budget.tryAcquire()) return { code, bucket: 'skippedDeadline', reason: 'budget' };
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        return { code, bucket: 'skippedDeadline', reason: 'deadline' };
      }
      r = await fetchEtfPcfLimit({
        code,
        date,
        env,
        forceRefresh: true,
        now,
        fetchImpl,
        signal,
        timeoutMs
      });
    }
    if (r.ok && onSuccess) { try { await onSuccess(r.data); } catch (_e) { /* 收集失败不影响行情入库 */ } }
    return { code, bucket: classifyRefreshResult(r), reason: r && r.reason };
  });

  const buckets = { success: 0, notFound: 0, fetchFailed: 0, parseFailed: 0, kvWriteFailed: 0, skippedDeadline: 0 };
  const failures = [];
  for (const r of results) {
    buckets[r.bucket] += 1;
    if (r.bucket !== 'success' && r.bucket !== 'notFound') {
      failures.push({ code: r.code, bucket: r.bucket, reason: r.reason });
    }
  }
  const accounted =
    buckets.success + buckets.notFound + buckets.fetchFailed + buckets.parseFailed + buckets.kvWriteFailed + buckets.skippedDeadline;
  if (accounted !== targets.length) {
    return { ok: false, status: 500, reason: 'refresh_accounting_mismatch', error: '抓取分类统计不等于 total。' };
  }
  return {
    ok: true,
    universeSourceAge,
    stats: {
      total: targets.length,
      success: buckets.success,
      notFound: buckets.notFound,
      fetchFailed: buckets.fetchFailed,
      parseFailed: buckets.parseFailed,
      kvWriteFailed: buckets.kvWriteFailed,
      skippedDeadline: buckets.skippedDeadline,
      durationMs: Date.now() - fetchStartMs
    },
    failures
  };
}

// ─── cron 编排：探测 → 名单校准 → 逐项刷新 ─────────────────────────

export async function runEtfPcfScheduledRefresh({
  env,
  scheduledTime,
  fetchImpl,
  timeoutMs,
  concurrency = ETF_PCF_FETCH_CONCURRENCY,
  deadlineMs = ETF_PCF_JOB_DEADLINE_MS,
  requestLimit = ETF_PCF_REQUEST_BUDGET,
  onSuccess,
  // 指定代码时只抓这些代码的 PCF，跳过全市场探测与名单校准（cron 只需要目标 ETF）。
  codes = null
}) {
  const startMs = Date.now();
  const targetedCodes = Array.isArray(codes) && codes.length > 0 ? [...new Set(codes.map(String))].sort() : null;
  const emptyFetchStats = {
    total: 0,
    success: 0,
    notFound: 0,
    fetchFailed: 0,
    parseFailed: 0,
    kvWriteFailed: 0,
    skippedDeadline: 0,
    durationMs: 0
  };
  if (!Number.isFinite(scheduledTime)) {
    return {
      ok: false,
      reason: 'invalid_scheduled_time',
      date: null,
      degraded: false,
      universeSourceAge: null,
      fallbackStatus: 'invalid_scheduled_time',
      ...emptyFetchStats
    };
  }
  // 用 scheduledTime 换算上海业务日期，避免执行延迟导致的跨日漂移。
  const dateKey = shanghaiDateKey(new Date(scheduledTime));
  const now = new Date(scheduledTime);
  const budget = createEtfPcfRequestBudget(requestLimit);
  const deadlineAt = startMs + deadlineMs;
  const jobCtrl = new AbortController();
  const deadlineTimer = setTimeout(() => {
    try {
      jobCtrl.abort();
    } catch (_e) {
      // ignore
    }
  }, deadlineMs);

  let discovery;
  let fetchStats = emptyFetchStats;
  let failures = [];
  let degraded = false;
  let universeSourceAge = null;
  let fallbackStatus = null;
  let fetchCodes = null;
  try {
    if (targetedCodes) {
      fetchCodes = targetedCodes;
    } else try {
      discovery = await discoverEtfPcfUniverse({
        env,
        date: dateKey,
        concurrency,
        now,
        fetchImpl,
        signal: jobCtrl.signal,
        timeoutMs,
        budget,
        deadlineAt
      });
    } catch (e) {
      clearTimeout(deadlineTimer);
      return {
        ok: false,
        reason: 'discovery_error',
        error: (e && e.message) || String(e),
        date: dateKey,
        degraded: false,
        universeSourceAge: null,
        fallbackStatus: 'discovery_error',
        ...emptyFetchStats
      };
    }

    if (targetedCodes) {
      // 已指定代码，直接抓取
    } else if (discovery && discovery.ok && discovery.complete) {
      fetchCodes = discovery.codes;
    } else {
      // 发现失败/未完成：仅在剩余预算允许时降级使用上一有效 KV 名单。
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs > 0 && budget.requestCount < budget.requestLimit) {
        const universe = await loadEtfPcfUniverse({ env, now: new Date() });
        if (universe.ok) {
          fetchCodes = universe.codes;
          degraded = true;
          universeSourceAge = universe.ageMs;
          fallbackStatus = 'used_kv_universe';
        } else {
          fallbackStatus = 'kv_universe_unavailable:' + universe.reason;
        }
      } else {
        fallbackStatus = 'skipped_no_budget';
      }
    }

    if (fetchCodes && fetchCodes.length > 0) {
      const refreshed = await refreshEtfPcfLimitCache({
        env,
        date: dateKey,
        codes: fetchCodes,
        concurrency,
        now,
        fetchImpl,
        signal: jobCtrl.signal,
        timeoutMs,
        budget,
        deadlineAt,
        onSuccess
      });
      if (refreshed.ok) {
        fetchStats = refreshed.stats;
        failures = refreshed.failures || [];
        if (universeSourceAge == null) universeSourceAge = refreshed.universeSourceAge;
      } else {
        clearTimeout(deadlineTimer);
        return {
          ok: false,
          reason: refreshed.reason,
          error: refreshed.error,
          date: dateKey,
          degraded,
          universeSourceAge,
          fallbackStatus,
          ...emptyFetchStats
        };
      }
    } else if (fetchCodes && fetchCodes.length === 0) {
      // 全量 404（kept_anomaly）：当日无有效文件，跳过抓取属正常。
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  const discoveryComplete = !!(discovery && discovery.ok && discovery.complete);
  const result = {
    ok: discoveryComplete || degraded || !!targetedCodes,
    targeted: !!targetedCodes,
    date: dateKey,
    probeTotal: discovery && discovery.stats ? discovery.stats.probeTotal : 0,
    probeExists: discovery && discovery.stats ? discovery.stats.probeExists : 0,
    probeNotFound: discovery && discovery.stats ? discovery.stats.probeNotFound : 0,
    probeFailed: discovery && discovery.stats ? discovery.stats.probeFailed : 0,
    probeSkippedDeadline: discovery && discovery.stats ? discovery.stats.probeSkippedDeadline : 0,
    probeDurationMs: discovery && discovery.stats ? discovery.stats.probeDurationMs : 0,
    addedCodes: discovery && discovery.calibration ? discovery.calibration.addedCodes : [],
    missingCodes: discovery && discovery.calibration ? discovery.calibration.missingCodes : [],
    removedCodes: discovery && discovery.calibration ? discovery.calibration.removedCodes : [],
    degraded,
    universeSourceAge,
    universeWrite: discovery && discovery.universeWrite ? discovery.universeWrite : null,
    fallbackStatus,
    ...fetchStats,
    failures,
    jobDurationMs: Date.now() - startMs
  };
  if (!discoveryComplete && !degraded && !targetedCodes) {
    result.ok = false;
    result.reason = 'universe_discovery_incomplete';
  }
  console.log(
    '[etf-pcf] scheduled refresh ' +
      dateKey +
      ' probe=' +
      result.probeExists +
      '/' +
      result.probeTotal +
      ' failed=' +
      result.probeFailed +
      ' fetch success=' +
      result.success +
      '/' +
      result.total +
      ' notFound=' +
      result.notFound +
      ' parseFailed=' +
      result.parseFailed +
      ' kvWriteFailed=' +
      result.kvWriteFailed +
      ' skipped=' +
      result.skippedDeadline +
      ' degraded=' +
      degraded +
      ' durationMs=' +
      result.jobDurationMs
  );
  return result;
}
