// POST /api/notify/test: test notification delivery via bark/serverchan3.
// External HTTP calls are mocked by stubbing global fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { sha256Hex } from '../src/account/store.js';
import { createServer } from 'node:http';

const USER = 'testuser';
const AUTH_TOKEN = '[REDACTED]';

function setupAuth(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cn-data-notify-test-auth-'));
  const path = join(directory, 'auth.sqlite');
  const auth = new DatabaseSync(path);
  try {
    auth.exec(readFileSync(new URL('../../auth/migrations/001-init.sql', import.meta.url), 'utf8'));
    const now = new Date().toISOString();
    auth.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(USER, USER, 'hash', 'salt', now, now);
    auth.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(sha256Hex(AUTH_TOKEN), USER, now, new Date(Date.now() + 3600000).toISOString());
  } finally { auth.close(); }
  const previousPath = process.env.AUTH_DB_PATH;
  process.env.AUTH_DB_PATH = path;
  t.after(() => {
    if (previousPath === undefined) delete process.env.AUTH_DB_PATH;
    else process.env.AUTH_DB_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  });
}

function memory(t) { const db = openDb(':memory:'); t.after(() => db.close()); return db; }

async function app(t) {
  const db = memory(t);
  const server = createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    async request(path, method = 'POST', body, token = AUTH_TOKEN) {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: res.status, body: await res.json() };
    }
  };
}

function seedServerChan3(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO account_resource_records
    (user_id, resource, record_id, payload, deleted, created_at, updated_at)
    VALUES (?, 'notify/client-config', 'channel:serverchan3', ?, 0, ?, ?)`)
    .run(USER, JSON.stringify({ serverChan3Uid: '12345', serverChan3SendKey: 'sctptestkey' }), now, now);
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const urlStr = String(url);
    // Only mock external calls; let localhost (test server) through
    if (urlStr.includes('127.0.0.1') || urlStr.includes('localhost')) {
      return original(url, init);
    }
    return handler(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
}

test('POST /api/notify/test without token returns 401', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const res = await request('/api/notify/test', 'POST', { title: 'hi' }, null);
  assert.equal(res.status, 401);
});

test('POST /api/notify/test delivers via serverchan3 and saves event', async (t) => {
  setupAuth(t);
  const { db, request } = await app(t);
  seedServerChan3(db);

  let fetchCalled = null;
  mockFetch(t, async (url, init) => {
    fetchCalled = { url: String(url), body: String(init?.body || '') };
    return new Response('ok', { status: 200 });
  });

  const res = await request('/api/notify/test', 'POST', {
    title: '测试标题',
    body: '测试正文',
    targetChannel: 'serverchan3'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(fetchCalled, 'fetch should have been called');
  assert.match(fetchCalled.url, /12345\.push\.ft07\.com/);
  assert.match(fetchCalled.url, /sctptestkey/);

  const summary = res.body.summary;
  assert.equal(summary.deliveredCount, 1);
  const channels = summary.events[0].channels;
  assert.equal(channels.length, 1);
  assert.equal(channels[0].channel, 'serverchan3');
  assert.equal(channels[0].status, 'delivered');

  // Event saved to notify_user_records
  const row = db.prepare(`SELECT payload FROM notify_user_records
    WHERE owner_user_id = ? AND record_type = 'event'`).get(USER);
  assert.ok(row, 'event should be saved');
});

test('POST /api/notify/test with unconfigured bark returns skipped', async (t) => {
  setupAuth(t);
  const { request } = await app(t);

  let fetchCalled = false;
  mockFetch(t, async () => { fetchCalled = true; return new Response('ok', { status: 200 }); });

  const res = await request('/api/notify/test', 'POST', {
    title: 't', body: 'b', targetChannel: 'bark'
  });
  assert.equal(res.status, 200);
  assert.equal(fetchCalled, false, 'no HTTP call for unconfigured bark');
  const channels = res.body.summary.events[0].channels;
  assert.equal(channels[0].status, 'skipped');
  assert.match(channels[0].detail, /未配置/);
});

test('POST /api/notify/test email channel returns not-configured skip', async (t) => {
  setupAuth(t);
  const { request } = await app(t);

  let fetchCalled = false;
  mockFetch(t, async () => { fetchCalled = true; return new Response('ok', { status: 200 }); });

  const res = await request('/api/notify/test', 'POST', {
    title: 't', body: 'b', targetChannel: 'email'
  });
  assert.equal(res.status, 200);
  assert.equal(fetchCalled, false);
  const channels = res.body.summary.events[0].channels;
  assert.equal(channels[0].channel, 'email');
  assert.equal(channels[0].status, 'skipped');
  assert.match(channels[0].detail, /cn 主机未配置邮件/);
});

test('POST /api/notify/test serverchan3 failure returns failed status', async (t) => {
  setupAuth(t);
  const { db, request } = await app(t);
  seedServerChan3(db);

  mockFetch(t, async () => new Response('bad gateway', { status: 502 }));

  const res = await request('/api/notify/test', 'POST', {
    title: 't', body: 'b', targetChannel: 'serverchan3'
  });
  assert.equal(res.status, 200);
  const channels = res.body.summary.events[0].channels;
  assert.equal(channels[0].status, 'failed');
  assert.equal(res.body.summary.deliveredCount, 0);
});
