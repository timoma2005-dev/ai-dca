import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from './db.js';
import { claimPendingEvents, markEventDone, markEventFailed, markEventDead } from './outbox.js';
import { createCfWorkerTransport } from './cfIpSelection.js';

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
// CF Worker IPv4 selection transport (docs/plan-cf-ip-selection.md).
// CF_UPSTREAM_IP_SELECTION_ENABLED defaults to off: prepare and fetch then
// resolve no candidates, probe nothing and delegate straight to the original
// global fetch, so the daemon behaves exactly as before this module existed.
const cfTransport = createCfWorkerTransport({ env: process.env });
export async function processOnce(db, { config = daemonConfig(), fetchImpl, timeoutMs = 15000, cfTransport: transport = cfTransport } = {}) {
  const events = claimPendingEvents(db);
  let failed = 0;
  let dead = 0;
  // The default client is the selection wrapper; an injected fetchImpl owns
  // the batch alone and must never trigger hidden probing. prepare warms one
  // selection round per origin of this batch's actual targets (three targets
  // on one origin probe only once) and never blocks or fails the batch.
  const send = fetchImpl ?? ((url, init) => transport.fetch(url, init));
  if (events.length > 0 && !fetchImpl) {
    try {
      await transport.prepare([...new Set(events.map((event) => event.target))].map((target) => config.urls[target]));
    } catch (error) {
      console.error('[sync-daemon] cf ip selection prepare error:', error?.message || error);
    }
  }
  for (const event of events) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await send(config.urls[event.target], {
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
export function startSyncDaemon(db, { config = daemonConfig(), fetchImpl, cfTransport: transport = cfTransport } = {}) {
  let stopped = false;
  let inFlight;
  let timer;
  const tick = async () => {
    if (stopped) return;
    try {
      inFlight = processOnce(db, { config, fetchImpl, cfTransport: transport });
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
  const shutdown = async () => { await daemon.stop(); cfTransport.close(); closeDb(db); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
