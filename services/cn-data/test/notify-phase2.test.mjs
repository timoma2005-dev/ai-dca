// Phase 2 notify routes: /api/notify/status, /api/notify/events,
// /api/notify/holdings-rule against an in-memory cn-data DB with a real
// auth.sqlite for Bearer sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { claimPendingEvents, outboxStats } from '../src/outbox.js';
import { sha256Hex } from '../src/account/store.js';

const USER = 'testuser';
const CLIENT = 'account:testuser';
const AUTH_TOKEN = 'phase2-valid-token';

function setupAuth(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cn-data-notify-auth-'));
  const path = join(directory, 'auth.sqlite');
  const auth = new DatabaseSync(path);
  try {
    auth.exec(readFileSync(new URL('../../auth/migrations/001-init.sql', import.meta.url), 'utf8'));
    const now = new Date().toISOString();
    auth.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(USER, USER, 'hash', 'salt', now, now);
    const insert = auth.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
    insert.run(sha256Hex(AUTH_TOKEN), USER, now, new Date(Date.now() + 3600000).toISOString());
    insert.run(sha256Hex('expired-token'), USER, now, new Date(Date.now() - 3600000).toISOString());
  } finally { auth.close(); }
  const previousPath = process.env.AUTH_DB_PATH;
  process.env.AUTH_DB_PATH = path;
  t.after(() => {
    if (previousPath === undefined) delete process.env.AUTH_DB_PATH;
    else process.env.AUTH_DB_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  });
}

async function app(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const server = createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const headers = (token) => token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
  return {
    db,
    async request(path, method = 'GET', body, token = AUTH_TOKEN) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: headers(token),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: res.status, body: await res.json() };
    }
  };
}

const insertUserRecord = (db, type, id, payload, updatedAt) => db.prepare(`INSERT INTO notify_user_records
  (owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
  VALUES (?, ?, ?, ?, 1, ?, ?)`).run(USER, type, id, JSON.stringify(payload), updatedAt, updatedAt);

function seedStatusData(db) {
  const at = (n) => `2026-10-12T10:0${n}:00.000Z`;
  insertUserRecord(db, 'client', CLIENT, { clientId: CLIENT, clientLabel: '旧标签' }, at(1));
  insertUserRecord(db, 'client-meta', CLIENT, {
    counts: { planRuleCount: 2, dcaRuleCount: 1, totalRuleCount: 3 },
    lastSyncedAt: '2026-10-12T09:00:00.000Z', lastCheckedAt: '', lastTestedAt: ''
  }, at(2));
  insertUserRecord(db, 'client-channel', `${CLIENT}::bark`, { barkDeviceKey: 'legacy-bark-key' }, at(3));
  insertUserRecord(db, 'client-channel', `${CLIENT}::serverchan3`, {
    serverChan3: { uid: 'uid-1', sendKey: 'sendkey-abcdef-1234' }
  }, at(4));
  insertUserRecord(db, 'client-channel', `${CLIENT}::email`, {
    email: { address: 'User@Example.com', verified: true, verifiedAt: '2026-10-01T00:00:00Z', enabled: true }
  }, at(5));
  insertUserRecord(db, 'event', 'evt-1', { value: { eventId: 'evt-1', title: '第一条' } }, at(6));
  insertUserRecord(db, 'event', 'evt-2', { value: { eventId: 'evt-2', title: '第二条' } }, at(7));
  insertUserRecord(db, 'delivery-failure', 'fail-1', { value: { eventId: 'fail-1', channel: 'bark' } }, at(8));
  insertUserRecord(db, 'registration', 'reg-1', {
    pairedClients: [{ clientId: 'web:abc', groupId: CLIENT }, { clientId: 'other', groupId: 'other' }]
  }, at(9));
}

function seedResourceChannels(db) {
  const at = '2026-10-12T10:00:00.000Z';
  const rows = [
    ['channel:bark', { barkDeviceKey: 'resource-bark-key' }],
    ['__meta__', { clientLabel: '资源标签' }]
  ];
  let position = 0;
  for (const [recordId, payload] of rows) {
    db.prepare(`INSERT INTO account_resource_records
      (user_id, resource, record_id, position, revision, payload, deleted, created_at, updated_at)
      VALUES (?, 'notify/client-config', ?, ?, 1, ?, 0, ?, ?)`)
      .run(USER, recordId, position++, JSON.stringify(payload), at, at);
  }
}

test('migration 003 creates notify_user_records with D1-compatible schema', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notify_user_records'").get();
  assert.ok(table, 'table exists');
  for (const column of ['owner_user_id', 'record_type', 'record_id', 'payload', 'revision', 'created_at', 'updated_at']) {
    assert.ok(table.sql.includes(column), `has column ${column}`);
  }
  for (const index of ['idx_notify_user_records_type_id', 'idx_notify_user_records_owner_type']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index), `has index ${index}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
});

test('notify phase 2 routes: auth failures return 401', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  for (const [method, path, body] of [
    ['GET', '/api/notify/status', undefined],
    ['GET', '/api/notify/status?view=details', undefined],
    ['GET', '/api/notify/events', undefined],
    ['GET', '/api/notify/holdings-rule', undefined],
    ['POST', '/api/notify/holdings-rule', { enabled: true }]
  ]) {
    const missing = await request(path, method, body, null);
    assert.equal(missing.status, 401, `${method} ${path} missing token`);
    assert.equal(missing.body.error, '请先登录账户');
    const wrong = await request(path, method, body, 'wrong-token');
    assert.equal(wrong.status, 401, `${method} ${path} wrong token`);
    assert.equal(wrong.body.code, 'UNAUTHORIZED');
    const expired = await request(path, method, body, 'expired-token');
    assert.equal(expired.status, 401, `${method} ${path} expired token`);
    assert.equal(expired.body.code, 'SESSION_EXPIRED');
  }
});

test('GET /api/notify/status summary aggregates legacy records and resource channels', async (t) => {
  setupAuth(t);
  const { request, db } = await app(t);
  seedStatusData(db);
  seedResourceChannels(db);

  const res = await request('/api/notify/status');
  assert.equal(res.status, 200);
  const { data } = res.body;
  assert.equal(res.body.ok, true);
  assert.equal(res.body.schemaVersion, 1);
  assert.deepEqual(data.account, {
    clientId: CLIENT, accountClientId: CLIENT, username: USER,
    label: '资源标签', notifyGroupId: CLIENT
  });
  // Resource channel:bark overrides the legacy notify_user_records value.
  assert.deepEqual(data.channels.bark, { configured: true, deviceKey: 'resource-bark-key' });
  assert.deepEqual(data.channels.serverChan3, {
    uid: 'uid-1', sendKeyMasked: 'sendke...1234', configured: true
  });
  assert.deepEqual(data.channels.email, {
    maskedAddress: 'us**@example.com', verified: true,
    verifiedAt: '2026-10-01T00:00:00Z', enabled: true, configured: true
  });
  assert.deepEqual(data.channels.webWs, { configured: true });
  assert.deepEqual(data.rules, { planRuleCount: 2, dcaRuleCount: 1, totalRuleCount: 3 });
  assert.deepEqual(data.timestamps, {
    lastSyncedAt: '2026-10-12T09:00:00.000Z', lastCheckedAt: null, lastTestedAt: null
  });
  assert.deepEqual(data.delivery, { eventCount: 2, failureCount: 1 });
  assert.deepEqual(data.webSockets, {
    groupId: CLIENT, groupMemberCount: 1, registrationCount: 1,
    currentClientId: CLIENT, currentClientRegistrationCount: 1,
    pairedRegistrationCount: 1, unpairedRegistrationCount: 0
  });
});

test('GET /api/notify/status details returns events, failures and registrations', async (t) => {
  setupAuth(t);
  const { request, db } = await app(t);
  seedStatusData(db);
  const res = await request('/api/notify/status?view=details');
  assert.equal(res.status, 200);
  const { data } = res.body;
  assert.deepEqual(data.account, { clientId: CLIENT, accountClientId: CLIENT });
  assert.equal(data.delivery.eventCount, 2);
  assert.deepEqual(data.delivery.lastEvent, { eventId: 'evt-2', title: '第二条' });
  assert.equal(data.delivery.failureCount, 1);
  assert.deepEqual(data.delivery.failures, [{ eventId: 'fail-1', channel: 'bark' }]);
  assert.deepEqual(data.webSockets.groupMemberClientIds, ['web:abc', 'other']);
  assert.equal(data.webSockets.registrations.length, 1);
  assert.equal(data.webSockets.currentClientRegistrations.length, 1);
});

test('GET /api/notify/events returns latest 30 events, isolated per user', async (t) => {
  setupAuth(t);
  const { request, db } = await app(t);
  seedStatusData(db);
  const res = await request('/api/notify/events');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['events']);
  assert.deepEqual(res.body.events, [
    { eventId: 'evt-2', title: '第二条' },
    { eventId: 'evt-1', title: '第一条' }
  ]);
  insertUserRecord(db, 'event', 'other-evt', { value: { eventId: 'other-evt' } }, '2026-10-12T11:00:00.000Z');
  db.prepare('UPDATE notify_user_records SET owner_user_id = ? WHERE record_id = ?').run('otheruser', 'other-evt');
  assert.equal((await request('/api/notify/events')).body.events.length, 2);
});

test('holdings-rule GET defaults to disabled; POST normalizes and writes with outbox event', async (t) => {
  setupAuth(t);
  const { request, db } = await app(t);
  assert.deepEqual((await request('/api/notify/holdings-rule')).body, {
    enabled: false, digest: null, updatedAt: ''
  });
  const post = await request('/api/notify/holdings-rule', 'POST', {
    enabled: true,
    digest: {
      generatedAt: '2026-10-12',
      exchange: [
        { code: '159659', weight: 0.5, kind: 'exchange' },
        { code: 'ABC', weight: 0.5 },
        { code: '159632', weight: 0 },
        { code: '513300', weight: 2 },
        { code: '513870', weight: 0.2, kind: 'qdii' }
      ],
      otc: []
    }
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.enabled, true);
  assert.ok(post.body.updatedAt);
  // Invalid codes/weights are dropped by normalizeHoldingsDigest.
  assert.deepEqual(post.body.digest, {
    version: 1, generatedAt: '2026-10-12',
    exchange: [
      { code: '159659', weight: 0.5, kind: 'exchange' },
      { code: '513870', weight: 0.2, kind: 'qdii' }
    ],
    otc: []
  });
  const get = await request('/api/notify/holdings-rule');
  assert.deepEqual(get.body, post.body);
  const stored = JSON.parse(db.prepare(
    "SELECT payload FROM notify_configs WHERE user_id = ? AND config_key = 'holdings-rule'").get(USER).payload);
  assert.equal(stored.clientLabel, `账号通知 · ${USER}`);
  assert.equal(stored.accountUsername, USER);
  assert.deepEqual(outboxStats(db), { pending: 1, processing: 0, dead: 0 });
  const [event] = claimPendingEvents(db);
  assert.equal(event.target, 'notify');
  assert.equal(event.event_type, 'upsert-config');
  assert.equal(event.payload.user_id, USER);
  assert.equal(event.payload.config_key, 'holdings-rule');
  assert.equal(event.payload.payload.enabled, true);
});

test('holdings-rule POST toggles off and refreshes updatedAt', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const first = await request('/api/notify/holdings-rule', 'POST', { enabled: true, digest: null });
  const second = await request('/api/notify/holdings-rule', 'POST', { enabled: false, digest: { exchange: [] } });
  assert.equal(second.body.enabled, false);
  assert.deepEqual(second.body.digest, { version: 1, generatedAt: '', exchange: [], otc: [] });
  assert.ok(second.body.updatedAt >= first.body.updatedAt);
});

test('notify phase 2 routes reject wrong methods', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  assert.equal((await request('/api/notify/status', 'POST', {})).status, 405);
  assert.equal((await request('/api/notify/events', 'DELETE')).status, 405);
  assert.equal((await request('/api/notify/holdings-rule', 'PUT', {})).status, 405);
  // /api/notify/email/* is now implemented in cn-data (migrated from CF 2026-10-13).
  assert.equal((await request('/api/notify/email/status', 'GET')).status, 200);
});
