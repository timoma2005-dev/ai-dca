import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb, closeDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { loginUser, registerUser } from '../src/auth.js';
import {
  BOOTSTRAP_GRANTS,
  SESSION_COOKIE_NAME,
  buildAuthPayload,
  computeAccess,
  readRequestToken,
  requirePerm,
} from '../src/rbac.js';
import { grantUserRole, RbacError, setRolePermissions, createRole } from '../src/rbacAdmin.js';

const CLIENT_HASH = 'a'.repeat(64);

function reg(db, username) {
  const result = registerUser(db, { username, clientPasswordHash: CLIENT_HASH });
  assert.equal(result.status, 200, `register ${username}`);
  return result;
}

function grantDirect(db, userId, role, expiresAt = null) {
  db.prepare('INSERT OR REPLACE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, role, expiresAt, 'test', new Date().toISOString());
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function flatten(menus) {
  return menus.flatMap((m) => [m, ...flatten(m.children || [])]);
}

describe('rbac: inheritance, expiry and payload', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => closeDb(db));

  it('guest sees user menus locked and only public menus accessible', () => {
    const payload = buildAuthPayload(db, null);
    assert.equal(payload.topRole.code, 'guest');
    const menus = flatten(payload.menus);
    const byKey = Object.fromEntries(menus.map((m) => [m.key, m]));
    for (const key of ['home', 'markets', 'shares', 'articles']) assert.equal(byKey[key].locked, false, key);
    for (const key of ['holdings', 'tradePlans', 'fundSwitch', 'notify', 'dataRepair']) {
      assert.equal(byKey[key].locked, true, key);
      assert.equal(byKey[key].requiredRole.code, 'user');
    }
    for (const key of ['adminRadar', 'adminAuction', 'adminQuant', 'adminRbac']) assert.equal(byKey[key], undefined, key);
  });

  it('user inherits guest, sees VIP/SVIP menus locked, admin menu hidden', () => {
    const u = reg(db, 'plainuser');
    assert.deepEqual(u.roles.map((r) => r.code), ['user']);
    assert.equal(u.topRole.code, 'user');
    assert.equal(u.isAdmin, false);
    const byKey = Object.fromEntries(flatten(u.menus).map((m) => [m.key, m]));
    for (const key of ['home', 'holdings', 'tradePlans', 'fundSwitch', 'notify', 'dataRepair']) assert.equal(byKey[key].locked, false, key);
    assert.equal(byKey.adminRadar.locked, true);
    assert.equal(byKey.adminRadar.requiredRole.code, 'vip');
    assert.equal(byKey.adminAuction.requiredRole.code, 'svip');
    assert.equal(byKey.adminQuant.requiredRole.code, 'svip');
    assert.equal(byKey.adminRbac, undefined);
    assert.ok(u.perms.includes('api:account'));
    assert.ok(!u.perms.includes('api:nasdaq-radar'));
  });

  it('svip inherits vip and user (svip→vip→user)', () => {
    const u = reg(db, 'rich');
    grantDirect(db, u.userId, 'svip');
    const access = computeAccess(db, { id: u.userId, username: 'rich' });
    assert.ok(access.closure.has('vip') && access.closure.has('user') && access.closure.has('guest'));
    assert.ok(access.perms.has('menu:adminRadar:access'));
    assert.ok(access.perms.has('menu:adminAuction:access'));
    assert.ok(access.perms.has('menu:holdings:access'));
    assert.ok(!access.perms.has('menu:adminRbac:view'));
    assert.equal(access.topRole.code, 'svip');
  });

  it('multiple roles are unioned', () => {
    const u = reg(db, 'multi');
    grantDirect(db, u.userId, 'vip');
    grantDirect(db, u.userId, 'auction_viewer');
    const access = computeAccess(db, { id: u.userId, username: 'multi' });
    assert.ok(access.perms.has('menu:adminRadar:access'));
    assert.ok(access.perms.has('menu:adminAuction:access'));
    assert.ok(!access.perms.has('menu:adminQuant:access'));
  });

  it('expired roles are ignored automatically', () => {
    const u = reg(db, 'expiring');
    grantDirect(db, u.userId, 'vip', new Date(Date.now() - 1000).toISOString());
    let payload = buildAuthPayload(db, { id: u.userId, username: 'expiring' });
    assert.deepEqual(payload.roles.map((r) => r.code), ['user']);
    assert.ok(!payload.perms.includes('menu:adminRadar:access'));
    const future = new Date(Date.now() + 86400000).toISOString();
    grantDirect(db, u.userId, 'vip', future);
    payload = buildAuthPayload(db, { id: u.userId, username: 'expiring' });
    assert.deepEqual(payload.roles.map((r) => [r.code, r.expiresAt]), [['vip', future], ['user', null]]);
    assert.ok(payload.perms.includes('menu:adminRadar:access'));
    // 用 now 参数模拟时间流逝：到期后自动失效。
    const later = new Date(Date.now() + 2 * 86400000).toISOString();
    const access = computeAccess(db, { id: u.userId, username: 'expiring' }, { now: later });
    assert.ok(!access.perms.has('menu:adminRadar:access'));
  });

  it('permVersion changes when roles change', () => {
    const u = reg(db, 'versioned');
    const before = buildAuthPayload(db, { id: u.userId, username: 'versioned' }).permVersion;
    grantDirect(db, u.userId, 'vip');
    const after = buildAuthPayload(db, { id: u.userId, username: 'versioned' }).permVersion;
    assert.notEqual(before, after);
  });

  it('bootstrap accounts: lovexl superadmin, wanghao0902/de88903 admin; only once', () => {
    assert.equal(BOOTSTRAP_GRANTS.lovexl, 'superadmin');
    const root = reg(db, 'lovexl');
    assert.equal(root.topRole.code, 'superadmin');
    assert.equal(root.isAdmin, true);
    const admin = reg(db, 'wanghao0902');
    assert.equal(admin.topRole.code, 'admin');
    assert.ok(admin.perms.includes('api:rbac-admin'));
    assert.ok(!admin.perms.includes('api:rbac-grant-admin'));
    // 撤销后再次登录不会被重新授予。
    db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role_code = 'admin'").run(admin.userId);
    const again = loginUser(db, { username: 'wanghao0902', clientPasswordHash: CLIENT_HASH });
    assert.equal(again.topRole.code, 'user');
    assert.equal(again.isAdmin, false);
  });
});

describe('rbac: token handling and requirePerm', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => closeDb(db));

  it('reads bearer first, then the session cookie', () => {
    assert.equal(readRequestToken({ authorization: 'Bearer acc_1', cookie: `${SESSION_COOKIE_NAME}=acc_2` }), 'acc_1');
    assert.equal(readRequestToken({ cookie: `foo=1; ${SESSION_COOKIE_NAME}=acc_2` }), 'acc_2');
    assert.equal(readRequestToken({}), '');
  });

  it('401 for guest/invalid/expired token, 403 for insufficient role, 200 when allowed', () => {
    const u = reg(db, 'checker');
    assert.equal(requirePerm(db, {}, 'menu:home:access').ok, true);
    assert.equal(requirePerm(db, {}, 'menu:holdings:access').status, 401);
    assert.equal(requirePerm(db, bearer('acc_forged'), 'menu:home:access').status, 401);
    assert.equal(requirePerm(db, bearer(u.accessToken), 'menu:holdings:access').ok, true);
    assert.equal(requirePerm(db, bearer(u.accessToken), 'api:nasdaq-radar').status, 403);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), u.userId);
    assert.equal(requirePerm(db, bearer(u.accessToken), 'menu:holdings:access').status, 401);
    assert.equal(requirePerm(db, {}, 'not a perm').status, 400);
  });
});

describe('rbac: admin restrictions', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => closeDb(db));

  function accessOf(result) {
    return computeAccess(db, { id: result.userId, username: result.username });
  }

  it('admin can grant vip with expiry but cannot appoint admin; superadmin can', () => {
    const root = reg(db, 'lovexl');
    const admin = reg(db, 'de88903');
    const target = reg(db, 'target');
    const expires = new Date(Date.now() + 3600_000).toISOString();
    grantUserRole(db, accessOf(admin), { userId: target.userId, role: 'vip', expiresAt: expires });
    assert.equal(accessOf(target).topRole.code, 'vip');
    assert.throws(() => grantUserRole(db, accessOf(admin), { userId: target.userId, role: 'admin' }), (e) => e instanceof RbacError && e.status === 403);
    grantUserRole(db, accessOf(root), { userId: target.userId, role: 'admin' });
    assert.equal(accessOf(target).isAdmin, true);
    assert.throws(() => grantUserRole(db, accessOf(root), { userId: target.userId, role: 'superadmin' }), (e) => e.status === 403);
    assert.throws(() => grantUserRole(db, accessOf(admin), { userId: target.userId, role: 'vip', expiresAt: '2000-01-01' }), (e) => e.status === 400);
    const audit = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'role.grant'").get().n;
    assert.equal(audit, 2);
  });

  it('admin cannot escalate via custom roles or privileged perms', () => {
    reg(db, 'lovexl');
    const admin = reg(db, 'de88903');
    assert.throws(() => createRole(db, accessOf(admin), { code: 'shadow', name: 'x', parent: 'admin' }), (e) => e.status === 403);
    createRole(db, accessOf(admin), { code: 'helper', name: '助理', parent: 'user' });
    assert.throws(() => setRolePermissions(db, accessOf(admin), 'helper', ['api:rbac-admin']), (e) => e.status === 403);
    assert.throws(() => setRolePermissions(db, accessOf(admin), 'admin', ['api:account']), (e) => e.status === 403);
    setRolePermissions(db, accessOf(admin), 'helper', ['menu:adminRadar:view', 'menu:adminRadar:access']);
    assert.throws(() => setRolePermissions(db, accessOf(admin), 'helper', ['menu:nope:view']), (e) => e.status === 400);
  });
});

describe('rbac: HTTP endpoints', () => {
  let db;
  let server;
  let base;

  beforeEach(async () => {
    db = openDb(':memory:');
    server = createServer(createApp(db));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb(db);
  });

  async function call(path, { method = 'GET', token, cookie, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {}, headers: res.headers };
  }

  it('login sets an httpOnly Secure SameSite=Lax cookie and returns rbac payload; logout clears it', async () => {
    await call('/api/sync/auth/register', { method: 'POST', body: { username: 'cookieman', passwordHash: CLIENT_HASH } });
    const login = await call('/api/sync/auth/login', { method: 'POST', body: { username: 'cookieman', passwordHash: CLIENT_HASH } });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE_NAME}=acc_`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.ok(Array.isArray(login.json.menus) && login.json.permVersion);
    assert.equal(login.json.topRole.code, 'user');

    const cookie = `${SESSION_COOKIE_NAME}=${login.json.accessToken}`;
    assert.equal((await call('/api/sync/auth/check?perm=menu:holdings:access', { cookie })).status, 200);
    const out = await call('/api/sync/auth/logout', { method: 'POST', cookie });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await call('/api/sync/auth/check?perm=menu:holdings:access', { cookie })).status, 401);
  });

  it('GET /me requires a valid token; /menus falls back to guest', async () => {
    assert.equal((await call('/api/sync/auth/me')).status, 401);
    assert.equal((await call('/api/sync/auth/me', { token: 'acc_bogus' })).status, 401);
    const guest = await call('/api/sync/auth/menus', { token: 'acc_bogus' });
    assert.equal(guest.status, 200);
    assert.equal(guest.json.loggedIn, false);
    assert.equal(guest.json.topRole.code, 'guest');
    const reg1 = await call('/api/sync/auth/register', { method: 'POST', body: { username: 'meuser', passwordHash: CLIENT_HASH } });
    const me = await call('/api/sync/auth/me', { token: reg1.json.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.json.username, 'meuser');
    assert.deepEqual(me.json.roles, [{ code: 'user', name: '普通用户', expiresAt: null }]);
  });

  it('check returns 401 / 403 / 200 for nginx auth_request', async () => {
    const user = (await call('/api/sync/auth/register', { method: 'POST', body: { username: 'radaruser', passwordHash: CLIENT_HASH } })).json;
    assert.equal((await call('/api/sync/auth/check?perm=api:nasdaq-radar')).status, 401);
    assert.equal((await call('/api/sync/auth/check?perm=api:nasdaq-radar', { token: user.accessToken })).status, 403);
    grantDirect(db, user.userId, 'vip');
    const ok = await call('/api/sync/auth/check?perm=api:nasdaq-radar', { token: user.accessToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-auth-username'), 'radaruser');
    assert.equal((await call('/api/sync/auth/check?perm=menu:adminAuction:access', { token: user.accessToken })).status, 403);
    assert.equal((await call('/api/sync/auth/check?perm=menu:home:access')).status, 200);
  });

  it('tampered client fields (locked/roles/isAdmin in body or headers) are ignored', async () => {
    const user = (await call('/api/sync/auth/register', { method: 'POST', body: { username: 'tamper', passwordHash: CLIENT_HASH, roles: ['admin'], isAdmin: true } })).json;
    assert.equal(user.isAdmin, false);
    const res = await fetch(`${base}/api/sync/auth/me`, {
      headers: { Authorization: `Bearer ${user.accessToken}`, 'X-Roles': 'admin', 'X-Perms': 'api:rbac-admin', Cookie: 'perms=api:rbac-admin; locked=false' },
    });
    const me = await res.json();
    const radar = flatten(me.menus).find((m) => m.key === 'adminRadar');
    assert.equal(radar.locked, true);
    assert.equal(me.isAdmin, false);
    const admin = await fetch(`${base}/api/sync/auth/admin/users?q=tamper`, {
      headers: { Authorization: `Bearer ${user.accessToken}`, 'X-Roles': 'admin' },
    });
    assert.equal(admin.status, 403);
    const forged = await call('/api/sync/auth/admin/users', { token: 'acc_forged_admin' });
    assert.equal(forged.status, 401);
  });

  it('admin endpoints: search, grant/revoke, roles, perms, menus, audit; superadmin-only admin appointment', async () => {
    const root = (await call('/api/sync/auth/register', { method: 'POST', body: { username: 'lovexl', passwordHash: CLIENT_HASH } })).json;
    const admin = (await call('/api/sync/auth/register', { method: 'POST', body: { username: 'wanghao0902', passwordHash: CLIENT_HASH } })).json;
    const target = (await call('/api/sync/auth/register', { method: 'POST', body: { username: 'someone', passwordHash: CLIENT_HASH } })).json;

    const search = await call('/api/sync/auth/admin/users?q=some', { token: admin.accessToken });
    assert.equal(search.status, 200);
    assert.equal(search.json.users[0].username, 'someone');

    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const grant = await call(`/api/sync/auth/admin/users/${target.userId}/roles`, { method: 'POST', token: admin.accessToken, body: { role: 'svip', expiresAt } });
    assert.equal(grant.status, 200);
    const me = await call('/api/sync/auth/me', { token: target.accessToken });
    assert.equal(me.json.topRole.code, 'svip');
    assert.equal(me.json.roles[0].expiresAt, expiresAt);

    const appoint = await call(`/api/sync/auth/admin/users/${target.userId}/roles`, { method: 'POST', token: admin.accessToken, body: { role: 'admin' } });
    assert.equal(appoint.status, 403);
    const appointRoot = await call(`/api/sync/auth/admin/users/${target.userId}/roles`, { method: 'POST', token: root.accessToken, body: { role: 'admin' } });
    assert.equal(appointRoot.status, 200);
    const revokeByAdmin = await call(`/api/sync/auth/admin/users/${target.userId}/roles/admin`, { method: 'DELETE', token: admin.accessToken });
    assert.equal(revokeByAdmin.status, 403);
    const revokeByRoot = await call(`/api/sync/auth/admin/users/${target.userId}/roles/admin`, { method: 'DELETE', token: root.accessToken });
    assert.equal(revokeByRoot.status, 200);

    const roles = await call('/api/sync/auth/admin/roles', { token: admin.accessToken });
    assert.ok(roles.json.roles.find((r) => r.code === 'vip').effectivePerms.includes('menu:holdings:access'));
    const created = await call('/api/sync/auth/admin/roles', { method: 'POST', token: admin.accessToken, body: { code: 'beta', name: '内测', parent: 'user' } });
    assert.equal(created.status, 200);
    const perms = await call('/api/sync/auth/admin/roles/beta/permissions', { method: 'PUT', token: admin.accessToken, body: { perms: ['menu:adminQuant:access'] } });
    assert.equal(perms.status, 200);
    const patched = await call('/api/sync/auth/admin/roles/beta', { method: 'PATCH', token: admin.accessToken, body: { name: '内测用户' } });
    assert.equal(patched.status, 200);
    const delSystem = await call('/api/sync/auth/admin/roles/vip', { method: 'DELETE', token: admin.accessToken });
    assert.equal(delSystem.status, 400);
    assert.equal((await call('/api/sync/auth/admin/roles/beta', { method: 'DELETE', token: admin.accessToken })).status, 200);

    const menu = await call('/api/sync/auth/admin/menus', { method: 'POST', token: admin.accessToken, body: { key: 'labs', label: '实验室', group: 'admin', sort: 200 } });
    assert.equal(menu.status, 200);
    const allPerms = await call('/api/sync/auth/admin/permissions', { token: admin.accessToken });
    assert.ok(allPerms.json.permissions.some((p) => p.code === 'menu:labs:view'));
    assert.equal((await call('/api/sync/auth/admin/menus/labs', { method: 'PATCH', token: admin.accessToken, body: { label: '实验' } })).status, 200);
    assert.equal((await call('/api/sync/auth/admin/menus/labs', { method: 'DELETE', token: admin.accessToken })).status, 200);
    assert.equal((await call('/api/sync/auth/admin/menus/adminRbac', { method: 'DELETE', token: admin.accessToken })).status, 400);

    const audit = await call('/api/sync/auth/admin/audit?limit=100', { token: root.accessToken });
    assert.equal(audit.status, 200);
    const actions = audit.json.entries.map((e) => e.action);
    for (const action of ['role.grant', 'role.revoke', 'role.create', 'role.permissions', 'role.delete', 'menu.create', 'menu.delete']) {
      assert.ok(actions.includes(action), action);
    }
    const userAudit = await call('/api/sync/auth/admin/audit', { token: target.accessToken });
    assert.equal(userAudit.status, 403);
  });
});
