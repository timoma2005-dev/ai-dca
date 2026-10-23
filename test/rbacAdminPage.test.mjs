import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { rolldown } from 'rolldown';
import { rbacFixture } from './helpers/rbacFixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromRoot = createRequire(join(root, 'package.json'));
const abs = (path) => JSON.stringify(join(root, path));
const dependency = (name) => JSON.stringify(requireFromRoot.resolve(name));
const roleDefinitions = [
  { code: 'guest', name: '游客', level: 0 },
  { code: 'user', name: '普通用户', level: 10 },
  { code: 'superadmin', name: '超级管理员', privileged: true, level: 100 },
  { code: 'admin', name: '管理员', privileged: true, level: 90 },
  { code: 'svip', name: 'SVIP', level: 30 },
  { code: 'vip', name: 'VIP', level: 20 },
  { code: 'auction_viewer', name: '竞价看板', level: 12 },
  { code: 'virtual_test', name: '虚拟角色', isVirtual: true, level: 5 },
  { code: 'privileged_test', name: '特权角色', privileged: true, level: 95 }
];
const role = (code) => ({ ...roleDefinitions.find((item) => item.code === code), expiresAt: null });
const makeUsers = (count = 18) => Array.from({ length: count }, (_, index) => ({
  id: 'usr_' + String(index).padStart(3, '0'),
  username: '用户' + index,
  createdAt: '2026-10-01T08:00:00.000Z',
  lastActiveAt: index === 0 ? null : '2026-10-23T01:00:00.000Z',
  roles: index === 4 ? [] : [role(['superadmin', 'admin', 'svip', 'auction_viewer'][index] || 'vip')]
}));
const makeGuests = (count = 18) => Array.from({ length: count }, (_, index) => ({
  visitorId: 'guest-' + String(index).padStart(3, '0') + '-long-visitor-identifier',
  firstSeenDate: '2026-10-01',
  lastActiveDate: '2026-10-23',
  activeDays: index + 1
}));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// 打包真实页面与面板，在 StrictMode 下验证点击、请求去重和权限门禁。
const entrySource = [
  'import { act, createElement as h, StrictMode } from ' + dependency('react') + ';',
  'import { createRoot } from ' + dependency('react-dom/client') + ';',
  'import AdminRbacExperience from ' + abs('src/pages/AdminRbacExperience.jsx') + ';',
  'import { RbacUsersPanel } from ' + abs('src/pages/rbac/RbacUsersPanel.jsx') + ';',
  'import { RbacGuestsPanel } from ' + abs('src/pages/rbac/RbacGuestsPanel.jsx') + ';',
  'import { RbacMatrixPanel } from ' + abs('src/pages/rbac/RbacMatrixPanel.jsx') + ';',
  'import { RbacMenusPanel } from ' + abs('src/pages/rbac/RbacMenusPanel.jsx') + ';',
  'import { RbacAuditPanel } from ' + abs('src/pages/rbac/RbacAuditPanel.jsx') + ';',
  'import { formatTime } from ' + abs('src/pages/rbac/rbacUi.jsx') + ';',
  'import { rbacAdminApi } from ' + abs('src/app/rbac/rbacAdminApi.js') + ';',
  'import { applyRbacPayload, __rbacStoreInternals } from ' + abs('src/app/rbac/rbacStore.js') + ';',
  'export { act, rbacAdminApi, formatTime, applyRbacPayload, __rbacStoreInternals };',
  'export const errors = [];',
  'let mounted;',
  'export async function mount(name, props) {',
  '  const Component = { users: RbacUsersPanel, guests: RbacGuestsPanel, matrix: RbacMatrixPanel, menus: RbacMenusPanel, audit: RbacAuditPanel, page: AdminRbacExperience }[name];',
  '  mounted = createRoot(document.getElementById("root"), {',
  '    onUncaughtError: (error) => errors.push(error), onCaughtError: (error) => errors.push(error),',
  '    onRecoverableError: (error) => errors.push(error)',
  '  });',
  '  await act(async () => { mounted.render(h(StrictMode, null, h(Component, props))); });',
  '}',
  'export async function unmount() {',
  '  if (mounted) await act(async () => { mounted.unmount(); mounted = null; });',
  '}'
].join('\n');

let dir;
let dom;
let mod;
let userRows;
let guestData;
let calls;
const originals = new Map();
const channels = [];
const rbacPayload = {
  loggedIn: true, roles: [role('superadmin')], topRole: role('superadmin'), menus: [],
  perms: ['api:rbac-admin', 'api:rbac-grant-admin'], isAdmin: true, permVersion: 'rbac-page-test'
};

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rbac-admin-page-'));
  dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/home.html', pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
    MessageChannel: class extends MessageChannel {
      constructor() { super(); channels.push(this); }
    },
    fetch: async () => new Response(JSON.stringify(rbacPayload), { headers: { 'content-type': 'application/json' } })
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.addEventListener('aidca:toast', (event) => calls.toasts.push(event.detail));
  const entry = join(dir, 'entry.jsx');
  writeFileSync(entry, entrySource);
  const bundle = await rolldown({
    input: entry, platform: 'node', logLevel: 'silent',
    resolve: { alias: { '@': join(root, 'src') } },
    moduleTypes: { '.css': 'empty', '.jpg': 'empty', '.png': 'empty', '.svg': 'empty' },
    transform: { jsx: 'react-jsx', define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"development"' } }
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const item of output) writeFileSync(join(dir, item.fileName), item.type === 'chunk' ? item.code : item.source);
  const entryChunk = output.find((item) => item.type === 'chunk' && item.isEntry);
  mod = await import(pathToFileURL(join(dir, entryChunk.fileName)).href);
});

test.beforeEach(() => {
  userRows = makeUsers();
  guestData = { available: true, guests: makeGuests() };
  calls = { search: [], guests: 0, grants: [], revokes: [], loaded: [], changed: 0, toasts: [], perms: [], menuUpdates: [], audit: [] };
  Object.assign(mod.rbacAdminApi, {
    searchUsers: async (query) => { calls.search.push(query); return { users: userRows }; },
    listGuests: async () => { calls.guests += 1; return guestData; },
    listRoles: async () => ({ roles: roleDefinitions }),
    listPermissions: async () => ({ permissions: [] }),
    listMenus: async () => ({ menus: [] }),
    grantRole: async (id, code, expiresAt) => {
      calls.grants.push([id, code, expiresAt]);
      userRows = userRows.map((user) => user.id === id ? { ...user, roles: [...user.roles, { ...role(code), expiresAt }] } : user);
    },
    setRolePermissions: async (code, perms) => { calls.perms.push([code, perms]); },
    updateMenu: async (key, body) => { calls.menuUpdates.push([key, body]); },
    listAudit: async (query) => {
      calls.audit.push(query);
      return { entries: [{ id: 2, actorUsername: 'lovexl', action: 'role.grant', targetType: 'user', targetId: 'usr_1', detail: { username: 'lin', role: 'vip', expiresAt: '2026-12-31T15:59:59.000Z' }, createdAt: '2026-10-23T08:00:00.000Z' }] };
    },
    revokeRole: async (id, code) => {
      calls.revokes.push([id, code]);
      userRows = userRows.map((user) => user.id === id ? { ...user, roles: user.roles.filter((item) => item.code !== code) } : user);
    }
  });
  window.confirm = () => { throw new Error('native confirm must not be used'); };
  window.history.replaceState(null, '', '/home.html?tab=adminRbac');
  window.localStorage.clear();
  const session = { userId: 'test-admin', username: 'test-admin', accessToken: 'test-token' };
  window.localStorage.setItem('aiDcaCloudSyncSession', JSON.stringify(session));
  mod.__rbacStoreInternals.reset();
  mod.applyRbacPayload(rbacPayload, { session });
  mod.errors.length = 0;
});

test.afterEach(async () => {
  await mod.unmount();
  assert.deepEqual(mod.errors, [], 'no React rendering errors');
});

test.after(async () => {
  try {
    await mod?.unmount();
  } finally {
    dom?.window.close();
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const q = (selector, scope = document) => scope.querySelector(selector);
const all = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const rows = (kind = 'user') => all('[data-testid="rbac-' + kind + '-row"]');
const button = (label, scope = document) => all('button', scope).find((item) => item.textContent.trim() === label);
const drawer = () => q('[data-testid="rbac-user-drawer"]');
const wait = (ms) => mod.act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const userProps = (extra = {}) => ({
  roles: roleDefinitions, onLoaded: (count) => calls.loaded.push(count), onChanged: () => { calls.changed += 1; }, ...extra
});
const click = async (element) => {
  assert.ok(element, 'click target exists');
  await mod.act(async () => { element.click(); });
};
const change = async (element, value) => {
  assert.ok(element, 'input exists');
  await mod.act(async () => {
    const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
};
const submit = async (form) => {
  await mod.act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
};
const searchUsers = async (value) => {
  const input = q('[aria-label="搜索用户"]');
  await change(input, value);
  await submit(input.form);
};
const resolveRequest = async (pending, value) => {
  await mod.act(async () => { pending.resolve(value); await pending.promise; });
};

test('users auto-load once in StrictMode, render the table and paginate twenty rows per page', async () => {
  userRows = makeUsers(45);
  await mod.mount('users', userProps());
  assert.deepEqual(calls.search, ['']);
  assert.deepEqual(calls.loaded, [45]);
  const table = q('table[aria-label="注册用户"]');
  assert.deepEqual(all('th', table).map((cell) => cell.textContent), ['用户', '角色', '注册', '最后活跃', '']);
  assert.equal(rows().length, 20);
  const cells = all('td', rows()[0]);
  assert.match(cells[0].textContent, /用户0.*usr_000/);
  assert.match(cells[1].textContent, /超级管理员/);
  assert.equal(cells[2].textContent, mod.formatTime(userRows[0].createdAt));
  assert.equal(cells[3].textContent, '从未');
  assert.match(all('td', rows()[4])[1].textContent, /普通用户/);
  assert.ok(button('上一页').disabled);
  assert.match(q('footer').textContent, /共 45 位注册用户.*第 1 \/ 3 页/);
  assert.doesNotMatch(q('footer').textContent, /取前/);
  await click(button('下一页'));
  assert.match(rows()[0].textContent, /usr_020/);
  await click(button('下一页'));
  assert.equal(rows().length, 5);
  assert.ok(button('下一页').disabled);
  assert.deepEqual(calls.search, [''], 'pagination stays on the loaded result set');
  assert.equal(drawer(), null);
});

test('role chips are built from roles by level with live counts and filter locally', async () => {
  await mod.mount('users', userProps());
  const filters = q('[aria-label="按角色筛选"]');
  assert.deepEqual(all('button', filters).map((item) => item.textContent), ['全部18', '超级管理员1', '特权角色0', '管理员1', 'SVIP1', 'VIP13', '竞价看板1', '无额外角色1']);
  await click(q('[data-role-filter="vip"]'));
  assert.equal(q('[data-role-filter="vip"]').getAttribute('aria-pressed'), 'true');
  assert.equal(rows().length, 13);
  assert.match(q('footer').textContent, /筛选 13 \/ 18 位注册用户/);
  for (const [code, id] of [['superadmin', 'usr_000'], ['admin', 'usr_001'], ['svip', 'usr_002'], ['auction_viewer', 'usr_003'], ['none', 'usr_004']]) {
    await click(q(`[data-role-filter="${code}"]`));
    assert.equal(rows().length, 1);
    assert.ok(rows()[0].textContent.includes(id));
  }
  await click(q('[data-role-filter="all"]'));
  assert.equal(rows().length, 18);
  assert.deepEqual(calls.search, [''], 'chips never call searchUsers');
});

test('typing searches after a debounce, submit searches immediately, and stale results never win', async () => {
  await mod.mount('users', userProps());
  const input = q('[aria-label="搜索用户"]');
  userRows = [makeUsers()[17]];
  await change(input, '用户17');
  assert.deepEqual(calls.search, [''], 'no request while typing');
  await wait(400);
  assert.deepEqual(calls.search, ['', '用户17']);
  assert.deepEqual(calls.loaded, [18, 1]);
  assert.equal(rows().length, 1);
  userRows = [];
  await searchUsers('不存在');
  assert.deepEqual(calls.search, ['', '用户17', '不存在']);
  await wait(400);
  assert.deepEqual(calls.search, ['', '用户17', '不存在'], 'submit cancels the pending debounce');
  assert.match(document.body.textContent, /暂无匹配用户。/);
});

test('a stale initial search cannot replace a newer query and the mount replay shares its inflight request', async () => {
  const initial = deferred();
  mod.rbacAdminApi.searchUsers = (query) => {
    calls.search.push(query);
    return query === '' ? initial.promise : Promise.resolve({ users: [makeUsers()[17]] });
  };
  await mod.mount('users', userProps());
  assert.match(document.body.textContent, /正在加载用户…/);
  assert.deepEqual(calls.search, ['']);
  await searchUsers('用户17');
  await resolveRequest(initial, { users: makeUsers() });
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /usr_017/);
  assert.deepEqual(calls.loaded, [1]);
});

test('clicking a row opens the user drawer with info, owned roles and gated grantable roles', async () => {
  await mod.mount('users', userProps());
  await click(rows()[5]);
  assert.ok(drawer());
  assert.match(drawer().textContent, /用户5.*usr_005/);
  assert.match(q('[aria-label="已有角色"]', drawer()).textContent, /普通用户.*默认.*VIP/);
  const options = all('option', q('select', drawer()));
  for (const code of ['guest', 'user', 'superadmin', 'virtual_test', 'vip']) {
    assert.equal(options.find((option) => option.value === code), undefined, code + ' must not be grantable');
  }
  assert.ok(options.find((option) => option.value === 'admin').disabled);
  assert.ok(options.find((option) => option.value === 'privileged_test').disabled);
  assert.equal(options.find((option) => option.value === 'svip').disabled, false);
  assert.ok(button('确认授予', drawer()).disabled);
  assert.deepEqual(all('button', q('[aria-label="有效期"]', drawer())).map((item) => item.textContent), ['7 天', '30 天', '1 年', '长期', '自定义']);
  await click(q('[aria-label="关闭"]', drawer()));
  assert.equal(drawer(), null);
  await click(rows()[0]);
  assert.equal(q('[aria-label="撤销超级管理员"]'), null, 'superadmin is never revocable');
  await mod.act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); });
  assert.equal(drawer(), null);
  await click(rows()[1]);
  assert.equal(q('[aria-label="撤销管理员"]'), null, 'ordinary admins cannot revoke privileged roles');
});

test('grant with a custom expiry converts to Beijing end-of-day, refreshes, notifies and keeps the drawer on the user', async () => {
  userRows = [makeUsers()[5]];
  await mod.mount('users', userProps());
  await searchUsers('用户5');
  await click(rows()[0]);
  await change(q('select', drawer()), 'svip');
  await click(button('自定义', drawer()));
  assert.ok(button('确认授予', drawer()).disabled, 'custom needs a date');
  await change(q('input[type="date"]', drawer()), '2026-12-31');
  await submit(q('form', drawer()));
  assert.deepEqual(calls.grants, [['usr_005', 'svip', '2026-12-31T15:59:59.000Z']]);
  assert.deepEqual(calls.search, ['', '用户5', '用户5']);
  assert.equal(calls.changed, 1);
  assert.equal(calls.toasts[0].title, '已授予角色');
  assert.equal(calls.toasts[0].description, '用户5 → svip');
  assert.match(q('[aria-label="已有角色"]', drawer()).textContent, /SVIP.*2026-12-31 到期/);
  assert.equal(q('select', drawer()).value, '');
});

test('presets fill the expiry and 长期 grants permanently; superadmins can grant admin', async () => {
  await mod.mount('users', userProps({ canGrantAdmin: true }));
  await click(rows()[4]);
  assert.equal(q('option[value="admin"]', drawer()).disabled, false);
  await change(q('select', drawer()), 'admin');
  await click(button('30 天', drawer()));
  assert.match(drawer().textContent, /到期 \d{4}-\d{2}-\d{2}（北京时间当天 23:59）/);
  await click(button('长期', drawer()));
  await submit(q('form', drawer()));
  assert.deepEqual(calls.grants, [['usr_004', 'admin', null]]);
  await click(q('[aria-label="关闭"]', drawer()));
  await click(rows()[1]);
  assert.ok(q('[aria-label="撤销管理员"]'), 'superadmins can revoke admins');
});

test('grant failures keep the draft, show the error and skip refresh and success toasts', async () => {
  const pending = deferred();
  mod.rbacAdminApi.grantRole = (...args) => { calls.grants.push(args); return pending.promise; };
  await mod.mount('users', userProps());
  await click(rows()[4]);
  await change(q('select', drawer()), 'vip');
  await submit(q('form', drawer()));
  assert.ok(button('处理中…', drawer()).disabled);
  await submit(q('form', drawer()));
  assert.equal(calls.grants.length, 1);
  await mod.act(async () => { pending.reject(new Error('授予失败')); });
  assert.match(drawer().textContent, /授予失败/);
  assert.equal(q('select', drawer()).value, 'vip');
  assert.deepEqual(calls.search, ['']);
  assert.equal(calls.changed, 0);
  assert.deepEqual(calls.toasts, []);
});

test('revoke asks with the in-page confirm dialog instead of window.confirm', async () => {
  userRows = [makeUsers()[5]];
  await mod.mount('users', userProps());
  await click(rows()[0]);
  await click(q('[aria-label="撤销VIP"]'));
  const dialog = q('[data-testid="rbac-confirm"]');
  assert.match(dialog.textContent, /确认撤销 用户5 的「VIP」角色？/);
  await click(button('取消', dialog));
  assert.equal(q('[data-testid="rbac-confirm"]'), null);
  assert.deepEqual(calls.revokes, []);
  await click(q('[aria-label="撤销VIP"]'));
  await click(button('撤销', q('[data-testid="rbac-confirm"]')));
  assert.deepEqual(calls.revokes, [['usr_005', 'vip']]);
  assert.equal(calls.changed, 1);
  assert.equal(calls.toasts[0].title, '已撤销角色');
  assert.equal(q('[aria-label="撤销VIP"]'), null);
});

test('guests load once, paginate twenty rows and search visitor IDs locally', async () => {
  guestData = { available: true, guests: makeGuests(45) };
  await mod.mount('guests', { onLoaded: (count) => calls.loaded.push(count) });
  assert.equal(calls.guests, 1);
  assert.deepEqual(calls.loaded, [45]);
  const table = q('table[aria-label="游客"]');
  assert.deepEqual(all('th', table).map((cell) => cell.textContent), ['访客标识', '首次访问', '最近活跃', '活跃天数']);
  assert.equal(rows('guest').length, 20);
  const cells = all('td', rows('guest')[0]);
  assert.equal(cells[0].title, guestData.guests[0].visitorId);
  assert.equal(cells[0].textContent, guestData.guests[0].visitorId.slice(0, 18) + '…');
  assert.match(q('footer').textContent, /共 45 位游客.*第 1 \/ 3 页/);
  await change(q('[aria-label="搜索游客"]'), ' GUEST-017 ');
  assert.equal(rows('guest').length, 1);
  assert.match(q('footer').textContent, /筛选 1 \/ 45 位游客/);
  await change(q('[aria-label="搜索游客"]'), 'no-such-visitor');
  assert.match(document.body.textContent, /暂无匹配游客。/);
  assert.equal(calls.guests, 1);
});

test('guest loading, unavailable, empty and error states stay distinct', async () => {
  const pending = deferred();
  mod.rbacAdminApi.listGuests = () => { calls.guests += 1; return pending.promise; };
  await mod.mount('guests', { onLoaded: (count) => calls.loaded.push(count) });
  assert.match(document.body.textContent, /正在加载游客…/);
  await resolveRequest(pending, { available: false, guests: [] });
  assert.match(document.body.textContent, /暂无游客数据（分析库不可用）/);
  assert.deepEqual(calls.loaded, [0]);
  await mod.unmount();
  guestData = { available: true, guests: [] };
  mod.rbacAdminApi.listGuests = async () => guestData;
  await mod.mount('guests', {});
  assert.match(document.body.textContent, /暂无游客访问记录。/);
  await mod.unmount();
  mod.rbacAdminApi.listGuests = async () => { throw new Error('游客请求失败'); };
  await mod.mount('guests', {});
  assert.match(document.body.textContent, /游客请求失败/);
  assert.doesNotMatch(document.body.textContent, /暂无游客访问记录|分析库不可用/);
});

test('the page shows overview cards and five flat tabs with counts synced to the URL hash', async () => {
  await mod.mount('page');
  const tabs = all('a', q('.overflow-x-auto'));
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('href')), ['#users', '#guests', '#matrix', '#menus', '#audit']);
  assert.equal(tabs[0].textContent, '用户18');
  assert.equal(tabs[1].textContent, '游客');
  assert.match(q('[aria-label="概览"]').textContent, /注册用户18.*特权用户17.*角色9/);
  assert.equal(calls.guests, 0, 'guests load when their tab is first visited');
  await click(tabs[1]);
  assert.equal(window.location.hash, '#guests');
  assert.equal(calls.guests, 1);
  assert.equal(all('a', q('.overflow-x-auto'))[1].textContent, '游客18');
  assert.ok(q('table[aria-label="注册用户"]').closest('[hidden]'));
  await click(all('a', q('.overflow-x-auto'))[0]);
  await click(all('a', q('.overflow-x-auto'))[1]);
  assert.equal(calls.guests, 1, 'returning to a visited tab keeps its data');
  await click(all('a', q('.overflow-x-auto'))[4]);
  assert.equal(window.location.hash, '#audit');
  assert.match(document.body.textContent, /lovexl 给 lin 授予 VIP，到期 2026-12-31/);
});

test('a legacy #roles link opens the permission matrix', async () => {
  window.history.replaceState(null, '', '/home.html?tab=adminRbac#roles');
  await mod.mount('page');
  const active = all('a', q('.overflow-x-auto')).find((tab) => /bg-indigo-600/.test(tab.className));
  assert.equal(active.getAttribute('href'), '#matrix');
  assert.ok(q('table[aria-label="权限矩阵"]'));
});

const matrixProps = (extra = {}) => ({ ...rbacFixture(), onChanged: () => { calls.changed += 1; }, ...extra });
const cell = (menuKey, roleCode) => {
  const row = q(`table[aria-label="权限矩阵"] [data-matrix-row="${menuKey}"]`);
  const index = all('thead th', q('table[aria-label="权限矩阵"]')).findIndex((th) => th.dataset.roleColumn === roleCode);
  return all('td', row)[index - 1]?.querySelector('button');
};

test('matrix lists roles along the chain, menus by group plus API rows, with inherited cells marked', async () => {
  await mod.mount('matrix', matrixProps({ canGrantAdmin: true }));
  const heads = all('thead th', q('table[aria-label="权限矩阵"]')).map((th) => th.dataset.roleColumn).filter(Boolean);
  assert.deepEqual(heads, ['guest', 'user', 'vip', 'svip', 'admin', 'superadmin', 'auction_viewer']);
  assert.deepEqual(all('th[scope="rowgroup"]').slice(0, 3).map((th) => th.textContent), ['主导航', '管理', '接口权限']);
  assert.equal(cell('holdings', 'guest').dataset.cellState, 'view');
  assert.equal(cell('holdings', 'user').dataset.cellState, 'access');
  assert.equal(cell('holdings', 'vip').dataset.inherited, 'true');
  assert.match(cell('holdings', 'vip').getAttribute('aria-label'), /继承自 普通用户/);
  assert.equal(cell('api:sync', 'svip').disabled, true, 'inherited API permissions cannot be unticked');
  assert.equal(q('[data-testid="rbac-matrix-savebar"]'), null);
});

test('clicking cells cycles none → view → access, stages changes and saves only changed roles', async () => {
  await mod.mount('matrix', matrixProps({ canGrantAdmin: true }));
  await click(cell('adminRbac', 'vip'));
  assert.equal(cell('adminRbac', 'vip').dataset.cellState, 'view');
  assert.equal(cell('adminRbac', 'svip').dataset.inherited, 'true', 'children follow the draft immediately');
  await click(cell('adminRbac', 'vip'));
  assert.equal(cell('adminRbac', 'vip').dataset.cellState, 'access');
  await click(cell('api:paper-trade', 'vip'));
  const bar = q('[data-testid="rbac-matrix-savebar"]');
  assert.match(bar.textContent, /已修改 3 处 · VIP/);
  await click(button('撤销', bar));
  assert.equal(q('[data-testid="rbac-matrix-savebar"]'), null);
  assert.equal(cell('adminRbac', 'vip').dataset.cellState, 'none');
  await click(cell('holdings', 'user'));
  assert.equal(cell('holdings', 'user').dataset.cellState, 'view', 'cannot drop below the inherited floor');
  await click(cell('notify', 'guest'));
  assert.equal(cell('notify', 'guest').dataset.cellState, 'access');
  await click(button('保存', q('[data-testid="rbac-matrix-savebar"]')));
  assert.deepEqual(calls.perms.map(([code]) => code), ['guest', 'user']);
  assert.ok(calls.perms[0][1].includes('menu:notify:access'));
  assert.ok(!calls.perms[1][1].includes('menu:holdings:access'));
  assert.equal(calls.changed, 1);
  assert.equal(calls.toasts.at(-1).title, '权限已保存');
});

test('ordinary admins see privileged columns read-only and can create roles in a drawer', async () => {
  let created = null;
  mod.rbacAdminApi.createRole = async (body) => { created = body; };
  await mod.mount('matrix', matrixProps({ canGrantAdmin: false }));
  assert.equal(cell('home', 'admin').disabled, true);
  assert.equal(cell('home', 'superadmin').disabled, true);
  assert.equal(cell('home', 'vip').disabled, false);
  assert.equal(q('[aria-label="编辑角色 管理员"]'), null);
  await click(button('新建角色'));
  const editorEl = q('[data-testid="rbac-role-editor"]');
  assert.ok(q('option[value="admin"]', editorEl).disabled);
  await change(q('[aria-label="角色编码"]', editorEl), 'beta');
  await change(q('[aria-label="角色名称"]', editorEl), '内测');
  await submit(q('form', editorEl));
  assert.deepEqual(created, { code: 'beta', name: '内测', parent: 'user', description: '' });
  assert.equal(q('[data-testid="rbac-role-editor"]'), null);
});

test('menus group by navigation area, toggle instantly and save reordering in one batch', async () => {
  await mod.mount('menus', { menus: rbacFixture().menus, onChanged: () => { calls.changed += 1; } });
  assert.deepEqual(all('section[aria-label$="菜单"]').map((section) => section.getAttribute('aria-label')), ['主导航菜单', '管理菜单']);
  await click(q('[aria-label="通知管理 启用"]'));
  assert.deepEqual(calls.menuUpdates, [['notify', { enabled: false }]]);
  assert.equal(q('[aria-label="权限管理 启用"]').disabled, true);
  await click(q('[aria-label="下移 量化"]'));
  const bar = q('[data-testid="rbac-menu-savebar"]');
  assert.match(bar.textContent, /排序已调整 2 项/);
  await click(button('保存排序', bar));
  assert.deepEqual(calls.menuUpdates.slice(1), [['adminRadar', { sort: 110 }], ['adminQuant', { sort: 120 }]]);
  assert.equal(calls.changed, 2);
});

test('audit renders a humanized timeline and filters by action', async () => {
  await mod.mount('audit', { roles: rbacFixture().roles, menus: rbacFixture().menus });
  assert.equal(all('[data-testid="rbac-audit-entry"]').length, 1);
  assert.match(q('[data-testid="rbac-audit-entry"]').textContent, /lovexl 给 lin 授予 VIP，到期 2026-12-31/);
  await change(q('[aria-label="操作类型"]'), 'role.revoke');
  assert.deepEqual(calls.audit.at(-1), { before: '', target: '', action: 'role.revoke' });
});

test('the client retains the CF guest source and the 200-row search limit', () => {
  const api = readFileSync(join(root, 'src/app/rbac/rbacAdminApi.js'), 'utf8');
  assert.match(api, /searchUsers:.*limit=200/);
  assert.match(api, /fetch\(apiUrl\('\/api\/sync\/analytics\/guests\?limit=200'\)/);
  const users = readFileSync(join(root, 'src/pages/rbac/RbacUsersPanel.jsx'), 'utf8');
  assert.doesNotMatch(users, /window\.confirm/);
});
