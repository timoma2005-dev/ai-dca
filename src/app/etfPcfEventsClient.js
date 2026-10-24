import { apiUrl } from './apiBase.js';

const EMPTY_CODES = new Set();

export function createPcfEventsClient({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const memory = new Map(), inflight = new Map();
  function subscribe(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return { promise: Promise.resolve(EMPTY_CODES), release() {} };
    const cached = memory.get(date);
    if (cached && cached.receivedAt <= now() && cached.receivedAt + 300000 > now())
      return { promise: Promise.resolve(cached.codes), release() {} };
    let task = inflight.get(date);
    if (task?.controller.signal.aborted) task = null;
    if (!task) {
      const controller = new AbortController();
      task = { controller, consumers: 0 };
      const timer = setTimeout(() => controller.abort(), 8000);
      task.promise = (async () => {
        try {
          const response = await fetchImpl(apiUrl('/api/etf-pcf-events', { date }), {
            method: 'GET', credentials: 'omit', redirect: 'manual', signal: controller.signal
          });
          if (!response.ok) throw Error('http_error');
          const data = await response.json();
          if (controller.signal.aborted || data?.source !== 'szse_pcf_events' || data.date !== date || !Array.isArray(data.events))
            throw Error('invalid_events');
          const codes = new Set(data.events
            .filter(event => event?.signal_type === 'net_creation_near_total_limit' && typeof event.code === 'string' && /^\d{6}$/.test(event.code))
            .map(event => event.code));
          memory.set(date, { receivedAt: now(), codes });
          return codes;
        } catch {
          return EMPTY_CODES;
        } finally {
          clearTimeout(timer);
          if (inflight.get(date) === task) inflight.delete(date);
        }
      })();
      inflight.set(date, task);
    }
    task.consumers++;
    let released = false;
    return {
      promise: task.promise,
      release() {
        if (released) return;
        released = true;
        task.consumers--;
        setTimeout(() => {
          if (!task.consumers && inflight.get(date) === task) task.controller.abort();
        }, 0);
      }
    };
  }
  return { subscribe };
}

export const pcfEventsClient = createPcfEventsClient();
