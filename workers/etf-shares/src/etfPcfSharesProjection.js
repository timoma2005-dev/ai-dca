import {
  validateSharesProjection,
  validSharesPointer,
  sharesKey,
  SOURCE
} from '../../../shared/etfPcfSharesSchema.js';
export * from '../../../shared/etfPcfSharesSchema.js';
const writers = new WeakMap();
export function persistSharesProjection(kv, data, { deadlineAt = Infinity, signal } = {}) {
  if (!writers.has(kv))
    writers.set(kv, { queue: Promise.resolve(), times: new Map(), objects: new Map(), pointer: null });
  const state = writers.get(kv);
  const task = state.queue
    .catch(() => {})
    .then(async () => {
      const check = () => {
        if (signal?.aborted || Date.now() + 1000 >= deadlineAt) throw Error('projection_budget');
      };
      try {
        check();
        if (!validateSharesProjection(data)) throw Error('invalid_projection');
      } catch (e) {
        return { ok: false, reason: e.message };
      }
      const bounded = (promise) =>
        new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
          };
          const abort = () => {
            cleanup();
            reject(Error('projection_budget'));
          };
          const timeout = setTimeout(abort, Math.max(1, Math.min(2147483647, deadlineAt - Date.now())));
          signal?.addEventListener('abort', abort, { once: true });
          Promise.resolve(promise).then(
            (value) => {
              cleanup();
              resolve(value);
            },
            (error) => {
              cleanup();
              reject(error);
            }
          );
          if (signal?.aborted) abort();
        });
      const put = async (key, value) => {
        check();
        const raw = await bounded(kv.get(key));
        if (raw === JSON.stringify(value)) return;
        const wait = 1000 - (Date.now() - (state.times.get(key) || 0));
        if (wait > 0) await bounded(new Promise((resolve) => setTimeout(resolve, wait)));
        check();
        // 份额投影永久保存（不设 KV TTL）；expiresAt 仍只用于 latest 新鲜度校验。
        if (Date.parse(data.expiresAt) - Date.now() < 60000) throw Error('projection_expired');
        await bounded(kv.put(key, JSON.stringify(value)));
        state.times.set(key, Date.now());
      };
      try {
        const raw = await bounded(kv.get(sharesKey(data.date)));
        let existing;
        try {
          existing = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          existing = null;
        }
        const acknowledged = state.objects.get(data.date);
        if (
          validateSharesProjection(acknowledged) &&
          (!validateSharesProjection(existing) || acknowledged.fetchedAt >= existing.fetchedAt)
        )
          existing = acknowledged;
        if (validateSharesProjection(existing) && existing.fetchedAt > data.fetchedAt)
          return { ok: true, pointer: 'unchanged' };
        const content = (value) => JSON.stringify(value && { ...value, projectedAt: null });
        if (content(existing) !== content(data)) await put(sharesKey(data.date), data);
        state.objects.set(data.date, data);
        for (const [date, value] of state.objects)
          if (Date.parse(value.expiresAt) <= Date.now()) state.objects.delete(date);
      } catch (e) {
        return { ok: false, reason: 'projection_put_failed', detail: e.message };
      }
      try {
        check();
        const raw = await bounded(kv.get('etf-pcf-shares:latest'));
        let old = raw == null ? null : typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (old && !validSharesPointer(old)) throw Error('corrupt_pointer');
        const acknowledged = validSharesPointer(state.pointer) ? state.pointer : null;
        if (
          [old, acknowledged].some(
            (value) => value && (value.date > data.date || value.fetchedAt > data.fetchedAt)
          )
        )
          return { ok: true, pointer: 'unchanged' };
        const pointer = {
          schemaVersion: 1,
          source: SOURCE,
          date: data.date,
          fetchedAt: data.fetchedAt,
          expiresAt: data.expiresAt,
          key: sharesKey(data.date)
        };
        if (
          [old, acknowledged].some(
            (value) =>
              value &&
              value.date === pointer.date &&
              value.fetchedAt === pointer.fetchedAt &&
              value.expiresAt === pointer.expiresAt &&
              value.key === pointer.key
          )
        )
          return { ok: true, pointer: 'unchanged' };
        await put('etf-pcf-shares:latest', pointer);
        state.pointer = pointer;
      } catch (e) {
        return { ok: false, reason: 'projection_pointer_failed', detail: e.message };
      }
      return { ok: true };
    });
  state.queue = task;
  return task;
}
