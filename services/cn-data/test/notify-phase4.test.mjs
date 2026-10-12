// Phase 4 endpoints tested through the HTTP app with real Bearer sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { outboxStats } from '../src/outbox.js';
import { sha256Hex } from '../src/account/store.js';

const USER = 'testuser';
const CLIENT = 'account:testuser';
const AUTH_TOKEN = 'phase4-valid-token';

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

const publicRoutes = [
  ['GET', '/api/geo', 200, { country: 'CN' }],
  ['POST', '/api/notify/gotify-account', 410, { error: 'Gotify 通知能力已移除。' }],
  ['POST', '/api/notify/gcm/register', 410, { error: '旧版 Android GCM/FCM 推送已下线。' }],
  ['DELETE', '/api/notify/quant/research', 410, { error: '量化研究功能已移除。' }],
  ['GET', '/api/notify/health', 200, { ok: true }],
  ['GET', '/api/notify/switch/test-nav', 501, { error: 'NOT_IMPLEMENTED', message: '诊断接口暂未迁移' }],
  ['POST', '/api/notify/test', 501, { error: 'NOT_IMPLEMENTED', message: '测试推送请走 CF worker' }],
  ['POST', '/api/notify/run', 501, { error: 'NOT_IMPLEMENTED', message: '手动检测请走 CF worker' }],
  ['PUT', '/api/wechat/login', 410, { error: '微信接口已下线' }],
  ['GET', '/api/wechat/notification-prefs', 410, { error: '微信接口已下线' }],
  ['DELETE', '/api/notify/admin/users', 404, { error: '未找到通知接口。' }],
  ['GET', '/api/notify/quick/send', 404, { error: '未找到通知接口。' }],
  ['POST', '/api/notify/bark/callback', 404, { error: '未找到通知接口。' }]
];

for (const [method, path, status, body] of publicRoutes) {
  test(`${method} ${path} returns the exact public response without auth`, async (t) => {
    const { request } = await app(t);
    assert.deepEqual(await request(path, method, undefined, null), { status, body });
  });
}

test('Phase 4 method restrictions return 405 before auth', async (t) => {
  const { request } = await app(t);
  for (const [method, path] of [
    ['POST', '/api/geo'], ['GET', '/api/notify/gotify-account'], ['GET', '/api/notify/gcm/register'],
    ['POST', '/api/notify/health'], ['POST', '/api/notify/switch/test-nav'],
    ['GET', '/api/notify/test'], ['GET', '/api/notify/run'],
    ['GET', '/api/notify/settings'], ['GET', '/api/notify/sync'],
    ['DELETE', '/api/notify/quick/send'], ['PUT', '/api/notify/bark/callback']
  ]) {
    assert.deepEqual(await request(path, method, undefined, null), {
      status: 405, body: { message: 'Method not allowed' }
    }, `${method} ${path}`);
  }
});

test('any-method retired routes and both callback methods have worker-shaped responses', async (t) => {
  const { request } = await app(t);
  for (const path of ['/api/wechat/login', '/api/wechat/notification-prefs', '/api/notify/quant/x', '/api/notify/admin/x']) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const expected = path.includes('/admin/') ? { status: 404, body: { error: '未找到通知接口。' } }
        : { status: 410, body: { error: path.includes('/quant/') ? '量化研究功能已移除。' : '微信接口已下线' } };
      assert.deepEqual(await request(path, method, undefined, null), expected);
    }
  }
  for (const path of ['/api/notify/quick/x', '/api/notify/bark/x']) {
    for (const method of ['GET', 'POST']) {
      assert.deepEqual(await request(path, method, undefined, null), { status: 404, body: { error: '未找到通知接口。' } });
    }
  }
});

test('settings and sync require valid, unexpired Bearer sessions', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  for (const path of ['/api/notify/settings', '/api/notify/sync']) {
    for (const token of [null, 'wrong-token', 'expired-token']) {
      const result = await request(path, 'POST', {}, token);
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, { error: token === 'expired-token' ? '登录已过期，请重新登录' : token ? '登录状态已失效，请重新登录' : '请先登录账户',
        code: token === 'expired-token' ? 'SESSION_EXPIRED' : 'UNAUTHORIZED' });
    }
  }
});

for (const resourceBacked of [false, true]) {
  test(`settings round-trip (${resourceBacked ? 'account resource' : 'legacy channel records'}) preserves and clears secrets`, async (t) => {
    setupAuth(t);
    const { request, db } = await app(t);
    const now = new Date().toISOString();
    if (resourceBacked) {
      db.prepare(`INSERT INTO account_resource_records
        (user_id, resource, record_id, payload, created_at, updated_at)
        VALUES (?, 'notify/client-config', '__meta__', '{}', ?, ?)`).run(USER, now, now);
    }
    // Records belonging to another account must remain untouched, even with identical keys.
    db.prepare(`INSERT INTO notify_user_records(owner_user_id, record_type, record_id, payload, created_at, updated_at)
      VALUES ('other', 'client-channel', ?, '{"barkDeviceKey":"bark-key"}', ?, ?)`)
      .run('account:other::bark', now, now);
    const result = await request('/api/notify/settings?clientId=other', 'POST', {
      clientId: 'other', accountUsername: 'other', barkDeviceKey: ' bark-key ',
      serverChan3: { uid: ' uid-1 ', sendKey: 'sendkey-abcdef-1234' }
    });
    assert.deepEqual(result, { status: 200, body: { ok: true, setup: {
      barkDeviceKey: 'bark-key', serverChan3: { uid: 'uid-1', sendKeyMasked: 'sendke...1234', configured: true },
      clientId: CLIENT, accountClientId: CLIENT, accountUsername: USER, clientLabel: `账号通知 · ${USER}`
    } } });
    const status = (await request('/api/notify/status')).body.data.channels;
    assert.deepEqual(status.bark, { configured: true, deviceKey: 'bark-key' });
    assert.deepEqual(status.serverChan3, result.body.setup.serverChan3);
    const preserved = await request('/api/notify/settings', 'POST', { serverChan3: { uid: 'uid-2', sendKey: '' } });
    assert.deepEqual(preserved.body.setup.serverChan3, { uid: 'uid-2', sendKeyMasked: 'sendke...1234', configured: true });
    assert.deepEqual((await request('/api/notify/settings', 'POST', {})).body, preserved.body);
    assert.deepEqual((await request('/api/notify/status')).body.data.channels.serverChan3, preserved.body.setup.serverChan3);
    const cleared = await request('/api/notify/settings', 'POST', { barkDeviceKey: '', serverChan3: {} });
    assert.deepEqual(cleared.body.setup.serverChan3, { uid: '', sendKeyMasked: '', configured: false });
    assert.deepEqual((await request('/api/notify/status')).body.data.channels.bark, { configured: false, deviceKey: '' });
    if (resourceBacked) {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM notify_user_records WHERE owner_user_id = ? AND record_type='client-channel'").get(USER).n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM account_resource_records WHERE user_id = ? AND record_id LIKE 'channel:%'").get(USER).n, 2);
    } else {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM notify_user_records WHERE owner_user_id = ? AND record_type='client-channel'").get(USER).n, 2);
    }
    assert.equal(JSON.parse(db.prepare("SELECT payload FROM notify_user_records WHERE owner_user_id='other'").get().payload).barkDeviceKey, 'bark-key');
    assert.deepEqual(outboxStats(db), { pending: 0, processing: 0, dead: 0 });
  });
}

test('sync normalizes payload, prunes rule states, splits venue arrays and exposes status metadata without outbox', async (t) => {
  setupAuth(t);
  const { request, db } = await app(t);
  const now = new Date().toISOString();
  const seed = { clientLabel: 'Existing label', state: {
    ruleStates: { 'plan:p1': { kept: true }, removed: {}, [`${CLIENT}:market-alerts:exchange`]: { kept: true },
      [`${CLIENT}:market-alerts:otc`]: {}, [`${CLIENT}:holding-alerts`]: {} },
    recentEvents: [{ eventId: 'previous' }], lastRunAt: 'earlier'
  }, meta: { lastCheckedAt: 'earlier' } };
  db.prepare(`INSERT INTO notify_user_records(owner_user_id, record_type, record_id, payload, created_at, updated_at)
    VALUES (?, 'client', ?, ?, ?, ?)`).run(USER, CLIENT, JSON.stringify(seed), now, now);
  const result = await request('/api/notify/sync', 'POST', {
    clientId: 'someone-else', accountUsername: 'someone-else', syncedAt: '2026-10-12T12:00:00Z',
    plans: [{ id: 'p1', symbol: 'SH510300' }, { id: '', symbol: 'invalid' }, { id: 'off', symbol: 'x', isConfigured: false }],
    dcaList: [{ id: 'd1', symbol: 'SH510300' }],
    marketAlerts: [
      { id: 'm1', symbol: 'SH510300', fundKind: 'exchange', threshold: 3 },
      { id: 'm2', symbol: '001001', kind: 'qdii', threshold: 4 },
      { id: 'm3', symbol: '001002', fundKind: 'otc', threshold: 2 }, { id: 'bad', threshold: 0 }
    ], holdingAlerts: [{ id: 'h1', symbol: 'SH510300', threshold: 2, holdingCost: 1 }], vix: { level: 'high' }
  });
  const counts = { planRuleCount: 1, dcaRuleCount: 1, marketAlertCount: 3, holdingAlertCount: 1, totalRuleCount: 6 };
  assert.deepEqual(result, { status: 200, body: { ok: true, clientId: CLIENT, accountClientId: CLIENT,
    counts, lastSyncedAt: '2026-10-12T12:00:00Z' } });
  const stored = JSON.parse(db.prepare("SELECT payload FROM notify_user_records WHERE owner_user_id=? AND record_type='client'").get(USER).payload);
  assert.equal(stored.ownerUserId, USER);
  assert.equal(stored.accountUsername, USER);
  assert.equal(stored.clientLabel, 'Existing label');
  assert.equal(stored.payload.plans.length, 1);
  assert.equal(stored.payload.vix, undefined);
  assert.deepEqual(stored.state, { ...seed.state, ruleStates: Object.fromEntries(Object.entries(seed.state.ruleStates).filter(([id]) => id !== 'removed')) });
  assert.deepEqual(stored.meta.counts, counts);
  const rows = db.prepare("SELECT user_id, payload FROM notify_configs WHERE config_key='market-alerts' ORDER BY user_id").all();
  assert.deepEqual(rows.map(row => [row.user_id, JSON.parse(row.payload).map(alert => alert.id)]), [
    [`${CLIENT}:exchange`, ['m1']], [`${CLIENT}:otc`, ['m2', 'm3']]
  ]);
  const status = (await request('/api/notify/status')).body.data;
  assert.deepEqual(status.rules, { planRuleCount: 1, dcaRuleCount: 1, totalRuleCount: 6 });
  assert.equal(status.timestamps.lastSyncedAt, result.body.lastSyncedAt);
  assert.equal(status.timestamps.lastCheckedAt, 'earlier');
  assert.deepEqual(outboxStats(db), { pending: 0, processing: 0, dead: 0 });
  const empty = await request('/api/notify/sync', 'POST', {});
  assert.equal(empty.status, 200);
  assert.equal(empty.body.counts.totalRuleCount, 0);
  assert.ok(Number.isFinite(Date.parse(empty.body.lastSyncedAt)));
  assert.deepEqual(db.prepare("SELECT payload FROM notify_configs WHERE config_key='market-alerts'").all().map(row => JSON.parse(row.payload)), [[], []]);
});

test('settings backfills an aggregate resource and preserves unrelated email configuration', async (t) => {
  setupAuth(t);
  const { request, db } = await app(t);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO account_resources(user_id, resource, feature, payload, updated_at)
    VALUES (?, 'notify/client-config', 'notify', ?, ?)`).run(USER, JSON.stringify({
    clientLabel: 'Resource label', barkDeviceKey: 'old-bark', serverChan3Uid: 'old-uid',
    serverChan3SendKey: 'existing-secret-1234', email: { address: 'test@example.com', verified: true, enabled: true }
  }), now);
  const result = await request('/api/notify/settings', 'POST', { serverChan3: { uid: 'new-uid', sendKey: '' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.setup.clientLabel, 'Resource label');
  assert.equal(result.body.setup.barkDeviceKey, 'old-bark');
  assert.deepEqual(result.body.setup.serverChan3, { uid: 'new-uid', sendKeyMasked: 'existi...1234', configured: true });
  const status = (await request('/api/notify/status')).body.data.channels;
  assert.equal(status.email.configured, true);
  assert.deepEqual(status.serverChan3, result.body.setup.serverChan3);
  const channel = db.prepare(`SELECT payload, content_hash, bytes, revision FROM account_resource_records
    WHERE user_id = ? AND record_id = 'channel:serverchan3'`).get(USER);
  assert.deepEqual(JSON.parse(channel.payload), { serverChan3Uid: 'new-uid', serverChan3SendKey: 'existing-secret-1234' });
  assert.ok(channel.content_hash);
  assert.equal(channel.bytes, Buffer.byteLength(channel.payload));
  assert.ok(channel.revision > 1);
  assert.deepEqual(outboxStats(db), { pending: 0, processing: 0, dead: 0 });
});
