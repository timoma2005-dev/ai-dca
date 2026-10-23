/* global URL */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RBAC_MANAGED_TABS,
  buildGuestFallback,
  buildUserFallback,
  canAccessMenu,
  evaluateTabAccess,
  flattenMenus,
  isAdminState,
  roleBadgeFor,
  roleRingFor,
  lockLabelFor,
  splitSidebarMenus,
} from '../src/app/rbac/menuModel.js';
import { canAccessAdminAuction, canAccessMenuFromSession, isAnalyticsAdmin } from '../src/app/analytics.js';
import { buildPermissionMatrix, expiryInputToIso } from '../src/app/rbac/rbacAdminApi.js';

// 与 services/auth 种子一致的服务端载荷示例。
function menu(key, group, locked, requiredRole = null, sort = 0) {
  return { key, label: key, tab: key, icon: '', group, sort, subtitle: '', parentKey: null, locked, requiredRole, children: [] };
}
const USER_STATE = {
  loggedIn: true,
  roles: [{ code: 'user', name: '普通用户', expiresAt: null }],
  topRole: { code: 'user', name: '普通用户' },
  menus: [
    menu('home', 'primary', false), menu('holdings', 'primary', false), menu('notify', 'primary', false),
    menu('adminRadar', 'admin', true, { code: 'vip', name: 'VIP' }),
    menu('adminAuction', 'admin', true, { code: 'svip', name: 'SVIP' }),
  ],
  perms: ['menu:home:view', 'menu:home:access', 'menu:holdings:view', 'menu:holdings:access', 'menu:notify:view', 'menu:notify:access', 'menu:adminRadar:view', 'menu:adminAuction:view'],
  permVersion: 'v1',
};

test('guest fallback mirrors the server seed: public menus open, user menus locked, VIP menus hidden', () => {
  const guest = buildGuestFallback();
  const byKey = Object.fromEntries(flattenMenus(guest.menus).map((m) => [m.key, m]));
  for (const key of ['home', 'shares', 'articles']) assert.equal(byKey[key].locked, false, key);
  for (const key of ['markets', 'holdings', 'tradePlans', 'fundSwitch', 'notify', 'dataRepair']) {
    assert.equal(byKey[key].locked, true, key);
    assert.equal(byKey[key].requiredRole.code, 'user');
  }
  for (const key of ['adminRadar', 'adminAuction', 'adminQuant', 'adminRbac']) assert.equal(byKey[key], undefined);
  assert.equal(guest.loggedIn, false);
  assert.ok(RBAC_MANAGED_TABS.has('adminRbac'));
});

test('route guard: guest → login, insufficient role → forbidden with requiredRole, allowed → ok', () => {
  const guest = buildGuestFallback();
  assert.equal(evaluateTabAccess(guest, 'home').status, 'ok');
  assert.equal(evaluateTabAccess(guest, 'holdings').status, 'login');
  assert.equal(evaluateTabAccess(guest, 'adminRadar').status, 'login', 'hidden managed tab also asks guests to log in');
  assert.equal(evaluateTabAccess(USER_STATE, 'holdings').status, 'ok');
  const radar = evaluateTabAccess(USER_STATE, 'adminRadar');
  assert.equal(radar.status, 'forbidden');
  assert.equal(radar.requiredRole.code, 'vip');
  assert.equal(evaluateTabAccess(USER_STATE, 'adminRbac').status, 'forbidden', 'hidden admin tab is forbidden, not silently redirected');
  assert.equal(evaluateTabAccess(USER_STATE, 'strategy').status, 'ok', 'unmanaged legacy tabs are not guarded');
});

test('logged-in fallback (no server menus yet) keeps user features usable and member features locked', () => {
  const user = buildUserFallback();
  assert.equal(evaluateTabAccess(user, 'holdings').status, 'ok');
  const radar = evaluateTabAccess(user, 'adminRadar');
  assert.equal(radar.status, 'forbidden');
  assert.equal(radar.requiredRole.code, 'svip');
  for (const key of ['markets', 'fundSwitch', 'notify']) assert.equal(evaluateTabAccess(user, key).requiredRole?.code, 'vip', key);
  assert.equal(evaluateTabAccess(user, 'adminRbac').status, 'forbidden');
  const admin = buildUserFallback({ isAdmin: true });
  for (const key of ['adminRadar', 'adminAuction', 'adminRbac']) assert.equal(evaluateTabAccess(admin, key).status, 'ok', key);
});

test('route guard never trusts a tampered locked flag without the access permission', () => {
  const tampered = { ...USER_STATE, menus: USER_STATE.menus.map((m) => (m.key === 'adminRadar' ? { ...m, locked: false } : m)) };
  assert.equal(evaluateTabAccess(tampered, 'adminRadar').status, 'forbidden');
  assert.equal(canAccessMenu(tampered, 'adminRadar'), false);
});

test('sidebar split by server group and role badges by top role', () => {
  const { primary, admin } = splitSidebarMenus(USER_STATE.menus);
  assert.deepEqual(primary.map((m) => m.key), ['home', 'holdings', 'notify']);
  assert.deepEqual(admin.map((m) => m.key), ['adminRadar', 'adminAuction']);
  assert.equal(roleBadgeFor({ code: 'vip' }).kind, 'crown');
  assert.equal(roleBadgeFor({ code: 'vip' }).tone, 'gold');
  assert.equal(roleBadgeFor({ code: 'svip' }).kind, 'diamond');
  assert.equal(roleBadgeFor({ code: 'admin' }).kind, 'shield');
  assert.equal(roleBadgeFor({ code: 'superadmin' }).kind, 'shield');
  assert.equal(roleBadgeFor({ code: 'user' }), null);
  assert.equal(roleRingFor({ code: 'vip' }).tier, 'vip');
  assert.equal(roleRingFor({ code: 'svip' }).tier, 'svip');
  assert.equal(roleRingFor({ code: 'admin' }).tier, 'admin');
  assert.equal(roleRingFor({ code: 'superadmin' }).tier, 'superadmin');
  assert.equal(roleRingFor({ code: 'superadmin' }).label, '超级管理员');
  assert.equal(roleRingFor({ code: 'user' }), null);
  assert.equal(roleRingFor(null), null);
  assert.equal(lockLabelFor({ code: 'user', name: '普通用户' }), '需登录');
  assert.equal(lockLabelFor(null), '需登录');
  assert.equal(lockLabelFor({ code: 'vip', name: 'VIP' }), 'VIP 专享');
  assert.equal(lockLabelFor({ code: 'svip', name: 'SVIP' }), 'SVIP 专享');
  assert.equal(lockLabelFor({ code: 'admin', name: '管理员' }), '仅管理员');
  assert.equal(isAdminState({ roles: [{ code: 'superadmin' }] }), true);
  assert.equal(isAdminState(USER_STATE), false);
});

// analytics 读取 localStorage 菜单缓存：用最小 localStorage 桩。
function installStorage(entries = {}) {
  const store = new Map(Object.entries(entries));
  globalThis.window = globalThis.window || {};
  globalThis.window.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.localStorage = globalThis.window.localStorage;
}

beforeEach(() => installStorage());

test('isAnalyticsAdmin reads RBAC roles instead of hardcoded usernames', () => {
  assert.equal(isAnalyticsAdmin({ username: 'lovexl' }), false, 'no hardcoded lovexl');
  assert.equal(isAnalyticsAdmin({ username: 'x', isAdmin: true }), true);
  assert.equal(isAnalyticsAdmin({ username: 'x', roles: [{ code: 'admin' }] }), true);
  assert.equal(isAnalyticsAdmin({ username: 'x', topRole: { code: 'superadmin' } }), true);
  assert.equal(isAnalyticsAdmin({ username: 'x', roles: [{ code: 'svip' }] }), false);
  assert.equal(isAnalyticsAdmin(null), false);
  const source = readFileSync(new URL('../src/app/analytics.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /lovexl|551668745/);
});

test('auction / menu access comes from the cached server perms of the same session', () => {
  installStorage({
    aiDcaRbacMenus_v1: JSON.stringify({ key: 'user:usr_1', state: { perms: ['menu:adminAuction:access'], roles: [{ code: 'auction_viewer' }] } }),
  });
  const session = { userId: 'usr_1', username: '551668745qq.com', accessToken: 'acc_x' };
  assert.equal(canAccessAdminAuction(session), true);
  assert.equal(canAccessMenuFromSession(session, 'adminRadar'), false);
  assert.equal(canAccessAdminAuction({ userId: 'usr_2', username: 'other', accessToken: 'acc_y' }), false, 'cache of another user is ignored');
  assert.equal(canAccessAdminAuction(null), false);
});

test('admin page helpers: expiry date → end of day Beijing time; permission matrix marks inherited perms', () => {
  assert.equal(expiryInputToIso(''), null);
  assert.equal(expiryInputToIso('2026-12-31'), '2026-12-31T15:59:59.000Z');
  const roles = [
    { code: 'user', parent: 'guest', perms: ['menu:holdings:access'], effectivePerms: ['menu:holdings:view', 'menu:holdings:access'] },
    { code: 'vip', parent: 'user', perms: ['menu:adminRadar:access'], effectivePerms: [] },
  ];
  const permissions = [
    { code: 'menu:holdings:view', kind: 'menu_view' }, { code: 'menu:holdings:access', kind: 'menu_access' },
    { code: 'menu:adminRadar:view', kind: 'menu_view' }, { code: 'menu:adminRadar:access', kind: 'menu_access' },
    { code: 'api:nasdaq-radar', kind: 'api', description: '雷达' },
  ];
  const menus = [{ key: 'holdings', label: '持仓' }, { key: 'adminRadar', label: '雷达' }];
  const { menuRows, apiRows } = buildPermissionMatrix({ role: roles[1], roles, permissions, menus });
  assert.equal(menuRows[0].access.inherited, true);
  assert.equal(menuRows[0].access.own, false);
  assert.equal(menuRows[1].access.own, true);
  assert.deepEqual(apiRows.map((r) => r.code), ['api:nasdaq-radar']);
});
