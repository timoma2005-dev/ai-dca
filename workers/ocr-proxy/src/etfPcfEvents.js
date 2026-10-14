import {
  isWellFormedEtfPcfDateKey,
  shanghaiDateKey,
  validateEtfPcfCachedData,
  buildEtfPcfCacheKey
} from './etfPcfLimit.js';
import {
  TARGET_CODES,
  CURRENT_SHARES_URL,
  historicalSharesUrl,
  fetchEtfPcfShares,
  parseEtfPcfSharesXlsx
} from './etfPcfShares.js';
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
  if (cur.kind === 'unlimited') extra = { ratio_kind: 'unbounded', transition: 'to_unlimited' };
  else {
    if (prev.shares === 0)
      return cur.shares === 0 ? r : result(input, 'limit_relaxation', basis, 'unknown', 'zero_denominator');
    ratio = cur.shares / prev.shares;
    if (ratio < 5) return r;
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
  TARGET_CODES.includes(e.code) &&
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
              e.transition === 'to_unlimited'
            : Number.isFinite(e.ratio) &&
              e.ratio >= 5 &&
              e.prev.kind === 'limited' &&
              e.prev.shares > 0 &&
              e.cur.kind === 'limited' &&
              e.ratio === e.cur.shares / e.prev.shares)
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
    if (!TARGET_CODES.includes(r.code) || r.date !== date || seen.has(key)) return false;
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
  try {
    return { ok: true, source: 'szse_fund_report', records: await parseEtfPcfSharesXlsx(r.bytes) };
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
      options.deadlineMs
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
  deadlineMs = 20000
}) {
  if (!Number.isFinite(scheduledTime)) return { ok: false, reason: 'invalid_scheduled_time' };
  const deadline = Date.now() + deadlineMs,
    kv = env.FUND_LIMIT_KV,
    date = shanghaiDateKey(new Date(scheduledTime)),
    controller = new AbortController();
  if (deadlineMs <= 0) return { ok: false, reason: 'timeout' };
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const expired = () => {
    if (controller.signal.aborted || Date.now() >= deadline) throw Error('timeout');
  };
  const read = (key) => {
    expired();
    return abortable(kv.get(key), controller.signal);
  };
  try {
    const history = new Map(),
      cachedShares = [];
    // Read all dependent keys before writes. Errors must never become an empty baseline.
    for (let i = 1; i <= 10; i++) {
      expired();
      const d = day(date, -i),
        raw = await read(eventKey(d, 'limits'));
      if (raw) {
        let snap;
        try {
          snap = parse(raw);
        } catch {
          continue;
        }
        if (snapshotValid(snap, d, 'limits')) history.set(d, snap);
      }
      const share = await read(eventKey(d, 'shares'));
      if (share) {
        let snap;
        try {
          snap = parse(share);
        } catch {
          continue;
        }
        if (snapshotValid(snap, d, 'shares')) cachedShares.push(...snap.records);
      }
    }
    // Collector data avoids a read-after-write miss; standalone callers may supply identities only.
    const inputs = [];
    for (const p of pcfData) {
      if (!TARGET_CODES.includes(p?.code) || p.date !== date) continue;
      if (p.source) inputs.push(p);
      else {
        const raw = await read(buildEtfPcfCacheKey(p.code, p.date));
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
          TARGET_CODES.includes(p.code) &&
          p.date === date &&
          validateEtfPcfCachedData(p, { code: p.code, date, now: new Date(scheduledTime) }).ok
      )
      .map((p) => ({
        code: p.code,
        date,
        net: { kind: p.netSubscribeLimitKind, shares: p.netSubscribeLimitShares },
        total: { kind: p.totalSubscribeLimitKind, shares: p.totalSubscribeLimitShares }
      }));
    let records = [...cachedShares];
    let sharesReason = 'missing_shares';
    // Without any previous PCF ceiling the production downloader cannot assess signal 2.
    if (current.length && (history.size || sharesFetch !== defaultSharesFetch)) {
      for (const url of [CURRENT_SHARES_URL, historicalSharesUrl(day(date, -10), day(date, -1))]) {
        expired();
        let response;
        try {
          response = await Promise.race([
            sharesFetch({ url, signal: controller.signal, timeoutMs: Math.min(8000, deadline - Date.now()) }),
            new Promise((resolve) =>
              controller.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout' }), {
                once: true
              })
            )
          ]);
        } catch {
          response = { ok: false, reason: 'source_failure' };
        }
        expired();
        if (response.ok && response.source === 'szse_fund_report' && Array.isArray(response.records))
          records.push(
            ...response.records.filter(
              (r) =>
                TARGET_CODES.includes(r.code) &&
                isWellFormedEtfPcfDateKey(r.date) &&
                r.date < date &&
                r.date >= day(date, -10) &&
                Number.isSafeInteger(r.shares) &&
                r.shares >= 0 &&
                ['份', '万份'].includes(r.unit)
            )
          );
        else sharesReason = response.reason || 'invalid_shares_source';
        const dates = [...new Set(records.map((r) => r.date))];
        if (dates.length >= 2) break;
      }
    }
    const results = [],
      byDate = new Map(),
      previousDates = [...history.keys()],
      evidence = [...previousDates, ...records.map((r) => r.date)];
    for (const code of TARGET_CODES) {
      const cur = current.find((r) => r.code === code),
        prevDate = selectPreviousDate(date, evidence, evidence),
        prev = history.get(prevDate)?.records.find((r) => r.code === code);
      for (const basis of ['net', 'total'])
        results.push(
          limitRelaxation({
            code,
            date,
            basis,
            prev_date: prevDate,
            when_detected: detectedAt,
            prev: prev?.[basis],
            cur: cur?.[basis]
          })
        );
      const rows = [...new Map(records.filter((r) => r.code === code).map((r) => [r.date, r])).values()].sort(
        (a, b) => b.date.localeCompare(a.date)
      );
      const latest = rows[0],
        older = latest && rows.find((r) => r.date === selectPreviousDate(latest.date, evidence, evidence));
      // A more recent known PCF session proves that a stale report is not T-1.
      if (current.length && latest && older && latest.date === selectPreviousDate(date, evidence, evidence)) {
        const total = history.get(latest.date)?.records.find((r) => r.code === code)?.total;
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
    byDate.set(date, results);
    // Preflight logs too, before saving auxiliary snapshots.
    for (const d of byDate.keys()) {
      const raw = await read(eventKey(d));
      if (raw !== null && raw !== undefined && !validateEventLog(parse(raw), d))
        throw Error('corrupt_event_log');
    }
    const snapshots = [];
    if (current.length)
      snapshots.push({
        type: 'limits',
        data: {
          schemaVersion: 1,
          source: 'szse_pcf',
          date,
          fetchedAt: detectedAt,
          records: current
        }
      });
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
      const raw = await read(eventKey(data.date, type));
      mergeSnapshot(raw === null || raw === undefined ? null : parse(raw), data, type);
    }
    for (const { type, data } of snapshots) {
      expired();
      await persistSnapshot(kv, data, type, deadline, controller.signal);
    }
    for (const [d, rs] of byDate) {
      expired();
      await persistEventLog(kv, makeLog(d, rs, detectedAt), {
        deadlineAt: deadline,
        signal: controller.signal
      });
    }
    return { ok: true, date, events: [...byDate.values()].flat().filter((r) => r.event).length };
  } catch (e) {
    return { ok: false, reason: e.message === 'timeout' ? 'timeout' : 'events_stage_error' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
