import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { handleChannelToggle, readBark, readServerChan3 } from '../src/notify/channelToggle.js';
import { writeUserRecord } from '../src/notify/routes.js';
import { deliverCycleNotification } from '../src/notify/cycleDelivery.js';
import { deliverTestNotification } from '../src/notify/testDelivery.js';

const account = { userId: 'u1', clientId: 'c1' };
const notification = { eventId: 'e1', title: 't', body: 'b' };
function memoryDb(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}
function seed(db, channel, value) {
  writeUserRecord(db, account, 'client-channel', `${account.clientId}::${channel}`, value, new Date().toISOString());
}

test('existing credentials default enabled, including Bark URL normalization', t => {
  const db = memoryDb(t);
  seed(db, 'bark', { barkDeviceKey: 'https://api.day.app/key/title' });
  seed(db, 'serverchan3', { serverChan3: { uid: ' uid ', sendKey: ' key ' } });
  assert.deepEqual(readBark(db, account), { deviceKey: 'key', enabled: true });
  assert.deepEqual(readServerChan3(db, account), { uid: 'uid', sendKey: 'key', enabled: true });
});

test('enable requires credentials; disable is always allowed', t => {
  const db = memoryDb(t);
  for (const [channel, code] of [['bark', 'BARK_NOT_CONFIGURED'], ['serverchan3', 'SERVERCHAN3_NOT_CONFIGURED']]) {
    assert.throws(() => handleChannelToggle(db, account, channel, true), e => e.status === 400 && e.code === code);
    assert.equal(handleChannelToggle(db, account, channel, false).ok, true);
  }
});

test('disabled channels skip both delivery paths without any network calls', async t => {
  const db = memoryDb(t);
  seed(db, 'bark', { barkDeviceKey: 'key' });
  seed(db, 'serverchan3', { serverChan3: { uid: 'uid', sendKey: 'key' } });
  for (const channel of ['bark', 'serverchan3']) handleChannelToggle(db, account, channel, false);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected fetch'); });
  const cycle = await deliverCycleNotification(db, account, notification);
  const manual = await deliverTestNotification(db, account, notification);
  for (const results of [cycle.results, manual.events[0].channels]) {
    for (const channel of ['bark', 'serverchan3']) {
      const result = results.find(r => r.channel === channel);
      assert.equal(result.status, 'skipped');
      assert.match(result.detail, /已关闭/);
    }
  }
  assert.equal(calls, 0);
});

test('resource credentials override while client enabled flag remains authoritative', t => {
  const db = memoryDb(t);
  seed(db, 'bark', { barkDeviceKey: 'old', enabled: false });
  seed(db, 'serverchan3', { serverChan3: { uid: 'old', sendKey: 'old' }, enabled: false });
  for (const [id, value] of [['bark', { barkDeviceKey: 'resource', enabled: true }], ['serverchan3', { serverChan3Uid: 'resource', serverChan3SendKey: 'key', enabled: true }]]) {
    db.prepare("INSERT INTO account_resource_records (user_id, resource, record_id, payload, created_at, updated_at) VALUES (?, 'notify/client-config', ?, ?, '2026-10-15', '2026-10-15')").run(account.userId, `channel:${id}`, JSON.stringify(value));
  }
  assert.deepEqual(readBark(db, account), { deviceKey: 'resource', enabled: false });
  assert.deepEqual(readServerChan3(db, account), { uid: 'resource', sendKey: 'key', enabled: false });
  handleChannelToggle(db, account, 'bark', true);
  assert.equal(readBark(db, account).enabled, true);
});

test('a failing Bark send does not stop ServerChan3 or PC in either delivery loop', async t => {
  const db = memoryDb(t);
  seed(db, 'bark', { barkDeviceKey: 'key' });
  seed(db, 'serverchan3', { serverChan3: { uid: 'uid', sendKey: 'key' } });
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    if (url.includes('api.day.app')) throw new Error('Bark unavailable');
    return new Response('ok');
  });
  const cycle = await deliverCycleNotification(db, account, notification);
  const manual = await deliverTestNotification(db, account, notification);
  for (const results of [cycle.results, manual.events[0].channels]) {
    assert.equal(results.find(r => r.channel === 'bark').status, 'failed');
    assert.equal(results.find(r => r.channel === 'serverchan3').status, 'delivered');
    assert.equal(results.find(r => r.channel === 'pc').status, 'queued');
  }
  assert.equal(urls.length, 4);
});

import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
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


test('authenticated management routes, status semantics and settings preserve disabled flags', async t => {
  setupAuth(t);
  const { db, request } = await app(t);
  for (const channel of ['bark', 'serverchan3']) {
    const missing = await request(`/api/notify/${channel}/enable`, 'POST', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, channel === 'bark' ? 'BARK_NOT_CONFIGURED' : 'SERVERCHAN3_NOT_CONFIGURED');
    assert.equal((await request(`/api/notify/${channel}/status`, 'GET', undefined, null)).status, 401);
  }
  await request('/api/notify/settings', 'POST', { barkDeviceKey: 'key', serverChan3: { uid: 'uid', sendKey: 'key' } });
  for (const resource of [false, true]) {
    if (resource) {
      db.prepare("INSERT INTO account_resource_records (user_id, resource, record_id, payload, created_at, updated_at) VALUES (?, 'notify/client-config', 'channel:bark', ?, '2026-10-15', '2026-10-15')").run(USER, JSON.stringify({ barkDeviceKey: 'resource-key' }));
    }
    for (const channel of ['bark', 'serverchan3']) {
      assert.equal((await request(`/api/notify/${channel}/disable`, 'POST', {})).status, 200);
    }
    assert.equal((await request('/api/notify/settings', 'POST', { barkDeviceKey: 'new-key', serverChan3: { uid: 'new-uid', sendKey: 'new-key' } })).status, 200);
    const summary = (await request('/api/notify/status')).body.data.channels;
    for (const [channel, key] of [['bark', 'bark'], ['serverchan3', 'serverChan3']]) {
      const status = await request(`/api/notify/${channel}/status`);
      assert.equal(status.status, 200);
      assert.deepEqual(status.body.binding, { scope: 'account', accountClientId: CLIENT });
      assert.equal(status.body[key].enabled, false);
      assert.equal(status.body[key].configured, true);
      assert.equal(summary[key].enabled, false);
      assert.equal(summary[key].configured, false);
      if (resource) {
        const row = db.prepare("SELECT payload FROM account_resource_records WHERE user_id = ? AND record_id = ?").get(USER, `channel:${channel}`);
        assert.equal(JSON.parse(row.payload).enabled, false);
      }
      assert.equal((await request(`/api/notify/${channel}/enable`, 'POST', {})).status, 200);
    }
  }
});

test('new and legacy channel routes share channel and action semantics', async t => {
  setupAuth(t);
  const { request } = await app(t);
  await request('/api/notify/settings', 'POST', { barkDeviceKey: 'device-key', serverChan3: { uid: 'uid', sendKey: 'key' } });
  for (const channel of ['bark', 'serverchan3']) {
    const key = channel === 'bark' ? 'bark' : 'serverChan3';
    for (const prefix of ['/api/notify/channels', '/api/notify']) {
      assert.equal((await request(`${prefix}/${channel}/status`, 'GET', undefined, null)).status, 401);
      for (const action of ['disable', 'enable']) {
        assert.equal((await request(`${prefix}/${channel}/${action}`, 'POST', {})).status, 200);
        for (const readPrefix of ['/api/notify/channels', '/api/notify']) {
          const status = await request(`${readPrefix}/${channel}/status`);
          assert.equal(status.status, 200);
          assert.equal(status.body[key].enabled, action === 'enable');
          assert.equal(status.body[key].configured, true);
        }
      }
    }
  }
});
