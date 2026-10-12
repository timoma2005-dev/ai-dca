import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { handleAccountV1Route } from '../src/account/routes.js';
import { resolveUserId } from '../src/authSession.js';

test('Bearer session authentication and unavailable-DB legacy fallback', (t) => {
  const dir = mkdtempSync('/tmp/cn-data-auth-');
  const path = `${dir}/auth.sqlite`;
  const previousPath = process.env.AUTH_DB_PATH;
  const originalWarn = console.warn;
  const db = openDb(':memory:');
  t.after(() => {
    console.warn = originalWarn;
    if (previousPath === undefined) delete process.env.AUTH_DB_PATH;
    else process.env.AUTH_DB_PATH = previousPath;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const auth = new DatabaseSync(path);
  auth.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
    INSERT INTO users VALUES ('u', 'session-user');`);
  const hash = (token) => createHash('sha256').update(token).digest('hex');
  const insert = auth.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  insert.run(hash('valid-token'), 'u', new Date(Date.now() + 3600000).toISOString());
  insert.run(hash('expired-token'), 'u', new Date(Date.now() - 3600000).toISOString());
  insert.run(hash('revoked-token'), 'u', new Date(Date.now() + 3600000).toISOString());
  auth.close();
  process.env.AUTH_DB_PATH = path;
  const request = (route, headers = {}, method = 'GET', body = {}) =>
    handleAccountV1Route(db, method, new URL(`http://localhost/api/account/v1/${route}`), body, headers);
  const validHeaders = { Authorization: 'Bearer valid-token' };
  const manifest = request('manifest?user_id=attacker', validHeaders, 'GET', { user_id: 'other-attacker' });
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.username, 'u');
  assert.deepEqual(resolveUserId(new URL('http://localhost'), {}, validHeaders), { id: 'u', username: 'session-user' });
  assert.equal(request('manifest', { authorization: 'BEARER   valid-token  ' }).status, 200);
  for (const headers of [{}, { authorization: 'Bearer   ' }, { authorization: 'Basic valid-token' }]) {
    const result = request('manifest?user_id=u', headers);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'UNAUTHORIZED', message: '请先登录账户' });
  }
  const wrong = request('manifest?user_id=u', { authorization: 'Bearer wrong-token' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { error: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录' });
  const expired = request('manifest', { authorization: 'Bearer expired-token' });
  assert.equal(expired.status, 401);
  assert.deepEqual(expired.body, { error: 'SESSION_EXPIRED', message: '登录已过期，请重新登录' });
  assert.equal(request('user/data-notice', validHeaders).status, 200);
  assert.equal(request('user/data-notice?user_id=u').status, 401);
  assert.equal(request('migrations/legacy/discard?user_id=u', {}, 'POST').status, 401);
  assert.equal(request('migrations/legacy/discard', validHeaders, 'POST').body.error, 'CONFIRMATION_REQUIRED');
  for (const route of ['migrations/legacy', 'migrations/legacy/skip', 'bundle']) {
    assert.equal(request(`${route}?user_id=u`).status, 401);
  }
  assert.equal(request('health').status, 200);
  const updatedAuth = new DatabaseSync(path);
  updatedAuth.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash('revoked-token'));
  updatedAuth.close();
  assert.equal(request('manifest', { authorization: 'Bearer revoked-token' }).status, 401);
  process.env.AUTH_DB_PATH = `${dir}/nonexistent/path.sqlite`;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  assert.equal(request('migrations/legacy?user_id=u').status, 200);
  assert.equal(request('migrations/legacy?user_id=u').status, 200);
  assert.deepEqual(warnings, [['[cn-data] auth DB unavailable, falling back to query user_id (dev/test only)']]);
  assert.equal(request('migrations/legacy?user_id=u', {}, 'GET', { user_id: 'other' }).body.error, 'CONFLICTING_USER_ID');
  assert.equal(request('migrations/legacy').body.error, 'USER_ID_REQUIRED');
  assert.equal(request('manifest', {}, 'GET', { user_id: ' u ' }).body.username, 'u');
});
