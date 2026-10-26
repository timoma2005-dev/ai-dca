import { test } from 'node:test';
import assert from 'node:assert/strict';

// 审计 batch1 #1/#2：退出后游客状态不得保留 / 渲染缓存用户名，也不得采用残留 cookie 返回的会员菜单。
const store = new Map();
const target = new EventTarget();
globalThis.window = Object.assign(target, {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { origin: 'https://fast.example', href: 'https://fast.example/home.html' },
});
globalThis.localStorage = globalThis.window.localStorage;
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class extends Event {
    constructor(type, init = {}) { super(type); this.detail = init.detail; }
  };
}

const { saveCloudSession, clearCloudSession } = await import('../src/app/authSession.js');
const { RBAC_STORE_KEY, __rbacStoreInternals, applyRbacPayload, normalizeRbacPayload, readRbacState, refreshRbac } = await import('../src/app/rbac/rbacStore.js');
const { evaluateTabAccess } = await import('../src/app/rbac/menuModel.js');

const memberMenus = [{ key: 'markets', label: '行情中心', group: 'primary', locked: false, children: [] }];

test('normalizeRbacPayload drops username when not logged in', () => {
  assert.equal(normalizeRbacPayload({ username: 'littledudu' }, { loggedIn: false }).username, '');
  assert.equal(normalizeRbacPayload({}, { loggedIn: false, username: 'littledudu' }).username, '');
  assert.equal(normalizeRbacPayload({ username: 'a' }, { loggedIn: true }).username, 'a');
});

test('tainted guest cache (member menus + username) is discarded: markets stays guarded', () => {
  __rbacStoreInternals.reset();
  clearCloudSession();
  store.set(RBAC_STORE_KEY, JSON.stringify({ key: 'guest', state: { loggedIn: false, username: 'littledudu', menus: memberMenus, perms: ['menu:markets:access'], permVersion: 'v1' } }));
  const state = readRbacState();
  assert.equal(state.loggedIn, false);
  assert.equal(state.username, '');
  assert.equal(evaluateTabAccess(state, 'markets').status, 'login');
  store.delete(RBAC_STORE_KEY);
});

test('guest ignores a member payload served via a leftover cookie', () => {
  __rbacStoreInternals.reset();
  clearCloudSession();
  const changed = applyRbacPayload({ loggedIn: true, username: 'littledudu', menus: memberMenus, perms: ['menu:markets:access'], permVersion: 'u1' }, { session: null });
  assert.equal(changed, false);
  const state = readRbacState();
  assert.equal(state.username, '');
  assert.equal(evaluateTabAccess(state, 'markets').status, 'login');
  assert.ok(!String(store.get(RBAC_STORE_KEY) || '').includes('littledudu'));
});

test('guest /menus request omits cookies; expired token falls back without identity', async () => {
  __rbacStoreInternals.reset();
  clearCloudSession();
  const calls = [];
  await refreshRbac({ force: true, fetchImpl: async (path, token, opts) => { calls.push({ path, token, opts }); return { ok: true, status: 200, data: { loggedIn: false, username: '', menus: [], perms: [], permVersion: 'g1' } }; } });
  assert.equal(calls[0].path, '/api/sync/auth/menus');
  assert.equal(calls[0].opts?.credentials, 'omit');

  __rbacStoreInternals.reset();
  saveCloudSession({ userId: 'usr_x', username: 'littledudu', accessToken: 'expired' });
  const seen = [];
  const state = await refreshRbac({ force: true, fetchImpl: async (path, token, opts) => {
    seen.push({ path, opts });
    if (path.endsWith('/me')) return { ok: false, status: 401, data: {} };
    return { ok: true, status: 200, data: { loggedIn: false, username: '', menus: [], perms: [], permVersion: 'g2' } };
  } });
  assert.equal(seen[1].opts?.credentials, 'omit');
  assert.equal(state.loggedIn, false);
  assert.equal(state.username, '');
  assert.ok(!String(store.get(RBAC_STORE_KEY) || '').includes('littledudu'));
  clearCloudSession();
});
