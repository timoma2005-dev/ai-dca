import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError, resolveUserId } from '../src/authSession.js';
import { sha256Hex } from '../src/account/store.js';
import { handleAccountV1Route } from '../src/account/routes.js';
import { openDb } from '../src/db.js';

const resolveUser = (headers, url, body) => resolveUserId(url, body, headers).id;

test('account Bearer session authentication', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cn-data-auth-'));
  const path = join(directory, 'auth.sqlite');
  const previousPath = process.env.AUTH_DB_PATH;
  const previousFailOpen = process.env.CN_DATA_AUTH_FAIL_OPEN;
  const auth = new DatabaseSync(path);
  try {
    auth.exec(readFileSync(new URL('../../auth/migrations/001-init.sql', import.meta.url), 'utf8'));
    const now = new Date().toISOString();
    auth.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run('canonical-user', 'username', 'hash', 'salt', now, now);
    const insert = auth.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
    insert.run(sha256Hex('valid-token'), 'canonical-user', now, new Date(Date.now() + 3600000).toISOString());
    insert.run(sha256Hex('expired-token'), 'canonical-user', now, new Date(Date.now() - 3600000).toISOString());
  } finally { auth.close(); }
  process.env.AUTH_DB_PATH = path;
  const db = openDb(':memory:');
  t.after(() => {
    db.close();
    if (previousPath === undefined) delete process.env.AUTH_DB_PATH;
    else process.env.AUTH_DB_PATH = previousPath;
    if (previousFailOpen === undefined) delete process.env.CN_DATA_AUTH_FAIL_OPEN;
    else process.env.CN_DATA_AUTH_FAIL_OPEN = previousFailOpen;
    rmSync(directory, { recursive: true, force: true });
  });
  const url = (route = 'manifest', query = '') => new URL(`http://localhost/api/account/v1/${route}${query}`);
  const headers = { Authorization: 'Bearer valid-token' };
  const expectError = (fn, status, code) => assert.throws(fn, (error) => error instanceof HttpError && error.status === status && error.code === code);
  await t.test('valid token determines identity despite conflicting supplied user ids', () => {
    assert.equal(resolveUser(headers, url('manifest', '?user_id=other'), { user_id: 'another' }), 'canonical-user');
    const result = handleAccountV1Route(db, 'GET', url('manifest', '?user_id=other'), {}, headers);
    assert.equal(result.status, 200);
    assert.equal(result.body.username, 'canonical-user');
    assert.equal(handleAccountV1Route(db, 'GET', url('user/data-notice'), {}, headers).status, 200);
    assert.equal(handleAccountV1Route(db, 'POST', url('migrations/legacy/discard'), { confirmation: 'wrong' }, headers).body.error, 'CONFIRMATION_REQUIRED');
  });
  for (const [name, authorization, code, message] of [
    ['missing header', undefined, 'UNAUTHORIZED', '请先登录账户'],
    ['wrong token', 'Bearer wrong-token', 'UNAUTHORIZED', '登录状态已失效，请重新登录'],
    ['expired session', 'Bearer expired-token', 'SESSION_EXPIRED', '登录已过期，请重新登录']
  ]) {
    await t.test(name, () => {
      const requestHeaders = authorization ? { authorization } : {};
      expectError(() => resolveUser(requestHeaders, url(), { user_id: 'legacy' }), 401, code);
      for (const [method, route] of [['GET', 'manifest'], ['GET', 'user/data-notice'], ['POST', 'migrations/legacy/discard']]) {
        const result = handleAccountV1Route(db, method, url(route, '?user_id=legacy'), { user_id: 'legacy' }, requestHeaders);
        assert.equal(result.status, 401);
        assert.deepEqual(result.body, { error: code, message });
      }
    });
  }
  await t.test('health stays public with an available auth DB', () => {
    assert.equal(handleAccountV1Route(db, 'GET', url('health')).status, 200);
  });
  await t.test('missing auth DB preserves legacy identity and validation when fail-open is enabled', () => {
    process.env.AUTH_DB_PATH = join(directory, 'missing.sqlite');
    process.env.CN_DATA_AUTH_FAIL_OPEN = '1';
    assert.equal(resolveUser({}, url('manifest', '?user_id=query-user'), {}), 'query-user');
    assert.equal(resolveUser({}, url(), { user_id: ' body-user ' }), 'body-user');
    expectError(() => resolveUser({}, url('manifest', '?user_id=a'), { user_id: 'b' }), 400, 'CONFLICTING_USER_ID');
    expectError(() => resolveUser({}, url(), {}), 400, 'USER_ID_REQUIRED');
    assert.equal(handleAccountV1Route(db, 'GET', url('manifest', '?user_id=legacy')).status, 200);
  });
  await t.test('auth DB that cannot be opened preserves legacy fallback when fail-open is enabled', () => {
    process.env.AUTH_DB_PATH = directory;
    process.env.CN_DATA_AUTH_FAIL_OPEN = '1';
    assert.equal(resolveUser({}, url(), { user_id: 'legacy' }), 'legacy');
  });
  await t.test('fail-closed by default when auth DB is unavailable', () => {
    process.env.AUTH_DB_PATH = join(directory, 'missing.sqlite');
    delete process.env.CN_DATA_AUTH_FAIL_OPEN;
    // 即使请求带了 user_id 也不得信任，直接 503。
    expectError(() => resolveUser({}, url('manifest', '?user_id=attacker'), { user_id: 'attacker' }), 503, 'AUTH_UNAVAILABLE');
    const routeResult = handleAccountV1Route(db, 'GET', url('manifest', '?user_id=attacker'), {}, {});
    assert.equal(routeResult.status, 503);
    assert.equal(routeResult.body.error, 'AUTH_UNAVAILABLE');
  });
});
