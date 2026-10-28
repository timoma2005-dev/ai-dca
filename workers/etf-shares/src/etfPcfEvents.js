import { confirmedSharesCalendar, isCompleteSharesCalendar } from '../../../shared/etfPcfTradingCalendar.js';
import {
  buildSharesProjection,
  persistSharesProjection,
  normalizeCreationStatus,
  previousSession
} from './etfPcfSharesProjection.js';
import { buildSsePcfCacheKey, validateSsePcfCachedData } from './ssePcfLimit.js';
import {
  isWellFormedEtfPcfDateKey,
  shanghaiDateKey,
  validateEtfPcfCachedData,
  validateEtfPcfHistoryData,
  buildEtfPcfCacheKey
} from './etfPcfLimit.js';
import { mapLimit } from './util.js';
import {
  TARGET_CODES,
  CURRENT_SHARES_URL,
  historicalSharesUrl,
  fetchEtfPcfShares,
  fetchSseEtfShares,
  parseEtfPcfSharesXlsx
} from './etfPcfShares.js';
const EVENT_CODES = TARGET_CODES.filter((code) => code.startsWith('159'));
// 方案 B 阶段预算：历史快照/单条回退 ≤40%，shares 下载累计 ≤80%，剩余 ≥20% 预留给
// 快照与事件日志持久化及 shares projection，读取和下载不再挤占全部 deadline。
const HISTORY_BUDGET_SHARE = 0.4,
  SHARES_BUDGET_SHARE = 0.8;
// 单条 PCF fallback：仅限日历确认的交易日（日历不可用时保留全窗口），mapLimit 并发 3，
// 单次运行总读取上限 64（≈8 个交易日 × 8 只），超限或超出历史预算立即停止分配。
export const ETF_PCF_FALLBACK_CONCURRENCY = 3;
export const ETF_PCF_FALLBACK_MAX_READS = 64;
const validLimit = (x) =>
  !!x &&
  ['limited', 'unlimited', 'unknown'].includes(x.kind) &&
  (x.kind === 'limited' ? Number.isSafeInteger(x.shares) && x.shares >= 0 : x.shares === null);
const known = (x) => validLimit(x) && x.kind !== 'unknown';
const result = (input, type, basis, status = 'ok', reason, extra = {}) => ({
  event: null,
  check: {
    code: input.code,
    date: input.date,
    signal_type: type,
    basis,
    prev_date: input.prev_date,
    status,
    ...(reason ? { reason } : {}),
    ...extra
  }
});
export function limitRelaxation(input) {
  const { prev, cur, basis } = input,
    r = result(input, 'limit_relaxation', basis);
  if (!known(prev) || !known(cur))
    return result(input, 'limit_relaxation', basis, 'unknown', 'invalid_limit');
  let ratio = null,
    extra = {};
  if (prev.kind === 'unlimited') {
    if (cur.kind === 'limited') r.check.reason = 'tightening';
    return r;
  }
  if (cur.kind === 'unlimited') extra = { ratio_kind: 'unbounded', transition: 'to_unlimited', tier: 'unlimited' };
  else {
    if (prev.shares === 0)
      return cur.shares === 0 ? r : result(input, 'limit_relaxation', basis, 'unknown', 'zero_denominator');
    ratio = cur.shares / prev.shares;
    if (ratio < 5) return r;
    extra.tier = ratio >= 10 ? '10x' : '5x';
  }
  r.event = {
    signal_type: 'limit_relaxation',
    code: input.code,
    date: input.date,
    basis,
    prev,
    cur,
    ratio,
    prev_date: input.prev_date,
    when_detected: input.when_detected,
    ...extra
  };
  return r;
}
export function netCreationNearTotalLimit(input) {
  const { netCreation, totalLimit } = input,
    type = 'net_creation_near_total_limit';
  if (!known(totalLimit)) return result(input, type, 'total', 'unknown', 'invalid_total_limit');
  if (totalLimit.kind === 'unlimited') return result(input, type, 'total', 'skip', 'unlimited_total_limit');
  if (!totalLimit.shares || !Number.isSafeInteger(netCreation))
    return result(input, type, 'total', 'unknown', 'invalid_input');
  if (netCreation < 0) return result(input, type, 'total', 'skip', 'negative_net_creation');
  const r = result(input, type, 'total'),
    ratio = netCreation / totalLimit.shares;
  if (ratio >= 0.9)
    r.event = {
      signal_type: type,
      code: input.code,
      date: input.date,
      basis: 'total',
      prev_date: input.prev_date,
      when_detected: input.when_detected,
      netCreation,
      totalLimit,
      ratio
    };
  return r;
}
export function eventKey(date, type) {
  if (
    !isWellFormedEtfPcfDateKey(date) ||
    date < '2000-01-01' ||
    (type !== undefined && !['limits', 'shares'].includes(type))
  )
    throw Error('invalid_event_key');
  return `etf-pcf-events${type ? '-' + type : ''}:${date.replaceAll('-', '')}`;
}
const day = (date, n) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
export function selectPreviousDate(date, candidates, evidence = []) {
  if (!isWellFormedEtfPcfDateKey(date)) return null;
  return (
    candidates
      .filter((d) => isWellFormedEtfPcfDateKey(d) && d >= day(date, -10) && d < date && evidence.includes(d))
      .sort()
      .at(-1) || null
  );
}
const id = (e) => [e.date, e.code, e.signal_type, e.basis].join(':');
const stamp = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s));
const identity = (e) =>
  e &&
  EVENT_CODES.includes(e.code) &&
  isWellFormedEtfPcfDateKey(e.date) &&
  ['limit_relaxation', 'net_creation_near_total_limit'].includes(e.signal_type) &&
  ['net', 'total'].includes(e.basis) &&
  (e.signal_type !== 'net_creation_near_total_limit' || e.basis === 'total');
export function validateEventLog(log, date) {
  if (
    !log ||
    log.schemaVersion !== 1 ||
    log.source !== 'szse_pcf_events' ||
    log.date !== date ||
    !isWellFormedEtfPcfDateKey(date) ||
    !Array.isArray(log.events) ||
    !Array.isArray(log.checks) ||
    !stamp(log.updatedAt) ||
    typeof log.run_id !== 'string' ||
    !log.run_id
  )
    return false;
  if (log.events.length > 24 || log.checks.length > 24) return false;
  const events = new Set(),
    checks = new Set();
  return (
    log.events.every((e) => {
      if (
        !identity(e) ||
        e.date !== date ||
        !stamp(e.when_detected) ||
        !isWellFormedEtfPcfDateKey(e.prev_date) ||
        e.prev_date >= date ||
        events.has(id(e))
      )
        return false;
      events.add(id(e));
      if (e.signal_type === 'limit_relaxation')
        return (
          known(e.prev) &&
          known(e.cur) &&
          (e.ratio === null
            ? e.cur.kind === 'unlimited' &&
              e.prev.kind === 'limited' &&
              e.ratio_kind === 'unbounded' &&
              e.transition === 'to_unlimited' &&
              e.tier === 'unlimited'
            : Number.isFinite(e.ratio) &&
              e.ratio >= 5 &&
              e.prev.kind === 'limited' &&
              e.prev.shares > 0 &&
              e.cur.kind === 'limited' &&
              e.ratio === e.cur.shares / e.prev.shares &&
              e.tier === (e.ratio >= 10 ? '10x' : '5x'))
        );
      return (
        Number.isSafeInteger(e.netCreation) &&
        e.netCreation >= 0 &&
        known(e.totalLimit) &&
        e.totalLimit.kind === 'limited' &&
        e.totalLimit.shares > 0 &&
        Number.isFinite(e.ratio) &&
        e.ratio >= 0.9 &&
        e.ratio === e.netCreation / e.totalLimit.shares
      );
    }) &&
    log.checks.every((c) => {
      if (
        !identity(c) ||
        c.date !== date ||
        !['ok', 'unknown', 'skip'].includes(c.status) ||
        checks.has(id(c)) ||
        (c.reason !== undefined && typeof c.reason !== 'string')
      )
        return false;
      checks.add(id(c));
      return true;
    })
  );
}
export function mergeEventLogs(oldLog, incomingLog) {
  if (
    !validateEventLog(incomingLog, incomingLog?.date) ||
    (oldLog && !validateEventLog(oldLog, incomingLog.date))
  )
    throw Error('invalid_event_log');
  const events = new Map(),
    checks = new Map();
  for (const e of [...(oldLog?.events || []), ...incomingLog.events]) {
    const prev = events.get(id(e));
    events.set(
      id(e),
      prev
        ? {
            ...e,
            when_detected:
              Date.parse(prev.when_detected) < Date.parse(e.when_detected)
                ? prev.when_detected
                : e.when_detected
          }
        : e
    );
  }
  for (const c of [...(oldLog?.checks || []), ...incomingLog.checks]) checks.set(id(c), c);
  return {
    ...incomingLog,
    events: [...events.values()].sort((a, b) => id(a).localeCompare(id(b))),
    checks: [...checks.values()].sort((a, b) => id(a).localeCompare(id(b)))
  };
}
const states = new WeakMap();
function state(kv) {
  if (!states.has(kv))
    states.set(kv, {
      logs: new Map(),
      snapshots: new Map(),
      times: new Map(),
      queues: new Map(),
      inflight: new Map()
    });
  return states.get(kv);
}
const parse = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw);
const same = (a, b) =>
  JSON.stringify(a?.events) === JSON.stringify(b.events) &&
  JSON.stringify(a?.checks) === JSON.stringify(b.checks);
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('timeout'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
const budgetCheck = (deadlineAt, signal) => {
  if (Date.now() >= deadlineAt || signal?.aborted) throw Error('timeout');
};
export function persistEventLog(kv, log, { deadlineAt = Infinity, signal } = {}) {
  if (!validateEventLog(log, log?.date)) return Promise.reject(Error('invalid_event_log'));
  const key = eventKey(log.date),
    s = state(kv),
    before = s.queues.get(key) || Promise.resolve();
  const task = before
    .catch(() => {})
    .then(async () => {
      budgetCheck(deadlineAt, signal);
      const raw = await abortable(kv.get(key), signal);
      let existing = raw === null || raw === undefined ? null : parse(raw);
      if (raw !== null && raw !== undefined && !validateEventLog(existing, log.date))
        throw Error('corrupt_event_log');
      if (s.logs.has(key)) existing = mergeEventLogs(existing, s.logs.get(key));
      const merged = mergeEventLogs(existing, log);
      if (same(existing, merged)) return existing;
      const wait = 1000 - (Date.now() - (s.times.get(key) || 0));
      if (wait > 0) await abortable(new Promise((resolve) => setTimeout(resolve, wait)), signal);
      budgetCheck(deadlineAt, signal);
      await abortable(kv.put(key, JSON.stringify(merged)), signal);
      s.times.set(key, Date.now());
      s.logs.set(key, merged);
      return merged;
    });
  s.queues.set(key, task);
  task
    .finally(() => {
      if (s.queues.get(key) === task) s.queues.delete(key);
    })
    .catch(() => {});
  return task;
}
const makeLog = (date, results, at) => ({
  schemaVersion: 1,
  source: 'szse_pcf_events',
  date,
  events: results.flatMap((r) => (r.event ? [r.event] : [])),
  checks: results.map((r) => r.check),
  updatedAt: at,
  run_id: at
});
function snapshotValid(s, date, type) {
  if (
    !s ||
    s.schemaVersion !== 1 ||
    s.date !== date ||
    s.source !== (type === 'limits' ? 'szse_pcf' : 'szse_fund_report') ||
    !stamp(s.fetchedAt) ||
    !Array.isArray(s.records) ||
    s.records.length > 16
  )
    return false;
  const seen = new Set();
  return s.records.every((r) => {
    const key = r.code + ':' + r.date;
    if (
      !(type === 'limits' ? TARGET_CODES : EVENT_CODES).includes(r.code) ||
      r.date !== date ||
      seen.has(key)
    )
      return false;
    seen.add(key);
    return type === 'limits'
      ? validLimit(r.net) && validLimit(r.total)
      : Number.isSafeInteger(r.shares) && r.shares >= 0 && ['份', '万份'].includes(r.unit);
  });
}
function mergeSnapshot(existing, incoming, type) {
  if (
    !snapshotValid(incoming, incoming.date, type) ||
    (existing !== null && existing !== undefined && !snapshotValid(existing, incoming.date, type))
  )
    throw Error('corrupt_snapshot');
  const records = new Map((existing?.records || []).map((r) => [r.code, r]));
  for (const r of incoming.records) records.set(r.code, r);
  return { ...incoming, records: [...records.values()].sort((a, b) => a.code.localeCompare(b.code)) };
}
function persistSnapshot(kv, incoming, type, deadlineAt, signal) {
  const key = eventKey(incoming.date, type),
    s = state(kv);
  const task = (s.queues.get(key) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      budgetCheck(deadlineAt, signal);
      const raw = await abortable(kv.get(key), signal);
      let existing = raw === null || raw === undefined ? null : parse(raw);
      // Reject corrupt remote values even if this isolate has an acknowledged snapshot.
      if (existing !== null && existing !== undefined && !snapshotValid(existing, incoming.date, type))
        throw Error('corrupt_snapshot');
      if (s.snapshots.has(key)) existing = mergeSnapshot(existing, s.snapshots.get(key), type);
      const merged = mergeSnapshot(existing, incoming, type);
      if (JSON.stringify(existing?.records) === JSON.stringify(merged.records)) return;
      const wait = 1000 - (Date.now() - (s.times.get(key) || 0));
      if (wait > 0) await abortable(new Promise((resolve) => setTimeout(resolve, wait)), signal);
      budgetCheck(deadlineAt, signal);
      await abortable(kv.put(key, JSON.stringify(merged)), signal);
      s.times.set(key, Date.now());
      s.snapshots.set(key, merged);
    });
  s.queues.set(key, task);
  task
    .finally(() => {
      if (s.queues.get(key) === task) s.queues.delete(key);
    })
    .catch(() => {});
  return task;
}
async function defaultSharesFetch(args) {
  const r = await fetchEtfPcfShares(args);
  if (!r.ok) return r;
  const fetchedAt = new Date().toISOString();
  try {
    return {
      ok: true,
      source: 'szse_fund_report',
      fetchedAt,
      records: await parseEtfPcfSharesXlsx(r.bytes, { includeEvidence: true })
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
export function runEtfPcfEvents(options = {}) {
  const kv = options.env?.FUND_LIMIT_KV;
  if (!kv) return Promise.resolve({ ok: false, reason: 'kv_unavailable' });
  const s = state(kv),
    key = JSON.stringify([
      options.scheduledTime,
      options.detectedAt,
      options.pcfs,
      options.pcfData,
      options.deadlineMs,
      options.tradingCalendar
    ]);
  if (s.inflight.has(key)) return s.inflight.get(key);
  const task = runStage(options);
  s.inflight.set(key, task);
  task.finally(() => s.inflight.delete(key)).catch(() => {});
  return task;
}
async function runStage({
  env,
  scheduledTime,
  detectedAt = new Date().toISOString(),
  pcfs = [],
  pcfData = pcfs,
  sharesFetch = defaultSharesFetch,
  sseSharesFetch = fetchSseEtfShares,
  deadlineMs = 20000,
  tradingCalendar = undefined
}) {
  if (!Number.isFinite(scheduledTime)) return { ok: false, reason: 'invalid_scheduled_time' };
  const startMs = Date.now(),
    deadline = startMs + deadlineMs,
    kv = env.FUND_LIMIT_KV,
    date = shanghaiDateKey(new Date(scheduledTime)),
    controller = new AbortController();
  const calendar =
    tradingCalendar === undefined ? confirmedSharesCalendar(day(date, -10), date) : tradingCalendar;
  const previous = previousSession(date, calendar);
  if (deadlineMs <= 0) return { ok: false, reason: 'timeout' };
  const historyDeadlineAt = startMs + Math.max(1, Math.floor(deadlineMs * HISTORY_BUDGET_SHARE)),
    sharesDeadlineAt = startMs + Math.max(2, Math.floor(deadlineMs * SHARES_BUDGET_SHARE));
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const expired = () => {
    if (controller.signal.aborted || Date.now() >= deadline) throw Error('timeout');
  };
  // 分阶段耗时、KV 读取次数、快照命中/失败原因：冷、热路径基线与超时定位都依赖这份统计。
  const stats = {
    phase: 'history',
    stages: {},
    reads: { history: 0, fallback: 0, current: 0, preflight: 0, projection: 0 },
    limitsSnapshots: { hit: 0, missing: 0, invalid: 0, corrupt: 0 },
    sharesSnapshots: { hit: 0, missing: 0, invalid: 0, corrupt: 0 },
    fallback: { dates: 0, reads: 0, errors: 0, populated: 0, stopped: '' },
    shares: { downloads: 0, failures: [] },
    limitsSnapshot: 'pending',
    persisted: { sharesSnapshots: 0, eventLogs: 0 },
    projection: { attempted: 0, ok: 0 }
  };
  let phaseStart = startMs;
  const setPhase = (name) => {
    stats.stages[stats.phase] = Date.now() - phaseStart;
    phaseStart = Date.now();
    stats.phase = name;
  };
  const summary = (extra) =>
    JSON.stringify({
      date,
      previous,
      deadlineMs,
      elapsedMs: Date.now() - startMs,
      ...stats,
      ...extra
    });
  const read = (key, phase = 'history') => {
    expired();
    stats.reads[phase] += 1;
    return abortable(kv.get(key), controller.signal);
  };
  try {
    const history = new Map(),
      cachedShares = [],
      fallbackFailed = new Set();
    // Read all dependent keys before writes. Errors must never become an empty baseline.
    const sessionSet = isCompleteSharesCalendar(calendar) ? new Set(calendar.sessions) : null;
    let fallbackStopped = '';
    for (let i = 1; i <= 10; i++) {
      expired();
      const d = day(date, -i),
        raw = await read(eventKey(d, 'limits'));
      if (raw) {
        let snap = null,
          miss = '';
        try {
          snap = parse(raw);
        } catch {
          miss = 'corrupt';
        }
        if (miss === 'corrupt') stats.limitsSnapshots.corrupt += 1;
        else if (snapshotValid(snap, d, 'limits')) {
          history.set(d, snap);
          stats.limitsSnapshots.hit += 1;
        } else stats.limitsSnapshots.invalid += 1;
      } else stats.limitsSnapshots.missing += 1;
      // 快照缺失或损坏时回退读单条 KV；仅限确认交易日，且受总读取上限与历史阶段预算约束。
      if (!history.has(d) && !fallbackStopped) {
        if (sessionSet && !sessionSet.has(d)) {
          // 非确认交易日无 PCF 发布，跳过单条回退，避免无效读取。
        } else if (Date.now() >= historyDeadlineAt) fallbackStopped = 'history_budget';
        else if (stats.fallback.reads + EVENT_CODES.length > ETF_PCF_FALLBACK_MAX_READS)
          fallbackStopped = 'read_cap';
        else {
          stats.fallback.dates += 1;
          const outcomes = await mapLimit(EVENT_CODES, ETF_PCF_FALLBACK_CONCURRENCY, async (code) => {
            if (Date.now() >= historyDeadlineAt) return { code, failed: 'history_budget' };
            stats.fallback.reads += 1;
            let cached;
            try {
              cached = await read(buildEtfPcfCacheKey(code, d), 'fallback');
            } catch (e) {
              // KV 读取失败/超时必须与“无历史记录”区分，绝不静默当作空基准。
              return { code, failed: e.message === 'timeout' ? 'timeout' : 'kv_read_failed' };
            }
            if (!cached) return { code };
            try {
              const p = parse(cached);
              if (!validateEtfPcfHistoryData(p, { code, date: d, now: new Date(scheduledTime) }).ok)
                return { code };
              return {
                code,
                record: {
                  code,
                  date: d,
                  ...normalizeCreationStatus(p),
                  net: { kind: p.netSubscribeLimitKind, shares: p.netSubscribeLimitShares },
                  total: { kind: p.totalSubscribeLimitKind, shares: p.totalSubscribeLimitShares }
                }
              };
            } catch {
              // 解析失败可跳过：损坏的单条缓存不代表没有历史记录。
              return { code };
            }
          });
          const fallback = outcomes.flatMap((o) => (o?.record ? [o.record] : [])),
            readFailures = outcomes.filter((o) => o?.failed === 'timeout' || o?.failed === 'kv_read_failed'),
            incomplete = outcomes.some((o) => o?.failed);
          if (readFailures.length) {
            fallbackFailed.add(d);
            stats.fallback.errors += readFailures.length;
            console.warn(
              'etf_pcf_events_fallback_read_failed',
              JSON.stringify({
                date: d,
                errors: readFailures.length,
                timeouts: readFailures.filter((o) => o.failed === 'timeout').length
              })
            );
          }
          // 任一读取失败即不落 history：该日按读取失败报告，不用部分数据冒充完整基准。
          if (!incomplete && fallback.length * 2 >= EVENT_CODES.length) {
            history.set(d, { schemaVersion: 1, source: 'szse_pcf', date: d, fetchedAt: detectedAt, records: fallback });
            stats.fallback.populated += 1;
          }
        }
      }
      const share = await read(eventKey(d, 'shares'));
      if (share) {
        let snap = null,
          miss = '';
        try {
          snap = parse(share);
        } catch {
          miss = 'corrupt';
        }
        if (miss === 'corrupt') stats.sharesSnapshots.corrupt += 1;
        else if (snapshotValid(snap, d, 'shares')) {
          cachedShares.push(...snap.records);
          stats.sharesSnapshots.hit += 1;
        } else stats.sharesSnapshots.invalid += 1;
      } else stats.sharesSnapshots.missing += 1;
    }
    stats.fallback.stopped = fallbackStopped;
    setPhase('current');
    // Collector data avoids a read-after-write miss; standalone callers may supply identities only.
    const inputs = [];
    for (const p of pcfData) {
      if (!EVENT_CODES.includes(p?.code) || p.date !== date) continue;
      if (p.source) inputs.push(p);
      else {
        const raw = await read(buildEtfPcfCacheKey(p.code, p.date), 'current');
        try {
          if (raw) inputs.push(parse(raw));
        } catch {
          /* 无效缓存不构造输入 */
        }
      }
    }
    const current = [...new Map(inputs.map((p) => [p.code, p])).values()]
      .filter(
        (p) =>
          EVENT_CODES.includes(p.code) &&
          p.date === date &&
          validateEtfPcfCachedData(p, { code: p.code, date, now: new Date(scheduledTime) }).ok
      )
      .map((p) => ({
        code: p.code,
        date,
        ...normalizeCreationStatus(p),
        net: { kind: p.netSubscribeLimitKind, shares: p.netSubscribeLimitShares },
        total: { kind: p.totalSubscribeLimitKind, shares: p.totalSubscribeLimitShares }
      }));
    for (const code of TARGET_CODES.filter((code) => code.startsWith('513'))) {
      const raw = await read(buildSsePcfCacheKey(code, date), 'current');
      if (!raw) continue;
      try {
        const p = parse(raw);
        if (!validateSsePcfCachedData(p, { code, date, now: new Date(scheduledTime) }).ok) continue;
        current.push({
          code,
          date,
          creationRedemption: p.creationRedemption,
          ...normalizeCreationStatus(p),
          net: { kind: 'unknown', shares: null },
          total: { kind: 'unknown', shares: null }
        });
      } catch {
        /* 无效缓存不提供申赎状态 */
      }
    }
    // 当日 PCF 校验完成后立即独立保存 limits 快照：不等 shares 下载和整个事件阶段完成，
    // 后续任何超时或源故障都不再导致次日基准缺失（方案 B 解耦点）。current 为空时单独记录。
    setPhase('limits_save');
    if (current.length) {
      try {
        await persistSnapshot(
          kv,
          { schemaVersion: 1, source: 'szse_pcf', date, fetchedAt: detectedAt, records: current },
          'limits',
          deadline,
          controller.signal
        );
        stats.limitsSnapshot = 'saved';
        console.log(
          'etf_pcf_events_limits_snapshot_saved',
          JSON.stringify({ date, records: current.length, elapsedMs: Date.now() - startMs })
        );
      } catch (e) {
        stats.limitsSnapshot = 'failed:' + e.message;
        console.warn(
          'etf_pcf_events_limits_snapshot_failed',
          JSON.stringify({ date, key: eventKey(date, 'limits'), error: e.message })
        );
        throw e;
      }
    } else {
      stats.limitsSnapshot = 'skipped_empty_current';
      console.log('etf_pcf_events_limits_snapshot_skipped', JSON.stringify({ date, reason: 'empty_current' }));
    }
    setPhase('shares');
    // 513 份额：上交所 ETF 规模接口，取 T-1、T-2 两个交易日，与深交所下载并行。
    const sseShareDates = [];
    if (previous) {
      sseShareDates.push(previous);
      const prev2 = previousSession(previous, calendar);
      if (prev2) sseShareDates.push(prev2);
    }
    const sseSharesPromise = Promise.all(
      sseShareDates.map((d) =>
        sseSharesFetch({
          date: d,
          relay: env.ETF_RELAY_TOKEN
            ? { url: env.ETF_RELAY_URL || 'https://fast.freebacktrack.tech/api/etf-relay/sse-etf-scale', token: env.ETF_RELAY_TOKEN }
            : null,
          timeoutMs: Math.max(1000, Math.min(8000, deadline - Date.now() - 2000))
        }).catch(() => ({ ok: false, reason: 'source_failure' }))
      )
    ).then((rs) => {
      const failures = rs.filter((r) => !r.ok).map((r) => r.reason);
      if (failures.length)
        console.warn('sse_shares_fetch_failed', JSON.stringify({ dates: sseShareDates, failures }));
      return rs.flatMap((r) => (r.ok ? r.records : []));
    });
    let records = [...cachedShares];
    let sharesReason = 'missing_shares';
    const projectionBatches = [];
    // Shares have their own dated source. A missing PCF baseline must not block collection.
    // 下载独占 80% 累计预算：到期只取消下载，不取消整个事件阶段，持久化始终有 ≥20% 余量。
    const sharesController = new AbortController();
    const cascadeAbort = () => sharesController.abort();
    if (controller.signal.aborted) cascadeAbort();
    else controller.signal.addEventListener('abort', cascadeAbort, { once: true });
    const sharesTimer = setTimeout(cascadeAbort, Math.max(1, sharesDeadlineAt - Date.now()));
    try {
      for (const url of [CURRENT_SHARES_URL, historicalSharesUrl(day(date, -10), date)]) {
        expired();
        const remaining = Math.min(sharesDeadlineAt, deadline) - Date.now();
        if (remaining <= 0) {
          if (stats.shares.downloads === 0) {
            sharesReason = 'shares_budget';
            stats.shares.failures.push(sharesReason);
          }
          break;
        }
        let response;
        stats.shares.downloads += 1;
        try {
          response = await Promise.race([
            sharesFetch({ url, signal: sharesController.signal, timeoutMs: Math.min(8000, remaining) }),
            new Promise((resolve) =>
              sharesController.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout' }), {
                once: true
              })
            )
          ]);
        } catch {
          response = { ok: false, reason: 'source_failure' };
        }
        expired();
        if (response.ok && response.source === 'szse_fund_report' && Array.isArray(response.records)) {
          try {
            if (response.fetchedAt)
              projectionBatches.push({ fetchedAt: response.fetchedAt, records: response.records });
          } catch (e) {
            console.warn('shares_projection_collect_failed', e.message);
          }
          records.push(
            ...response.records.filter(
              (r) =>
                EVENT_CODES.includes(r.code) &&
                isWellFormedEtfPcfDateKey(r.date) &&
                r.date <= date &&
                r.date >= day(date, -10) &&
                Number.isSafeInteger(r.shares) &&
                r.shares >= 0 &&
                ['份', '万份'].includes(r.unit)
            )
          );
        } else {
          sharesReason = response.reason || 'invalid_shares_source';
          stats.shares.failures.push(sharesReason);
        }
        // A failed or T-1-only current report must still try the dated historical source.
        const currentShares = records.filter((r) => r.date === date);
        if (
          response.ok &&
          previous &&
          currentShares.length &&
          currentShares.every((cur) =>
            records.some((old) => old.code === cur.code && old.date === previous && old.unit === cur.unit)
          )
        )
          break;
      }
    } finally {
      clearTimeout(sharesTimer);
      controller.signal.removeEventListener('abort', cascadeAbort);
      sharesController.abort();
    }
    setPhase('compute');
    records = [...new Map(records.map((r) => [`${r.code}:${r.date}`, r])).values()];
    const results = [],
      byDate = new Map();
    // 基准锁定为日历确认的上一交易日：最近交易日缺失、未知或读取失败时输出 unknown 及原因，
    // 绝不跳过最近交易日去用更旧但“恰好有值”的日期制造信号。
    const baselineReason = !previous
      ? 'unconfirmed_previous_session'
      : history.has(previous)
        ? null
        : fallbackFailed.has(previous)
          ? 'baseline_read_failed'
          : 'unconfirmed_recent_baseline';
    for (const code of EVENT_CODES) {
      const cur = current.find((r) => r.code === code),
        prev = previous && history.get(previous)?.records.find((r) => r.code === code);
      for (const basis of ['net', 'total'])
        results.push(
          baselineReason
            ? result({ code, date, prev_date: null }, 'limit_relaxation', basis, 'unknown', baselineReason)
            : limitRelaxation({
                code,
                date,
                basis,
                prev_date: previous,
                when_detected: detectedAt,
                prev: prev?.[basis],
                cur: cur?.[basis]
              })
        );
      const rows = [...new Map(records.filter((r) => r.code === code).map((r) => [r.date, r])).values()].sort(
        (a, b) => b.date.localeCompare(a.date)
      );
      const latest = rows[0],
        older = latest && rows.find((r) => r.date === previousSession(latest.date, calendar));
      // A more recent known PCF session proves that a stale report is not T-1.
      if (latest && older && (latest.date === date || latest.date === previous)) {
        const total = (latest.date === date ? current : history.get(latest.date)?.records)?.find(
          (r) => r.code === code
        )?.total;
        const r = netCreationNearTotalLimit({
          code,
          date: latest.date,
          prev_date: older.date,
          when_detected: detectedAt,
          netCreation: latest.shares - older.shares,
          totalLimit: total
        });
        if (!byDate.has(latest.date)) byDate.set(latest.date, []);
        byDate.get(latest.date).push(r);
      } else
        results.push(
          result({ code, date }, 'net_creation_near_total_limit', 'total', 'unknown', sharesReason)
        );
    }
    // Same-day net-creation checks share the same log as today's limit changes.
    byDate.set(date, [...results, ...(byDate.get(date) || [])]);
    // Preflight logs too, before saving auxiliary snapshots.
    setPhase('preflight');
    for (const d of byDate.keys()) {
      const raw = await read(eventKey(d), 'preflight');
      if (raw !== null && raw !== undefined && !validateEventLog(parse(raw), d)) {
        console.warn(
          'etf_pcf_events_log_preflight_failed',
          JSON.stringify({ key: eventKey(d), reason: 'corrupt_event_log' })
        );
        throw Error('corrupt_event_log');
      }
    }
    // 当日 limits 快照已先行独立保存，此处只收集 shares 快照。
    const snapshots = [];
    const shareDates = [...new Set(records.map((r) => r.date))];
    for (const d of shareDates) {
      expired();
      snapshots.push({
        type: 'shares',
        data: {
          schemaVersion: 1,
          source: 'szse_fund_report',
          date: d,
          fetchedAt: detectedAt,
          records: [...new Map(records.filter((r) => r.date === d).map((r) => [r.code, r])).values()]
        }
      });
    }
    for (const { type, data } of snapshots) {
      const raw = await read(eventKey(data.date, type), 'preflight');
      try {
        mergeSnapshot(raw === null || raw === undefined ? null : parse(raw), data, type);
      } catch (e) {
        console.warn(
          'etf_pcf_events_snapshot_preflight_failed',
          JSON.stringify({ key: eventKey(data.date, type), reason: e.message })
        );
        throw e;
      }
    }
    setPhase('persist');
    for (const { type, data } of snapshots) {
      expired();
      await persistSnapshot(kv, data, type, deadline, controller.signal);
      stats.persisted.sharesSnapshots += 1;
    }
    for (const [d, rs] of byDate) {
      expired();
      await persistEventLog(kv, makeLog(d, rs, detectedAt), {
        deadlineAt: deadline,
        signal: controller.signal
      });
      stats.persisted.eventLogs += 1;
    }
    // Independent sidecar after all original event writes; never downloads or mutates logs.
    setPhase('projection');
    const projectionResults = [];
    const sseShares = await Promise.race([
      sseSharesPromise,
      new Promise((resolve) => setTimeout(() => resolve([]), Math.max(1, deadline - Date.now() - 3000)))
    ]);
    // 当日与上一交易日的限额（含单账户限额），用于 limitChanges 环比。
    const limitDayCache = new Map();
    const readLimitDay = async (limitDay) => {
      if (!limitDay) return [];
      if (limitDayCache.has(limitDay)) return limitDayCache.get(limitDay);
      const isToday = limitDay === date;
      const rows = await mapLimit(TARGET_CODES, 6, async (code) => {
        const sse = code.startsWith('5');
        try {
          const raw = await read(
            sse ? buildSsePcfCacheKey(code, limitDay) : buildEtfPcfCacheKey(code, limitDay),
            'projection'
          );
          if (!raw) return null;
          const cached = parse(raw);
          const at = new Date();
          const ok = sse
            ? validateSsePcfCachedData(cached, { code, date: limitDay, now: at }).ok
            : (isToday ? validateEtfPcfCachedData : validateEtfPcfHistoryData)(cached, {
                code,
                date: limitDay,
                now: at
              }).ok;
          if (!ok) return null;
          return {
            code,
            date: limitDay,
            ...normalizeCreationStatus(cached),
            net: { kind: cached.netSubscribeLimitKind, shares: cached.netSubscribeLimitShares },
            total: { kind: cached.totalSubscribeLimitKind, shares: cached.totalSubscribeLimitShares },
            accountNet: { kind: cached.accountNetSubscribeLimitKind, shares: cached.accountNetSubscribeLimitShares },
            accountTotal: {
              kind: cached.accountTotalSubscribeLimitKind,
              shares: cached.accountTotalSubscribeLimitShares
            },
            creationUnitShares: Number.isSafeInteger(cached.creationRedemptionUnitShares)
              ? cached.creationRedemptionUnitShares
              : null
          };
        } catch (e) {
          if (e?.message === 'timeout') throw e;
          return null;
        }
      });
      const out = rows.filter(Boolean);
      limitDayCache.set(limitDay, out);
      return out;
    };
    let todayLimits = [],
      prevDayLimits = [];
    try {
      if (projectionBatches.length) {
        todayLimits = await readLimitDay(date);
        prevDayLimits = await readLimitDay(previous);
      }
    } catch (e) {
      console.warn('shares_projection_limit_read_failed', e?.message);
    }
    for (const batch of projectionBatches) {
      for (const d of [...new Set(batch.records.map((r) => r.date))]
        .filter((d) => isWellFormedEtfPcfDateKey(d) && d <= date && d >= day(date, -10))
        .sort()) {
        stats.projection.attempted += 1;
        try {
          if (controller.signal.aborted || Date.now() + 1000 >= deadline) {
            projectionResults.push({ ok: false, reason: 'projection_budget' });
            continue;
          }
          const row = batch.records.find((r) => r.date === d);
          const datedLimits = new Map(
            (d === date ? current : history.get(d)?.records || []).map((r) => [r.code, r])
          );
          for (const row2 of todayLimits) datedLimits.set(row2.code, row2);
          for (const code of TARGET_CODES) {
            const existing = datedLimits.get(code);
            if (existing?.subscriptionAllowed != null && known(existing.total)) continue;            const sse = code.startsWith('513');
            // 限额取快照产出当日（date）的最新 PCF，而非快照日期（d）的
            const raw = await read(sse ? buildSsePcfCacheKey(code, date) : buildEtfPcfCacheKey(code, date), 'projection');
            if (!raw) continue;
            try {
              const cached = parse(raw);
              const validate = sse
                ? validateSsePcfCachedData
                : validateEtfPcfCachedData;
              if (validate(cached, { code, date, now: new Date(scheduledTime) }).ok) {
                datedLimits.set(code, {
                  code,
                  date,
                  ...normalizeCreationStatus(cached),
                  net: { kind: cached.netSubscribeLimitKind, shares: cached.netSubscribeLimitShares },
                  total: { kind: cached.totalSubscribeLimitKind, shares: cached.totalSubscribeLimitShares },
                  creationUnitShares: Number.isSafeInteger(cached.creationRedemptionUnitShares)
                    ? cached.creationRedemptionUnitShares
                    : null
                });
              }
            } catch {
              /* 无效缓存不提供申赎状态 */
            }
          }
          const creationStatus = Object.fromEntries(
            [...datedLimits.values()].map((r) => [r.code, normalizeCreationStatus(r)])
          );
          const data = buildSharesProjection({
            date: d,
            records: [
              ...records.filter((r) => r.date !== d),
              ...batch.records.filter((r) => r.date === d),
              ...sseShares
            ],
            limits: [...datedLimits.values()],
            prevLimits: prevDayLimits,
            prevLimitDate: previous,            creationStatus,
            fetchedAt: batch.fetchedAt,
            dateEvidence: row?.dateEvidence,
            calendar,
            // 限额走快照产出当日的最新 PCF（date 是 cron 运行日，如今日）
            limitDate: date
          });
          projectionResults.push(
            await persistSharesProjection(kv, data, { deadlineAt: deadline, signal: controller.signal })
          );
        } catch (e) {
          projectionResults.push({ ok: false, reason: 'projection_failed', detail: e.message });
        }
      }
    }
    for (const result of projectionResults)
      if (!result.ok) console.warn('shares_projection_skipped', result.reason);
    stats.projection.ok = projectionResults.filter((r) => r.ok).length;
    const detectedEvents = [...byDate.values()].flat().filter((r) => r.event).map((r) => r.event);
    setPhase('done');
    console.log('etf_pcf_events_stage_summary', summary({ events: detectedEvents.length }));
    return { ok: true, date, events: detectedEvents.length, detectedEvents };
  } catch (e) {
    stats.stages[stats.phase] = Date.now() - phaseStart;
    const reason = e.message === 'timeout' ? 'timeout' : 'events_stage_error';
    console.warn('etf_pcf_events_stage_failed', summary({ reason, error: e.message }));
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
