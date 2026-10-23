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
  t.after(() => {
    closeAuthServiceDb(authDb);
    rmSync(directory, { recursive: true, force: true });
  });
  const plain = registerUser(authDb, { username: 'plain', clientPasswordHash: CLIENT_HASH });
  const vip = registerUser(authDb, { username: 'vipuser', clientPasswordHash: CLIENT_HASH });
  authDb.prepare('INSERT INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES (?, ?, NULL, ?, ?)')
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

  await t.test('pre-migration auth DB skips checks', () => {
    const legacyPath = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT); CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, created_at TEXT, expires_at TEXT);');
    legacy.close();
    const openLegacy = () => new DatabaseSync(legacyPath, { readOnly: true });
    assert.equal(enforceRoutePermission({ authorization: 'Bearer whatever' }, '/api/account/v1/manifest', { openDb: openLegacy }), null);
  });
});
