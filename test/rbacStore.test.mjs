import { test } from 'node:test';
import assert from 'node:assert/strict';

// 浏览器环境桩：localStorage + 事件。必须在动态 import 之前安装。
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
const { RBAC_CHANGED_EVENT, RBAC_UPGRADED_EVENT, __rbacStoreInternals, applyRbacPayload, installRbacAutoRefresh, notePermDenied, notePermVersion, readRbacState, refreshRbac } = await import('../src/app/rbac/rbacStore.js');

function payload(version, extra = {}) {
  return {
    roles: [{ code: 'vip', name: 'VIP', expiresAt: '2030-01-01T00:00:00.000Z' }, { code: 'user', name: '普通用户', expiresAt: null }],
    topRole: { code: 'vip', name: 'VIP' },
    menus: [{ key: 'home', label: '首页', group: 'primary', locked: false, children: [] }],
    perms: ['menu:home:view', 'menu:home:access'],
    permVersion: version,
    isAdmin: false,
    ...extra,
  };
}

test('guest without cache gets the built-in guest menus', () => {
  __rbacStoreInternals.reset();
  clearCloudSession();
  const state = readRbacState();
  assert.equal(state.loggedIn, false);
  assert.equal(state.topRole.code, 'guest');
  assert.ok(state.menus.some((m) => m.key === 'holdings' && m.locked));
});

test('logged-in user without cache gets the user-level fallback (not guest locks)', () => {
  __rbacStoreInternals.reset();
  const session = saveCloudSession({ userId: 'usr_z', username: 'zed', accessToken: 'acc_z' });
  const state = readRbacState(session);
  assert.equal(state.loggedIn, true);
  assert.ok(state.perms.includes('menu:holdings:access'));
  assert.ok(!state.perms.includes('menu:adminRadar:access'));
});

test('menu cache is keyed by session and permVersion; same version does not re-emit', () => {
  __rbacStoreInternals.reset();
  const session = saveCloudSession({ userId: 'usr_a', username: 'alice', accessToken: 'acc_a' });
  let events = 0;
  const listener = () => { events += 1; };
  window.addEventListener(RBAC_CHANGED_EVENT, listener);
  assert.equal(applyRbacPayload(payload('v1'), { session }), true);
  assert.equal(applyRbacPayload(payload('v1'), { session }), false, 'unchanged permVersion keeps the cached object');
  assert.equal(applyRbacPayload(payload('v2'), { session }), true);
  window.removeEventListener(RBAC_CHANGED_EVENT, listener);
  assert.equal(events, 2);
  __rbacStoreInternals.reset();
  const restored = readRbacState(session);
  assert.equal(restored.permVersion, 'v2');
  assert.equal(restored.topRole.code, 'vip');
  // 另一个账号不会读到 alice 的缓存。
  const bob = saveCloudSession({ userId: 'usr_b', username: 'bob', accessToken: 'acc_b' });
  assert.notEqual(readRbacState(bob).permVersion, 'v2');
});

test('refresh uses /me with the bearer token, falls back to guest /menus on 401, and dedupes', async () => {
  __rbacStoreInternals.reset();
  saveCloudSession({ userId: 'usr_c', username: 'carol', accessToken: 'acc_c' });
  const calls = [];
  const fetchImpl = async (path, token) => {
    calls.push([path, token]);
    if (path === '/api/sync/auth/me') return { status: 200, ok: true, data: payload('v9') };
    return { status: 200, ok: true, data: payload('guest') };
  };
  const [a, b] = await Promise.all([refreshRbac({ force: true, fetchImpl }), refreshRbac({ force: true, fetchImpl })]);
  assert.equal(a.permVersion, 'v9');
  assert.equal(b.permVersion, 'v9');
  assert.deepEqual(calls, [['/api/sync/auth/me', 'acc_c']], 'concurrent refresh shares one request');
  await refreshRbac({ fetchImpl });
  assert.equal(calls.length, 1, 'refresh within 60s is skipped');

  const expired = async (path, token) => {
    calls.push([path, token]);
    return path === '/api/sync/auth/me' ? { status: 401, ok: false, data: {} } : { status: 200, ok: true, data: payload('guest-v', { topRole: { code: 'guest', name: '游客' } }) };
  };
  const state = await refreshRbac({ force: true, fetchImpl: expired });
  assert.deepEqual(calls.slice(-2).map((c) => c[0]), ['/api/sync/auth/me', '/api/sync/auth/menus']);
  assert.equal(state.permVersion, 'guest-v');
  assert.equal(state.loggedIn, false, 'expired token is treated as guest for the route guard');
});

test('network failure keeps the cached menus', async () => {
  const before = readRbacState();
  const state = await refreshRbac({ force: true, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(state.permVersion, before.permVersion);
});

test('notePermVersion forces /me only when the version differs from the cache', async () => {
  __rbacStoreInternals.reset();
  const session = saveCloudSession({ userId: 'usr_d', username: 'dave', accessToken: 'acc_d' });
  applyRbacPayload(payload('v1', { roles: [{ code: 'user', name: '普通用户' }], topRole: { code: 'user', name: '普通用户' } }), { session });
  const calls = [];
  const fetchImpl = async (path) => { calls.push(path); return { status: 200, ok: true, data: payload('v2') }; };
  assert.equal(notePermVersion('v1', { session, fetchImpl }), false, 'same version does nothing');
  assert.equal(notePermVersion('v2', { session, fetchImpl }), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['/api/sync/auth/me']);
  assert.equal(readRbacState(session).permVersion, 'v2');
  assert.equal(readRbacState(session).topRole.code, 'vip');
  const stored = JSON.parse(localStorage.getItem('aiDcaCloudSyncSession'));
  assert.equal(stored.topRole.code, 'vip', 'session roles are synced for display');
  assert.equal(stored.accessToken, 'acc_d', 'token untouched');
});

test('upgrade within the same session emits rbac:upgraded once', async () => {
  __rbacStoreInternals.reset();
  const session = saveCloudSession({ userId: 'usr_e', username: 'erin', accessToken: 'acc_e' });
  const seen = [];
  const listener = (e) => seen.push(e.detail.role.code);
  window.addEventListener(RBAC_UPGRADED_EVENT, listener);
  applyRbacPayload(payload('u1', { roles: [{ code: 'user', name: '普通用户' }], topRole: { code: 'user', name: '普通用户' } }), { session });
  applyRbacPayload(payload('u2'), { session });
  applyRbacPayload(payload('u3', { roles: [{ code: 'vip', name: 'VIP' }, { code: 'user', name: '普通用户' }] }), { session });
  window.removeEventListener(RBAC_UPGRADED_EVENT, listener);
  assert.deepEqual(seen, ['vip']);
});

test('notePermDenied forces a refresh at most once per 10s', async () => {
  __rbacStoreInternals.reset();
  saveCloudSession({ userId: 'usr_f', username: 'fay', accessToken: 'acc_f' });
  const calls = [];
  const fetchImpl = async (path) => { calls.push(path); return { status: 200, ok: true, data: payload('d1') }; };
  assert.equal(notePermDenied({ now: 100_000, fetchImpl }), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(notePermDenied({ now: 105_000, fetchImpl }), false);
  assert.equal(notePermDenied({ now: 111_000, fetchImpl }), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2);
});

test('auto refresh: visibility/focus refresh, interval only while visible, fetch header triggers /me', async () => {
  __rbacStoreInternals.reset();
  __rbacStoreInternals.resetAutoRefresh();
  const session = saveCloudSession({ userId: 'usr_g', username: 'gus', accessToken: 'acc_g' });
  applyRbacPayload(payload('g1'), { session });
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const win = new EventTarget();
  win.document = doc;
  let tick = null;
  win.setInterval = (fn) => { tick = fn; return 1; };
  const meCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    meCalls.push(String(url));
    return { status: 200, ok: true, headers: new Headers({ 'x-perm-version': 'g2' }), json: async () => payload('g2') };
  };
  win.fetch = async () => ({ status: 200, ok: true, headers: new Headers({ 'x-perm-version': 'g2' }) });
  try {
    assert.equal(installRbacAutoRefresh({ win, intervalMs: 1000 }), true);
    assert.equal(installRbacAutoRefresh({ win, intervalMs: 1000 }), false, 'idempotent');
    await win.fetch('/api/etf-history/159501.json');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(meCalls.length, 1, 'mismatched X-Perm-Version triggers one /me');
    assert.equal(readRbacState(session).permVersion, 'g2');
    doc.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(meCalls.length, 1, 'visibility refresh respects the 60s dedupe');
    __rbacStoreInternals.reset();
    doc.visibilityState = 'hidden';
    tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(meCalls.length, 1, 'no polling while hidden');
    doc.visibilityState = 'visible';
    tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(meCalls.length, 2, 'polls while visible');
    win.dispatchEvent(new Event('ai-dca-role-notice'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(meCalls.length, 3, 'role notice forces refresh');
  } finally {
    globalThis.fetch = realFetch;
  }
});
