// Email verification endpoints: send-code / verify / save / status / enable / disable.
// Port of workers/notify email verification flow to cn-data.
// Resend API calls are mocked by stubbing global fetch.
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
const AUTH_TOKEN = 'test-bearer-token-for-email-test';
const TEST_EMAIL = 'test@example.com';

function setupAuth(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cn-data-email-test-auth-'));
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

// Mock Resend API - captures the sent code from the email body
function mockResend(t, sentCodes) {
  const originalFetch = global.fetch;
  const originalToken = process.env.RESEND_TOKEN;
  process.env.RESEND_TOKEN = 'test-token';

  global.fetch = async (url, options) => {
    const urlStr = String(url);
    // Pass through localhost requests to the test server
    if (urlStr.includes('127.0.0.1')) {
      return originalFetch(url, options);
    }
    // Mock Resend API
    if (urlStr === 'https://api.resend.com/emails') {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      const body = JSON.parse(options.body);
      assert.equal(body.from, 'notify@freebacktrack.tech');
      assert.deepEqual(body.to, [TEST_EMAIL]);
      // Extract the 6-digit code from the text body
      const match = body.text.match(/验证码：(\d{6})/);
      if (match) sentCodes.push(match[1]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'mock-msg-id' }),
        text: async () => ''
      };
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  };

  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RESEND_TOKEN;
    else process.env.RESEND_TOKEN = originalToken;
  });
}

test('GET /api/notify/email/status returns empty when not configured', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const { status, body } = await request('/api/notify/email/status', 'GET');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.email.maskedAddress, '');
  assert.equal(body.email.verified, false);
});

test('POST /api/notify/email/send-code sends verification email', async (t) => {
  setupAuth(t);
  const sentCodes = [];
  mockResend(t, sentCodes);
  const { request } = await app(t);

  const { status, body } = await request('/api/notify/email/send-code', 'POST', { email: TEST_EMAIL });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.maskedAddress.includes('*'));
  assert.ok(body.expiresAt);
  assert.equal(sentCodes.length, 1);
  assert.match(sentCodes[0], /^\d{6}$/);
});

test('POST /api/notify/email/send-code rejects invalid email', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const { status, body } = await request('/api/notify/email/send-code', 'POST', { email: 'not-an-email' });
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('POST /api/notify/email/send-code enforces rate limit (2 min cooldown)', async (t) => {
  setupAuth(t);
  const sentCodes = [];
  mockResend(t, sentCodes);
  const { request } = await app(t);

  const first = await request('/api/notify/email/send-code', 'POST', { email: TEST_EMAIL });
  assert.equal(first.status, 200);

  const second = await request('/api/notify/email/send-code', 'POST', { email: TEST_EMAIL });
  assert.equal(second.status, 429);
  assert.ok(second.body.error.includes('2 分钟'));
});

test('full flow: send-code -> verify -> save -> status', async (t) => {
  setupAuth(t);
  const sentCodes = [];
  mockResend(t, sentCodes);
  const { request, db } = await app(t);

  // 1. Send code
  const sendRes = await request('/api/notify/email/send-code', 'POST', { email: TEST_EMAIL });
  assert.equal(sendRes.status, 200);
  const code = sentCodes[0];
  assert.ok(code);

  // 2. Verify with wrong code fails
  const wrongRes = await request('/api/notify/email/verify', 'POST', { email: TEST_EMAIL, code: '000000' });
  assert.equal(wrongRes.status, 400);
  assert.ok(wrongRes.body.error.includes('验证码错误'));

  // 3. Verify with correct code
  const verifyRes = await request('/api/notify/email/verify', 'POST', { email: TEST_EMAIL, code });
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.body.ok, true);
  assert.equal(verifyRes.body.verified, true);
  assert.equal(verifyRes.body.pendingSave, true);
  assert.ok(verifyRes.body.verifiedAt);

  // 4. Save the verified email
  const saveRes = await request('/api/notify/email/save', 'POST', { email: TEST_EMAIL });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.body.ok, true);
  assert.equal(saveRes.body.email.verified, true);
  assert.equal(saveRes.body.email.enabled, true);

  // 5. Status shows configured
  const statusRes = await request('/api/notify/email/status', 'GET');
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.email.verified, true);
  assert.equal(statusRes.body.email.enabled, true);
  assert.ok(statusRes.body.email.maskedAddress.includes('*'));
});

test('POST /api/notify/email/verify rejects invalid code format', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const { status } = await request('/api/notify/email/verify', 'POST', { email: TEST_EMAIL, code: 'abc' });
  assert.equal(status, 400);
});

test('POST /api/notify/email/save requires verification first', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const { status, body } = await request('/api/notify/email/save', 'POST', { email: TEST_EMAIL });
  assert.equal(status, 400);
  assert.ok(body.error.includes('尚未完成'));
});

test('POST /api/notify/email/enable requires verified email', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const { status } = await request('/api/notify/email/enable', 'POST', {});
  assert.equal(status, 400);
});

test('POST /api/notify/email/disable works without verification', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const { status, body } = await request('/api/notify/email/disable', 'POST', {});
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.email.enabled, false);
});

test('requires auth', async (t) => {
  setupAuth(t);
  const { request } = await app(t);
  const { status } = await request('/api/notify/email/status', 'GET', undefined, null);
  assert.equal(status, 401);
});
