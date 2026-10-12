import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, withTransaction } from '../src/db.js';
import { createApp } from '../src/server.js';
import { enqueueEvent, claimPendingEvents, markEventDone, markEventFailed, markEventDead, outboxStats, CLAIM_LEASE_MS } from '../src/outbox.js';
import { processOnce, daemonConfig, parseRetryAfterMs, startSyncDaemon } from '../src/syncDaemon.js';
function memory(t) { const db = openDb(':memory:'); t.after(() => db.close()); return db; }
async function app(t, options) {
  const db = memory(t); const server = createServer(createApp(db, options));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { db, async request(path, method = 'GET', body) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() };
  } };
}
const rule = { user_id: 'u', client_id: 'c', rule_id: 'r', rule_type: 'holding-alert', payload: { symbol: '600000' } };
test('migrations create tables, are idempotent on reopen, and configure WAL and timeout', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cn-data-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db'); let db = openDb(path);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  for (const table of ['notify_rules','notify_configs','account_resources','account_holdings_transactions','sync_backups','sync_outbox','schema_migrations',
    'account_holdings_transaction_meta','account_holdings_transaction_history','account_resource_records','account_resource_history','account_migrations','account_data_notices'])
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  enqueueEvent(db, 'notify', 'x', {}); db.close(); db = openDb(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 3);
  assert.equal(outboxStats(db).pending, 1); db.close();
});
test('transaction rolls back event writes', (t) => {
  const db = memory(t); assert.throws(() => withTransaction(db, () => { enqueueEvent(db, 'sync', 'x', {}); throw Error('fail'); }));
  assert.equal(outboxStats(db).pending, 0);
});
test('claim respects due time and limit, parses payload and prevents duplicate claims', (t) => {
  const db = memory(t); const id = enqueueEvent(db, 'notify', 'x', { a: 1 });
  const later = enqueueEvent(db, 'sync', 'x', {});
  db.prepare('UPDATE sync_outbox SET next_attempt_at = ? WHERE event_id = ?').run('2999-01-01T00:00:00.000Z', later);
  const rows = claimPendingEvents(db, 1); assert.equal(rows[0].event_id, id); assert.equal(rows[0].target, 'notify');
  assert.deepEqual(rows[0].payload, { a: 1 }); assert.equal(claimPendingEvents(db).length, 0);
  assert.throws(() => claimPendingEvents(db, -1));
});
test('retry increments count and uses capped exponential backoff', (t) => {
  const db = memory(t); const id = enqueueEvent(db, 'sync', 'x', {}); const before = Date.now();
  markEventFailed(db, id, 'oops'); let row = db.prepare('SELECT * FROM sync_outbox WHERE event_id = ?').get(id);
  assert.equal(row.retry_count, 1); assert.equal(row.last_error, 'oops'); assert.equal(row.status, 'pending');
  assert.ok(Date.parse(row.next_attempt_at) >= before + 9000); assert.equal(claimPendingEvents(db).length, 0);
  db.prepare('UPDATE sync_outbox SET retry_count = ? WHERE event_id = ?').run(50, id); markEventFailed(db, id, 'again');
  row = db.prepare('SELECT * FROM sync_outbox WHERE event_id = ?').get(id);
  assert.ok(Date.parse(row.next_attempt_at) - Date.now() <= 1980000);
});
test('dead letters remain unclaimed and done events are removed', (t) => {
  const db = memory(t); const id = enqueueEvent(db, 'account', 'x', {}); markEventDead(db, id, 'bad');
  assert.equal(outboxStats(db).dead, 1); assert.equal(claimPendingEvents(db).length, 0); markEventDone(db, id);
  assert.deepEqual(outboxStats(db), { pending: 0, processing: 0, dead: 0 });
});
test('expired processing claims recover after crash', (t) => {
  const db = memory(t); const id = enqueueEvent(db, 'sync', 'x', {}); claimPendingEvents(db);
  db.prepare('UPDATE sync_outbox SET claimed_at = ? WHERE event_id = ?').run(new Date(Date.now() - CLAIM_LEASE_MS - 1).toISOString(), id);
  assert.equal(claimPendingEvents(db)[0].event_id, id);
});
test('health, CORS preflight, 404 and 405', async (t) => {
  const { request } = await app(t); assert.equal((await request('/health')).body.ok, true);
  const preflight = await request('/api/notify/rules', 'OPTIONS'); assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal((await request('/missing')).status, 404); assert.equal((await request('/api/notify/rules', 'PUT', {})).status, 405);
});
test('rules upsert and isolate users/clients; delete is scoped; outbox carries JSON payload', async (t) => {
  const { request, db } = await app(t);
  await request('/api/notify/rules', 'POST', rule); await request('/api/notify/rules', 'POST', { ...rule, enabled: false });
  await request('/api/notify/rules', 'POST', { ...rule, client_id: 'other' });
  assert.equal((await request('/api/notify/rules?user_id=u&client_id=c')).body.rules[0].enabled, 0);
  assert.equal((await request('/api/notify/rules?user_id=v')).body.rules.length, 0);
  assert.deepEqual(claimPendingEvents(db)[0].payload.payload, rule.payload);
  await request('/api/notify/rules/r?user_id=u&client_id=c', 'DELETE');
  assert.equal((await request('/api/notify/rules?user_id=u')).body.rules.length, 1);
  assert.equal(claimPendingEvents(db)[0].event_type, 'delete-rule');
});
test('default empty client rule can be deleted', async (t) => {
  const { request } = await app(t); await request('/api/notify/rules', 'POST', { ...rule, client_id: '' });
  assert.equal((await request('/api/notify/rules/r?user_id=u', 'DELETE')).status, 200);
  assert.equal((await request('/api/notify/rules?user_id=u')).body.rules.length, 0);
});
test('configs upsert, filter and isolate users', async (t) => {
  const { request, db } = await app(t);
  for (const payload of [['email'], ['bark']]) await request('/api/notify/configs', 'POST', { user_id: 'u', config_key: 'channels', payload });
  assert.deepEqual((await request('/api/notify/configs?user_id=u&config_key=channels')).body.configs[0].payload, ['bark']);
  assert.equal((await request('/api/notify/configs?user_id=v')).body.configs.length, 0); assert.equal(outboxStats(db).pending, 2);
});
for (const [path, id, wrapper] of [['transactions', { transaction_id: 'tx' }, 'transaction'], ['resources', { resource: 'holdings/groups', feature: 'holdings' }, 'resource']]) {
  test(`account ${path} metadata, conflict rollback, tombstone and isolation`, async (t) => {
    const { request, db } = await app(t); const body = { user_id: 'u', ...id, payload: [{ id: 1 }] };
    const res = await request(`/api/account/${path}`, 'POST', body);
    assert.equal(res.status, 200); assert.equal(res.body[wrapper].revision, 1); assert.equal(res.body[wrapper].content_hash.length, 64);
    assert.equal(res.body[wrapper].bytes, Buffer.byteLength(JSON.stringify(body.payload)));
    assert.equal((await request(`/api/account/${path}`, 'POST', { ...body, expected_revision: 0 })).status, 409);
    assert.equal(outboxStats(db).pending, 1); assert.equal((await request(`/api/account/${path}?user_id=v`)).body[path].length, 0);
    await request(`/api/account/${path}`, 'POST', { ...body, deleted: true, expected_revision: 1 });
    assert.equal((await request(`/api/account/${path}?user_id=u`)).body[path].length, 0);
    assert.equal(claimPendingEvents(db)[1].payload.deleted, 1);
  });
}
test('backup versions increment and conflicts leave data and outbox unchanged', async (t) => {
  const { request, db } = await app(t); assert.equal((await request('/api/sync/backup?user_id=u')).body.backup, null);
  for (const version of [1, 2]) assert.equal((await request('/api/sync/backup', 'PUT', { user_id: 'u', payload: { ciphertext: 'abc' } })).body.backup.version, version);
  assert.equal((await request('/api/sync/backup', 'PUT', { user_id: 'u', payload: {}, expected_version: 1 })).status, 409);
  assert.equal(outboxStats(db).pending, 2); assert.equal((await request('/api/sync/backup?user_id=v')).body.backup, null);
});
test('invalid JSON, fields, identity and oversized bodies return message errors without writes', async (t) => {
  const { request, db } = await app(t, { maxBodyBytes: 256 });
  for (const body of ['{', 'null', '[]', { ...rule, user_id: undefined }, { ...rule, payload: undefined }, { ...rule, enabled: 'yes' }]) {
    const res = await request('/api/notify/rules', 'POST', body); assert.equal(res.status, 400); assert.equal(typeof res.body.message, 'string');
  }
  assert.equal((await request('/api/notify/rules?user_id=v', 'POST', rule)).status, 400);
  assert.equal((await request('/api/notify/rules', 'POST', { ...rule, payload: 'x'.repeat(300) })).status, 413);
  assert.equal(outboxStats(db).pending, 0);
});
test('outbox insertion failure rolls back business write', async (t) => {
  const { request, db } = await app(t);
  db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await request('/api/notify/rules', 'POST', rule)).status, 500);
  assert.equal((await request('/api/notify/rules?user_id=u')).body.rules.length, 0);
});
const config = { urls: { notify: 'https://n.test/notify', account: 'https://a.test/account', sync: 'https://s.test/sync' }, token: 'secret', intervalMs: 30000 };
test('daemon routes all targets with bearer token and stable event IDs', async (t) => {
  const db = memory(t); const ids = ['notify', 'account', 'sync'].map((target) => enqueueEvent(db, target, 'upsert', { user_id: 'u' })); const seen = [];
  const result = await processOnce(db, { config, fetchImpl: async (url, init) => {
    assert.ok(Object.values(config.urls).includes(url)); assert.equal(init.headers.Authorization, 'Bearer secret');
    const body = JSON.parse(init.body); seen.push(body.eventId); assert.deepEqual(body.payload, { user_id: 'u' });
    return new Response(null, { status: 204 });
  } });
  assert.deepEqual(seen, ids); assert.deepEqual(result, { processed: 3, failed: 0, dead: 0 }); assert.equal(outboxStats(db).pending, 0);
});
for (const status of [429, 503, 400, 401]) test(`daemon handles HTTP ${status}`, async (t) => {
  const db = memory(t); const id = enqueueEvent(db, 'sync', 'x', {});
  await processOnce(db, { config, fetchImpl: async () => new Response(null, { status, headers: { 'Retry-After': '120' } }) });
  const row = db.prepare('SELECT * FROM sync_outbox WHERE event_id = ?').get(id);
  assert.equal(row.status, status === 429 || status >= 500 ? 'pending' : 'dead');
  if (status === 429) assert.ok(Date.parse(row.next_attempt_at) >= Date.now() + 119000);
});
test('network failures and timeouts retry', async (t) => {
  const db = memory(t); enqueueEvent(db, 'notify', 'x', {});
  await processOnce(db, { config, timeoutMs: 5, fetchImpl: (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })));
  }) });
  assert.equal(db.prepare('SELECT last_error FROM sync_outbox').get().last_error, 'timeout');
  enqueueEvent(db, 'sync', 'x', {});
  assert.equal((await processOnce(db, { config, fetchImpl: async () => { throw Error('offline'); } })).failed, 1);
});
test('daemon env validation and Retry-After dates', () => {
  assert.throws(() => daemonConfig({}), /TOKEN/);
  const env = { INTERNAL_SYNC_TOKEN: 'x', SYNC_DAEMON_NOTIFY_URL: 'https://n.test', SYNC_DAEMON_ACCOUNT_URL: 'https://a.test', SYNC_DAEMON_SYNC_URL: 'https://s.test' };
  assert.equal(daemonConfig(env).intervalMs, 30000); assert.equal(daemonConfig(env).urls.notify, 'https://n.test/api/notify/internal/sync-rules');
  assert.throws(() => daemonConfig({ ...env, SYNC_DAEMON_INTERVAL_MS: 'bad' }));
  assert.equal(parseRetryAfterMs('bad'), 0); assert.equal(parseRetryAfterMs('5'), 5000);
  assert.ok(parseRetryAfterMs(new Date(Date.now() + 10000).toUTCString()) > 8000);
});
test('daemon stop waits for running batch and cancels next poll', async (t) => {
  const db = memory(t); enqueueEvent(db, 'notify', 'x', {}); let release; let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const daemon = startSyncDaemon(db, { config, fetchImpl: () => { started(); return new Promise((resolve) => { release = resolve; }); } });
  await ready; const stop = daemon.stop(); release(new Response(null, { status: 204 })); await stop;
  assert.equal(outboxStats(db).processing, 0);
});
test('switch config GET returns default when not found, POST upserts and enqueues', async (t) => {
  const { request, db } = await app(t);
  // GET non-existent -> default
  let res = await request('/api/notify/switch/config?user_id=u1');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.clientId, 'account:u1');
  assert.equal(res.body.config.enabled, false);
  // POST new config
  const cfg = { enabled: true, activeRuleId: 'rule-1', rules: [] };
  res = await request('/api/notify/switch/config', 'POST', { user_id: 'u1', config: cfg });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.config, cfg);
  // GET returns stored
  res = await request('/api/notify/switch/config?user_id=u1');
  assert.deepEqual(res.body.config, cfg);
  // outbox has event
  assert.equal(outboxStats(db).pending, 1);
  // explicit client_id
  res = await request('/api/notify/switch/config', 'POST', { user_id: 'u1', client_id: 'custom-c', config: cfg });
  assert.equal(res.body.clientId, 'custom-c');
  res = await request('/api/notify/switch/config?user_id=u1&client_id=custom-c');
  assert.deepEqual(res.body.config, cfg);
});
test('switch snapshot GET returns null snapshot with default config when empty', async (t) => {
  const { request } = await app(t);
  const res = await request('/api/notify/switch/snapshot?user_id=u2');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.snapshot, null);
  assert.equal(res.body.config.enabled, false);
});
test('switch run returns 501 not implemented', async (t) => {
  const { request } = await app(t);
  const res = await request('/api/notify/switch/run', 'POST', { user_id: 'u1' });
  assert.equal(res.status, 501);
  assert.equal(res.body.ok, false);
});
