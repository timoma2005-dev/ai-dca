import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb as openAuthServiceDb, closeDb as closeAuthServiceDb } from '../../auth/src/db.js';
import { registerUser } from '../../auth/src/auth.js';
import { computeAccess } from '../../auth/src/rbac.js';
import { HttpError } from '../src/authSession.js';
import { sha256Hex } from '../src/account/store.js';
import { computeUserPerms, enforceRoutePermission, readToken, requiredPermFor } from '../src/rbacGuard.js';

const CLIENT_HASH = 'a'.repeat(64);

test('route → permission mapping', () => {
  assert.equal(requiredPermFor('/api/account/v1/manifest'), 'api:account');
  assert.equal(requiredPermFor('/api/account/transactions'), 'api:account');
  assert.equal(requiredPermFor('/api/notify/switch/config'), 'api:fund-switch');
  assert.equal(requiredPermFor('/api/notify/rules'), 'api:notify');
  assert.equal(requiredPermFor('/api/notify/health'), null);
  assert.equal(requiredPermFor('/sync'), 'api:sync');
  assert.equal(requiredPermFor('/api/sync/backup'), 'api:sync');
  assert.equal(requiredPermFor('/api/geo'), null);
  assert.equal(requiredPermFor('/health'), null);
});

test('readToken prefers bearer, falls back to session cookie', () => {
  assert.equal(readToken({ Authorization: 'Bearer abc' }), 'abc');
  assert.equal(readToken({ cookie: 'x=1; aidca_session=acc_9' }), 'acc_9');
  assert.equal(readToken({}), '');
});

test('guard matches auth service permissions and enforces 403 on shared auth DB', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cn-data-rbac-'));
  const path = join(directory, 'auth.sqlite');
  const authDb = openAuthServiceDb(path);
  const previousFailOpen = process.env.CN_DATA_AUTH_FAIL_OPEN;
  t.after(() => {
    closeAuthServiceDb(authDb);
    rmSync(directory, { recursive: true, force: true });
    if (previousFailOpen === undefined) delete process.env.CN_DATA_AUTH_FAIL_OPEN;
    else process.env.CN_DATA_AUTH_FAIL_OPEN = previousFailOpen;
  });
  const plain = registerUser(authDb, { username: 'plain', clientPasswordHash: CLIENT_HASH });
  const vip = registerUser(authDb, { username: 'vipuser', clientPasswordHash: CLIENT_HASH });
  // registerUser 已通过注册赠礼自动授予 vip（见 SIGNUP_GIFT）；用 INSERT OR IGNORE 兼容关闭赠礼的环境。
  authDb.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES (?, ?, NULL, ?, ?)')
    .run(vip.userId, 'vip', 'test', new Date().toISOString());
  // 一个被剥夺 api:account 的自定义场景：把 user 的 api:account 去掉。
  const openDb = () => new DatabaseSync(path, { readOnly: true });

  await t.test('perm sets are identical to the auth service', () => {
    const ro = openDb();
    try {
      for (const u of [plain, vip]) {
        const expected = [...computeAccess(authDb, { id: u.userId, username: u.username }).perms].sort();
        assert.deepEqual([...computeUserPerms(ro, u.userId)].sort(), expected);
      }
    } finally { ro.close(); }
  });

  await t.test('allowed / deferred / forbidden', () => {
    const headers = { authorization: `Bearer ${plain.accessToken}` };
    assert.equal(enforceRoutePermission(headers, '/api/account/v1/manifest', { openDb }), null);
    assert.equal(enforceRoutePermission({}, '/api/account/v1/manifest', { openDb }), null, 'no token → route handles 401');
    assert.equal(enforceRoutePermission({ authorization: 'Bearer forged' }, '/api/account/v1/manifest', { openDb }), null, 'invalid token → route handles 401');
    authDb.prepare("DELETE FROM role_permissions WHERE role_code = 'user' AND perm_code = 'api:account'").run();
    assert.throws(() => enforceRoutePermission(headers, '/api/account/v1/manifest', { openDb }),
      (error) => error instanceof HttpError && error.status === 403);
    // 其它接口仍可用；cookie 同样生效。
    assert.equal(enforceRoutePermission({ cookie: `aidca_session=${plain.accessToken}` }, '/api/notify/rules', { openDb }), null);
  });

  await t.test('pre-migration auth DB skips checks only when fail-open is enabled', () => {
    const legacyPath = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT); CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, created_at TEXT, expires_at TEXT);');
    const now = new Date().toISOString();
    legacy.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u', 'legacy-user');
    legacy.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256Hex('legacy-token'), 'u', now, new Date(Date.now() + 3600000).toISOString());
    legacy.close();
    const openLegacy = () => new DatabaseSync(legacyPath, { readOnly: true });
    const headers = { authorization: 'Bearer legacy-token' };
    // 显式开启兜底：session 有效但 RBAC 表未就绪时放行，交回路由层。
    process.env.CN_DATA_AUTH_FAIL_OPEN = '1';
    assert.equal(enforceRoutePermission(headers, '/api/account/v1/manifest', { openDb: openLegacy }), null);
    // 默认 fail-closed：RBAC 表未就绪时直接 503，不放行。
    delete process.env.CN_DATA_AUTH_FAIL_OPEN;
    assert.throws(
      () => enforceRoutePermission(headers, '/api/account/v1/manifest', { openDb: openLegacy }),
      (error) => error instanceof HttpError && error.status === 503 && error.code === 'AUTH_UNAVAILABLE'
    );
  });

  await t.test('fail-closed when auth DB cannot be opened', () => {
    // 模拟 openAuthDb 捕获打开异常后返回 null 的真实行为。
    const openMissing = () => null;
    const headers = { authorization: 'Bearer whatever' };
    delete process.env.CN_DATA_AUTH_FAIL_OPEN;
    assert.throws(
      () => enforceRoutePermission(headers, '/api/account/v1/manifest', { openDb: openMissing }),
      (error) => error instanceof HttpError && error.status === 503 && error.code === 'AUTH_UNAVAILABLE'
    );
    process.env.CN_DATA_AUTH_FAIL_OPEN = '1';
    assert.equal(enforceRoutePermission(headers, '/api/account/v1/manifest', { openDb: openMissing }), null);
  });
});
