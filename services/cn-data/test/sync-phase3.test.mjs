import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { sha256Hex } from '../src/account/store.js';
import worker from '../../../workers/sync/src/index.js';

async function app(t, authenticated = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cn-sync-'));
  const previous = process.env.AUTH_DB_PATH;
  process.env.AUTH_DB_PATH = join(directory, 'auth.sqlite');
  if (authenticated) {
    const auth = new DatabaseSync(process.env.AUTH_DB_PATH);
    auth.exec(readFileSync(new URL('../../auth/migrations/001-init.sql', import.meta.url), 'utf8'));
    for (const username of ['lovexl', 'wanghao0902', 'de88903', 'ordinary']) {
      const now = new Date().toISOString();
      auth.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(username, username, 'hash', 'salt', now, now);
      auth.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(sha256Hex(username), username, now, new Date(Date.now() + 3600000).toISOString());
    }
    auth.close();
  }
  const db = openDb(':memory:');
  const server = createServer(createApp(db));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    db.close();
    if (previous === undefined) delete process.env.AUTH_DB_PATH;
    else process.env.AUTH_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, async request(path, method = 'GET', body, token, extraHeaders = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sync${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: res.headers.get('content-type').startsWith('text/html') ? text : JSON.parse(text) };
  } };
}
const envelope = (hash = 'a') => ({ source: 'ai-dca-secure-sync', ciphertext: `cipher-${hash}`, crypto: { algorithm: 'AES-GCM' }, meta: { keyCount: 2, contentHash: hash } });
const put = (hash, id = 'a', baseVersion = 0) => ({ encryptedEnvelope: envelope(hash), end: { id, type: 'web' }, baseVersion });
const user = '?user_id=test';

test('public tracking deduplicates storage and aggregates; caps batches and enriches network headers', async t => {
  const { db, request } = await app(t);
  const events = [
    { id: 'pv', type: 'page_view', visitorId: 'visitor', username: ' A中 B ', path: '/home' },
    { id: 'engagement', type: 'page_engagement', visitorId: 'visitor' },
    { id: 'switch', type: 'switch_worker_run', userId: 'user' }
  ];
  assert.deepEqual((await request('/analytics/track', 'POST', { events })).body, { ok: true, accepted: 3 });
  assert.deepEqual((await request('/analytics/track', 'POST', { events })).body, { ok: true, accepted: 3 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n, 3);
  assert.equal(db.prepare("SELECT username FROM analytics_events WHERE id = 'pv'").get().username, 'ab');
  const stats = db.prepare('SELECT * FROM analytics_daily_stats').get();
  assert.equal(stats.pv, 1); assert.equal(stats.switch_runs, 1);
  const visitor = db.prepare("SELECT * FROM analytics_daily_users WHERE identity = 'visitor'").get();
  assert.equal(visitor.is_visitor_only, 1); assert.equal(visitor.has_page_view, 1); assert.equal(visitor.has_page_engagement, 1);
  assert.deepEqual((await request('/analytics/track', 'POST', {})).body, { message: 'missing event type' });
  assert.equal((await request('/analytics/track', 'POST', { events: [null, {}] })).status, 400);
  const batch = await request('/analytics/track', 'POST', { events: Array.from({ length: 60 }, (_, i) => ({ id: `limit-${i}`, type: 'page_view' })) });
  assert.equal(batch.body.accepted, 50);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE id LIKE 'limit-%'").get().n, 50);
  await request('/analytics/track', 'POST', { id: 'network', type: 'network_trace', meta: {} }, undefined,
    { 'cf-connecting-ip': '127.0.0.2', 'cf-colo': 'PEK', 'cf-country': 'CN' });
  assert.deepEqual(JSON.parse(db.prepare("SELECT meta FROM analytics_events WHERE id = 'network'").get().meta), { ip: '127.0.0.2', colo: 'PEK', loc: 'CN' });
});

test('admin and private endpoints preserve authentication responses and reject non-admin users', async t => {
  const { request } = await app(t, true);
  for (const path of ['/admin/analytics', '/meta', '/versions', '/latest']) {
    assert.equal((await request(path)).status, 401);
    assert.deepEqual((await request(path)).body, { message: '未登录' });
    assert.equal((await request(path, 'GET', undefined, 'invalid')).status, 401);
  }
  assert.deepEqual((await request('/admin/analytics', 'GET', undefined, 'ordinary')).body, { message: '无管理员权限' });
  assert.equal((await request('/admin/analytics', 'GET', undefined, 'ordinary')).status, 403);
  for (const token of ['lovexl', 'wanghao0902', 'de88903']) assert.equal((await request('/admin/analytics?sections=overview', 'GET', undefined, token)).status, 200);
});

// Adapt the original worker's D1 API to the same SQLite engine for response parity.
function d1(db) {
  return { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: db.prepare(sql).run(...args) }; }
    };
  } };
}
test('all admin analytics sections match worker responses with populated events', async t => {
  const { db, request } = await app(t, true);
  const events = [
    ['page_view', {}], ['page_engagement', { durationMs: 900, activeTimeMs: 500, scrollPct: 75, pageTab: 'home' }],
    ['session_start', {}], ['session_heartbeat', {}], ['ai_used', {}],
    ['notify_enabled', { platforms: ['pc', 'serverchan3'], hasBark: true }],
    ['notify_used', { platform: 'pc' }], ['switch_worker_run', {}], ['switch_worker_run', { reason: 'switch-cron' }],
    ['ad_slot_view', { slotId: 'one', visibleMs: 100 }], ['ad_slot_click', { slotId: 'one' }],
    ['premium_survey_submit', { interestOptions: ['a'], priceOption: 'b', completedOptions: ['c'], customText: 'hello' }],
    ['holdings_save', { status: 'success' }], ['markets_open', { status: 'error' }],
    ['network_trace', { cnReachable: true, cnLatency: 23, colo: 'PEK', loc: 'CN', ip: '1.2.3.4' }],
    ['network_trace', { cnReachable: false, cnError: 'timeout', colo: 'PEK', loc: 'CN' }]
  ].map(([type, meta], i) => ({ id: `parity-${i}`, type, meta, visitorId: 'visitor', userId: 'lovexl', username: 'lovexl', path: '/home' }));
  await request('/analytics/track', 'POST', { events });
  // Worker owns auth tables; cn-data reads the separate auth DB.
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT); CREATE TABLE sessions (token_hash TEXT, user_id TEXT, expires_at TEXT)');
  for (const name of ['lovexl', 'wanghao0902', 'de88903', 'ordinary']) db.prepare('INSERT INTO users VALUES (?, ?)').run(name, name);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sha256Hex('lovexl'), 'lovexl', new Date(Date.now() + 3600000).toISOString());
  const sections = ['overview', 'traffic', 'pages', 'activity', 'ads', 'engagement', 'survey', 'featureDetails', 'network', 'recent'];
  for (const section of ['', ...sections]) {
    const suffix = section ? `?sections=${section}` : '';
    const actual = await request(`/admin/analytics${suffix}`, 'GET', undefined, 'lovexl');
    assert.equal(actual.status, 200, section);
    const expected = await worker.fetch(new Request(`http://local/api/sync/admin/analytics${suffix}`, { headers: { Authorization: 'Bearer lovexl' } }), { DB: d1(db) });
    const expectedBody = await expected.json();
    assert.equal(expected.status, 200, JSON.stringify(expectedBody));
    delete actual.body.generatedAt; delete expectedBody.generatedAt;
    assert.deepEqual(actual.body, expectedBody, section || 'all');
    assert.equal(actual.body.cards.registeredUsers, section === '' || section === 'overview' ? 4 : 0);
  }
});

test('latest roundtrip, meta, unchanged, same-end writes, conflict and versions history', async t => {
  const { request } = await app(t);
  assert.deepEqual((await request(`/meta${user}`)).body, { version: null, updatedAt: '', keyCount: 0, bytes: 0, contentHash: '', lastEndId: '', lastEndType: '' });
  assert.deepEqual((await request(`/latest${user}`)).body, { version: null, encryptedEnvelope: null });
  assert.deepEqual((await request(`/versions${user}`)).body, { currentVersion: null, versions: [] });
  assert.equal((await request(`/latest${user}`, 'PUT', {})).status, 400);
  const first = (await request(`/latest${user}`, 'PUT', put('a'))).body;
  assert.equal(first.version, 1); assert.equal(first.sameEnd, false);
  const latest = (await request(`/latest${user}`)).body;
  assert.deepEqual(latest.encryptedEnvelope, envelope()); assert.equal(latest.kvKey, 'backup:test');
  assert.deepEqual((await request(`/meta${user}`)).body, { version: 1, updatedAt: first.updatedAt, keyCount: 2, bytes: JSON.stringify(envelope()).length, contentHash: 'a', lastEndId: 'a', lastEndType: 'web' });
  const unchanged = (await request(`/latest${user}`, 'PUT', put('a', 'other', 999))).body;
  assert.deepEqual(unchanged, { version: 1, updatedAt: first.updatedAt, keyCount: 2, bytes: first.bytes, unchanged: true });
  const sameEnd = (await request(`/latest${user}`, 'PUT', put('b', 'a', 999))).body;
  assert.equal(sameEnd.version, 1); assert.equal(sameEnd.sameEnd, true);
  assert.equal((await request(`/latest${user}`, 'PUT', put('c', 'other', 0))).status, 409);
  assert.equal((await request(`/latest${user}`, 'PUT', put('c', 'other', 1))).body.version, 2);
  const versions = (await request(`/versions${user}&limit=2`)).body;
  assert.equal(versions.currentVersion, 2);
  assert.deepEqual(versions.versions.map(v => [v.version, v.current, v.source, v.contentHash]), [[2, true, 'current', 'c'], [1, false, 'history', 'a']]);
  assert.equal((await request(`/versions${user}&limit=1`)).body.versions.length, 1);
  assert.equal((await request('/latest?user_id=other')).body.version, null);
});

test('rollback validates codes, archives current version and restores target envelope', async t => {
  const { db, request } = await app(t);
  const rollback = body => request(`/versions/rollback${user}`, 'POST', body);
  for (const [body, status, code] of [[{}, 400, 'VERSION_REQUIRED'], [{ version: 1 }, 400, 'BASE_VERSION_REQUIRED'], [{ version: 1, baseVersion: 0 }, 404, 'BACKUP_NOT_FOUND']]) {
    const res = await rollback(body); assert.equal(res.status, status); assert.equal(res.body.code, code);
  }
  await request(`/latest${user}`, 'PUT', put('a'));
  await request(`/latest${user}`, 'PUT', put('b', 'b', 1));
  for (const [body, status, code] of [[{ version: 1, baseVersion: 1 }, 409, 'REVISION_MISMATCH'], [{ version: 999, baseVersion: 2 }, 404, 'VERSION_NOT_FOUND']]) {
    const res = await rollback(body); assert.equal(res.status, status); assert.equal(res.body.code, code);
  }
  assert.deepEqual((await rollback({ version: 2, baseVersion: 2 })).body, { version: 2, unchanged: true });
  const original = db.prepare('SELECT envelope FROM backup_versions WHERE user_id = ? AND version = 1').get('test').envelope;
  for (const corrupt of ['not JSON', JSON.stringify({ ciphertext: 'x', source: 'wrong', crypto: {} })]) {
    db.prepare('UPDATE backup_versions SET envelope = ? WHERE user_id = ? AND version = 1').run(corrupt, 'test');
    const res = await rollback({ version: 1, baseVersion: 2 }); assert.equal(res.status, 409); assert.equal(res.body.code, 'VERSION_CORRUPTED');
  }
  db.prepare('UPDATE backup_versions SET envelope = ? WHERE user_id = ? AND version = 1').run(original, 'test');
  const restored = await rollback({ version: 1, baseVersion: 2 });
  assert.equal(restored.body.version, 3); assert.equal(restored.body.rolledBackFrom, 1);
  assert.deepEqual((await request(`/latest${user}`)).body.encryptedEnvelope, envelope('a'));
  assert.equal((await request(`/meta${user}`)).body.lastEndType, 'version-rollback');
  assert.deepEqual((await request(`/versions${user}&limit=100`)).body.versions.map(v => v.version), [3, 2, 1]);
});

test('latest integrity checks reject modified ciphertext and invalid JSON; missing legacy blob stays empty', async t => {
  const { db, request } = await app(t);
  await request(`/latest${user}`, 'PUT', put('a'));
  db.prepare("UPDATE backups SET envelope = 'broken' WHERE user_id = ?").run('test');
  let res = await request(`/latest${user}`); assert.equal(res.status, 409); assert.equal(res.body.code, 'STORAGE_CORRUPTED');
  db.prepare("UPDATE backups SET cipher_sha256 = '' WHERE user_id = ?").run('test');
  res = await request(`/latest${user}`); assert.equal(res.status, 409); assert.equal(res.body.code, 'STORAGE_CORRUPTED');
  db.prepare("UPDATE backups SET envelope = '' WHERE user_id = ?").run('test');
  assert.deepEqual((await request(`/latest${user}`)).body, { version: null, encryptedEnvelope: null });
});

test('health and probe are public; probe HTML matches original except relative report URL', async t => {
  const { request } = await app(t);
  const health = await request('/health'); assert.equal(health.status, 200); assert.equal(health.body.ok, true); assert.equal(health.body.service, 'sync'); assert.ok(Number.isFinite(Date.parse(health.body.at)));
  const probe = await request('/probe'); assert.equal(probe.status, 200); assert.equal(probe.headers.get('content-type'), 'text/html; charset=utf-8');
  const source = readFileSync(new URL('../../../workers/sync/src/index.js', import.meta.url), 'utf8');
  const literal = source.split('\n').find(line => line.startsWith('const PROBE_HTML = ')).slice('const PROBE_HTML = '.length, -1);
  assert.equal(probe.body, JSON.parse(literal).replace('https://api.freebacktrack.tech/api/sync/analytics/track', '/api/sync/analytics/track'));
});
