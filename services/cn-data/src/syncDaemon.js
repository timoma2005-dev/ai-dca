import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from './db.js';
import { claimPendingEvents, markEventDone, markEventFailed, markEventDead } from './outbox.js';

const routes = {
  notify: ['SYNC_DAEMON_NOTIFY_URL', '/api/notify/internal/sync-rules'],
  account: ['SYNC_DAEMON_ACCOUNT_URL', '/api/account/internal/sync'],
  sync: ['SYNC_DAEMON_SYNC_URL', '/api/sync/internal/sync-backup'],
};
export function daemonConfig(env = process.env) {
  const token = env.INTERNAL_SYNC_TOKEN;
  if (!token) throw new Error('INTERNAL_SYNC_TOKEN is required');
  const urls = {};
  for (const [target, [key, path]] of Object.entries(routes)) {
    if (!env[key]) throw new Error(`${key} is required`);
    const base = new URL(env[key]);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error(`Invalid ${key}`);
    urls[target] = new URL(path, base).href;
  }
  const intervalMs = Number(env.SYNC_DAEMON_INTERVAL_MS || 30000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid SYNC_DAEMON_INTERVAL_MS');
  return { urls, token, intervalMs };
}
export function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}
export async function processOnce(db, { config = daemonConfig(), fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const events = claimPendingEvents(db);
  let failed = 0;
  let dead = 0;
  for (const event of events) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(config.urls[event.target], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ eventId: event.event_id, eventType: event.event_type, payload: event.payload }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (res.ok) {
        await res.body?.cancel();
        markEventDone(db, event.event_id);
      } else if (res.status === 429 || res.status >= 500) {
        const delay = res.status === 429 ? Math.max(60000, parseRetryAfterMs(res.headers.get('retry-after'))) : 0;
        await res.body?.cancel();
        markEventFailed(db, event.event_id, `worker ${res.status}`, delay);
        failed++;
      } else {
        await res.body?.cancel();
        markEventDead(db, event.event_id, `worker ${res.status}`);
        dead++;
      }
    } catch (error) {
      markEventFailed(db, event.event_id, error.name === 'AbortError' ? 'timeout' : error.message);
      failed++;
    } finally {
      clearTimeout(timer);
    }
  }
  return { processed: events.length, failed, dead };
}
export function startSyncDaemon(db, { config = daemonConfig(), fetchImpl = fetch } = {}) {
  let stopped = false;
  let inFlight;
  let timer;
  const tick = async () => {
    if (stopped) return;
    try {
      inFlight = processOnce(db, { config, fetchImpl });
      await inFlight;
    } catch (error) {
      console.error('[sync-daemon] batch failed:', error.message);
    } finally {
      inFlight = null;
      if (!stopped) timer = setTimeout(tick, config.intervalMs);
    }
  };
  timer = setTimeout(tick, 0);
  return { async stop() {
    stopped = true;
    clearTimeout(timer);
    if (inFlight) await inFlight;
  } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = daemonConfig();
  const db = openDb();
  const daemon = startSyncDaemon(db, { config });
  console.log('[sync-daemon] started');
  const shutdown = async () => { await daemon.stop(); closeDb(db); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
