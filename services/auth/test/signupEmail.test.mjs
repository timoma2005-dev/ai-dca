import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb, closeDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { maskEmail, normalizeEmail } from '../src/signupEmail.js';

const CLIENT_HASH = 'b'.repeat(64);

describe('signup email + invite landing', () => {
  let db;
  let server;
  let base;
  let sent;

  beforeEach(async () => {
    db = openDb(':memory:');
    sent = [];
    const deliverEmail = async ({ to, code }) => { sent.push({ to, code }); };
    server = createServer(createApp(db, { deliverEmail, requireSignupEmail: true }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb(db);
  });

  async function call(path, { method = 'POST', body, token, ip = '1.1.1.1' } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Real-IP': ip };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  }

  async function registerWithEmail(username, email, extra = {}) {
    const sentRes = await call('/api/sync/auth/email/send-code', { body: { email }, ip: extra.ip });
    assert.equal(sentRes.status, 200);
    const code = sent.at(-1).code;
    return call('/api/sync/auth/register', { body: { username, passwordHash: CLIENT_HASH, email, emailCode: code, ...extra }, ip: extra.ip });
  }

  it('normalizes and masks emails', () => {
    assert.equal(normalizeEmail(' Foo@Bar.COM '), 'foo@bar.com');
    assert.equal(normalizeEmail('bad'), '');
    assert.equal(maskEmail('alice@example.com'), 'al***@example.com');
  });

  it('requires a verified email code to register', async () => {
    const noEmail = await call('/api/sync/auth/register', { body: { username: 'alice', passwordHash: CLIENT_HASH } });
    assert.equal(noEmail.status, 400);
    await call('/api/sync/auth/email/send-code', { body: { email: 'alice@example.com' } });
    const wrong = await call('/api/sync/auth/register', { body: { username: 'alice', passwordHash: CLIENT_HASH, email: 'alice@example.com', emailCode: '000000' === sent[0].code ? '111111' : '000000' } });
    assert.equal(wrong.status, 400);
    const ok = await call('/api/sync/auth/register', { body: { username: 'alice', passwordHash: CLIENT_HASH, email: 'alice@example.com', emailCode: sent[0].code } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.email, 'alice@example.com');
    const me = await call('/api/sync/auth/email', { method: 'GET', token: ok.json.accessToken });
    assert.equal(me.json.email, 'alice@example.com');
  });

  it('rejects reused emails and rate-limits resend', async () => {
    await registerWithEmail('alice', 'alice@example.com');
    const dup = await call('/api/sync/auth/email/send-code', { body: { email: 'ALICE@example.com' } });
    assert.equal(dup.status, 409);
    await call('/api/sync/auth/email/send-code', { body: { email: 'bob@example.com' } });
    const again = await call('/api/sync/auth/email/send-code', { body: { email: 'bob@example.com' } });
    assert.equal(again.status, 429);
  });

  it('locks the code after too many wrong attempts', async () => {
    await call('/api/sync/auth/email/send-code', { body: { email: 'carol@example.com' } });
    const bad = sent[0].code === '999999' ? '999998' : '999999';
    for (let i = 0; i < 5; i += 1) {
      const res = await call('/api/sync/auth/register', { body: { username: 'carol', passwordHash: CLIENT_HASH, email: 'carol@example.com', emailCode: bad } });
      assert.equal(res.status, 400);
    }
    const locked = await call('/api/sync/auth/register', { body: { username: 'carol', passwordHash: CLIENT_HASH, email: 'carol@example.com', emailCode: sent[0].code } });
    assert.equal(locked.status, 429);
  });

  it('lets an existing user bind an email', async () => {
    db.prepare("INSERT INTO users (id, username, password_hash, password_salt, created_at, updated_at) VALUES ('u_old', 'olduser', 'x', '', '2026-01-01', '2026-01-01')").run();
    const reg = await registerWithEmail('dave', 'dave@example.com');
    const token = reg.json.accessToken;
    const unauth = await call('/api/sync/auth/email/send-code', { body: { email: 'new@example.com', purpose: 'bind' } });
    assert.equal(unauth.status, 401);
    const send = await call('/api/sync/auth/email/send-code', { body: { email: 'new@example.com', purpose: 'bind' }, token, ip: '2.2.2.2' });
    assert.equal(send.status, 200);
    const bind = await call('/api/sync/auth/email/bind', { body: { email: 'new@example.com', emailCode: sent.at(-1).code }, token });
    assert.equal(bind.status, 200);
    assert.equal(bind.json.maskedEmail, 'ne***@example.com');
  });

  it('exposes invite landing info and per-invitee progress', async () => {
    const inviter = await registerWithEmail('inviter', 'inviter@example.com', { ip: '3.3.3.3' });
    const summary = await call('/api/sync/auth/invite', { method: 'GET', token: inviter.json.accessToken });
    const code = summary.json.code;
    const check = await call(`/api/sync/auth/invite/check?code=${code.toLowerCase()}`, { method: 'GET' });
    assert.deepEqual([check.json.valid, check.json.inviter], [true, 'in***']);
    const invalid = await call('/api/sync/auth/invite/check?code=ZZZZZZ', { method: 'GET' });
    assert.equal(invalid.json.valid, false);
    await registerWithEmail('friend', 'friend@example.com', { ip: '4.4.4.4', inviteCode: code });
    const after = await call('/api/sync/auth/invite', { method: 'GET', token: inviter.json.accessToken });
    assert.equal(after.json.total, 1);
    assert.equal(after.json.invitees[0].name, 'fr***');
    assert.equal(after.json.invitees[0].status, 'rewarded');
    assert.equal(after.json.rewarded, 1);
    assert.equal(typeof after.json.invitees[0].activeDays, 'number');
  });
});

it("disposable email domains are rejected, common providers allowed", async () => {
  const { isDisposableEmail } = await import("../src/signupEmail.js");
  assert.equal(isDisposableEmail("a@mailinator.com"), true);
  assert.equal(isDisposableEmail("a@x.mailinator.com"), true);
  assert.equal(isDisposableEmail("a@10minutemail.com"), true);
  for (const ok of ["a@gmail.com", "a@qq.com", "a@163.com", "a@outlook.com", "a@foxmail.com"]) assert.equal(isDisposableEmail(ok), false);
});
