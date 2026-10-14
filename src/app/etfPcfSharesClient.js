import { validateSharesProjection, previousSession } from '../../shared/etfPcfSharesSchema.js';
import { apiUrl } from './apiBase.js';
export { validateSharesProjection };
export const SHARES_ENDPOINT = apiUrl('/api/etf-pcf-shares');
export const shanghaiAccessDay = (now = Date.now()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
export function createSharesClient({
  endpoint = SHARES_ENDPOINT,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  storage = () => globalThis.localStorage
} = {}) {
  const memory = new Map(),
    inflight = new Map();
  const keyFor = (date = 'latest') => `etf-pcf-shares:v2:${endpoint}:${shanghaiAccessDay(now())}:${date}`;
  const valid = (entry, key, date) =>
    entry?.key === key &&
    Number.isFinite(entry.receivedAt) &&
    entry.receivedAt <= now() &&
    validateSharesProjection(entry.data, { now: new Date(now()), ...(date !== 'latest' ? { date } : {}) });
  function cached(key, date) {
    let entry = memory.get(key);
    if (entry?.missUntil > now()) return entry;
    if (!valid(entry, key, date)) {
      try {
        entry = JSON.parse(storage()?.getItem(key));
      } catch {
        entry = null;
      }
      if (!valid(entry, key, date)) return null;
      memory.set(key, entry);
    }
    return entry;
  }
  function subscribe({ date = 'latest', enabled = true } = {}) {
    if (!enabled) return { promise: Promise.resolve({ state: 'idle' }), release() {} };
    const key = keyFor(date),
      entry = cached(key, date);
    if (entry?.missUntil > now())
      return { promise: Promise.resolve({ state: 'empty', reason: entry.reason }), release() {} };
    if (entry && now() < Math.min(entry.receivedAt + 300000, Date.parse(entry.data.expiresAt)))
      return {
        promise: Promise.resolve({
          state: entry.data.status,
          data: entry.data,
          receivedAt: entry.receivedAt
        }),
        release() {}
      };
    let task = inflight.get(key);
    if (task?.controller.signal.aborted) task = null;
    if (!task) {
      const controller = new AbortController();
      task = { controller, consumers: 0 };
      const timer = setTimeout(() => controller.abort(), 8000);
      task.promise = (async () => {
        try {
          const response = await fetchImpl(
            `${endpoint}${date === 'latest' ? '' : `?date=${encodeURIComponent(date)}`}`,
            { method: 'GET', credentials: 'omit', redirect: 'manual', signal: controller.signal }
          );
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            try {
              await response.body?.cancel();
            } catch {
              /* rejection remains a failure */
            }
            throw Error('redirect_rejected');
          }
          if (response.status === 404) {
            const body = await response.json().catch(() => ({}));
            if (!controller.signal.aborted)
              memory.set(key, { missUntil: now() + 30000, reason: body.reason });
            return { state: 'empty', reason: body.reason };
          }
          if (!response.ok) throw Error('http_error');
          const data = await response.json();
          if (
            controller.signal.aborted ||
            !validateSharesProjection(data, { now: new Date(now()), ...(date !== 'latest' ? { date } : {}) })
          )
            throw Error('invalid_snapshot');
          const value = { key, receivedAt: now(), data };
          // A late response remains under its original access-day key.
          memory.set(key, value);
          try {
            storage()?.setItem(key, JSON.stringify(value));
          } catch {
            /* memory still usable */
          }
          return { state: data.status, data, receivedAt: value.receivedAt };
        } catch (error) {
          const old = valid(entry, key, date) ? entry.data : null;
          return {
            state: old ? 'stale' : 'error',
            data: old,
            receivedAt: old ? entry.receivedAt : null,
            reason: error.message
          };
        } finally {
          clearTimeout(timer);
          if (inflight.get(key) === task) inflight.delete(key);
        }
      })();
      inflight.set(key, task);
    }
    task.consumers++;
    let released = false;
    return {
      promise: task.promise,
      stale: entry?.data,
      staleReceivedAt: entry?.receivedAt,
      release() {
        if (released) return;
        released = true;
        task.consumers--;
        setTimeout(() => {
          if (!task.consumers && inflight.get(key) === task) task.controller.abort();
        }, 0);
      }
    };
  }
  return { subscribe, keyFor };
}
export const sharesClient = createSharesClient();
export function limitLabel(r) {
  if (r.totalLimitKind === 'unlimited') return '不适用（累计不限）';
  if (r.deltaShares === null || r.atLimit === null) return '—';
  if (r.deltaShares < 0) return '否（净减少）';
  const percent = `${Math.round(r.utilization * 100)}%`;
  if (r.atLimit) return `是（${percent} 精确相等）`;
  if (r.utilization > 1) return `否（超过上限观测 ${percent}）`;
  if (r.nearTotalLimit) return `否（${percent} 接近）`;
  return '否';
}
export function creationLabel(r) {
  if (r.creationShares === null || r.creationShares === undefined || r.creationShares < 0) return '暂无';
  const value = r.creationShares.toLocaleString('zh-CN');
  return r.creationSharesKind === 'estimate' ? `约 ${value}` : value;
}
export const SHARES_DESCRIPTION =
  '本期与上期按 PCF 快照日标注，份额统计日单独列出；新增及申购推算按相邻统计交易日计算。';

export function sharesPeriodDates(data) {
  const statistics = {
    basis: '统计',
    currentDate: data?.date || null,
    previousDate: data?.prevDate || null
  };
  if (data?.pcfSnapshot?.source !== 'szse_pcf') return statistics;
  const currentDate = data.pcfSnapshot.date;
  const previousDate = previousSession(currentDate, data.calendar);
  if (!previousDate) return statistics;
  if (currentDate === data.date) return { basis: 'PCF', currentDate, previousDate };
  if (
    previousDate === data.date &&
    (!data.prevDate || data.prevDate === previousSession(data.date, data.calendar))
  )
    return { basis: 'PCF', currentDate, previousDate };
  return statistics;
}

export function snapshotLabel(data) {
  return data.pcfSnapshot?.date
    ? `${data.pcfSnapshot.date} PCF 快照，份额统计截至 ${data.date}`
    : `份额统计截至 ${data.date}，PCF 快照日期暂无`;
}

export function freshnessMessage(data, accessDay = shanghaiAccessDay()) {
  const expected = previousSession(accessDay, data.calendar);
  if (
    expected &&
    data.date >= expected &&
    data.pcfSnapshot?.source === 'szse_pcf' &&
    data.pcfSnapshot.date === accessDay
  )
    return '';
  return expected && data.date < expected
    ? `数据滞后：最新报表截至 ${data.date}，尚未获得预期交易日数据`
    : `最新已验证报表：${data.date}，更新及时性待确认`;
}
