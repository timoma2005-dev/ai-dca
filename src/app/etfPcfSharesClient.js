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
  const value = (r.creationShares / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
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

// Compact presentation for the shares decision cards; legacy labels stay unchanged.
// 沪深统一口径：暂停申购最优先，其余按生效限额（净优先）+ 利用率分支判断。
const missingValue = (v) => v === null || v === undefined;
export function sharesCeiling(r) {
  // 仅显式 false 判暂停（159/513 同口径）；缺失/未知状态不推断。
  if (r.subscriptionAllowed === false) return { kind: 'paused', label: '暂停申购' };
  // 生效限额：净优先，没有则回退累计（与 UtilizationCell 一致）。
  const effKind = r.effLimitKind || (r.netLimitKind === 'limited' ? 'limited' : r.totalLimitKind);
  if (effKind === 'unlimited') return { kind: 'unlimited', label: '累计不限' };
  if (missingValue(r.deltaShares) || missingValue(r.atLimit) || missingValue(r.utilization))
    return { kind: 'pending', label: '数据待确认' };
  if (r.deltaShares < 0) return { kind: 'outflow', label: '净流出' };
  const percent = Math.round(r.utilization * 100);
  if (r.atLimit) return { kind: 'at-limit', label: '顶格 100%' };
  if (r.utilization > 1) return { kind: 'over-limit', label: `超限 ${percent}%` };
  if (r.nearTotalLimit) return { kind: 'near-limit', label: `接近 ${percent}%` };
  return { kind: 'normal', label: `未顶格 ${percent}%` };
}

// 倍数文案统一格式：≥10 取整，其余保留 1 位小数并去掉尾随 .0。
function formatLimitMultiple(m) {
  return m >= 10 ? Math.round(m).toString() : m.toFixed(1).replace(/\.0$/, '');
}

// 限额环比标签（纯函数）：worker 对比上一限额日 PCF 后预计算 limitChanges，
// 按 limitSource 选中 net/total 项，不重算分类、不发请求；旧快照无字段时返回 null。
// tone 语义：down=收紧/新增限额，up=放宽/取消限额，flat=生效项持平但其它限额有变（mixed）。
export function chipForLimitChange(row) {
  const entry = row?.limitChanges?.[row.limitSource === 'net' ? 'net' : 'total'];
  if (!entry || typeof entry !== 'object') return null;
  if (entry.change === 'tightened' || entry.change === 'relaxed') {
    if (Number.isFinite(entry.ratio)) {
      const multiple = formatLimitMultiple(entry.ratio);
      return entry.change === 'tightened'
        ? { label: `减少至 ${multiple}倍`, tone: 'down' }
        : { label: `新增 ${multiple}倍`, tone: 'up' };
    }
    // 上一期为不限/无记录：有限限额记「新增限额」，放开记「取消限额」。
    if (entry.ratio === null)
      return entry.change === 'tightened'
        ? { label: '新增限额', tone: 'down' }
        : { label: '取消限额', tone: 'up' };
    return null; // undefined/NaN/Infinity 不冒充有效倍数
  }
  if (entry.change === 'unchanged' && row.limitChange === 'mixed') return { label: '限额有变', tone: 'flat' };
  return null;
}
