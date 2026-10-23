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

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromRoot = createRequire(join(root, 'package.json'));
const abs = (path) => JSON.stringify(join(root, path));
const dependency = (name) => JSON.stringify(requireFromRoot.resolve(name));
const roleDefinitions = [
  { code: 'guest', name: '游客' },
  { code: 'user', name: '普通用户' },
  { code: 'superadmin', name: '超级管理员', privileged: true },
  { code: 'admin', name: '管理员', privileged: true },
  { code: 'svip', name: 'SVIP' },
  { code: 'vip', name: 'VIP' },
  { code: 'auction_viewer', name: '竞价看板' },
  { code: 'virtual_test', name: '虚拟角色', isVirtual: true },
  { code: 'privileged_test', name: '特权角色', privileged: true }
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
  'import { formatTime } from ' + abs('src/pages/rbac/rbacUi.jsx') + ';',
  'import { rbacAdminApi } from ' + abs('src/app/rbac/rbacAdminApi.js') + ';',
  'import { applyRbacPayload, __rbacStoreInternals } from ' + abs('src/app/rbac/rbacStore.js') + ';',
  'export { act, rbacAdminApi, formatTime, applyRbacPayload, __rbacStoreInternals };',
  'export const errors = [];',
  'let mounted;',
  'export async function mount(name, props) {',
  '  const Component = { users: RbacUsersPanel, guests: RbacGuestsPanel, page: AdminRbacExperience }[name];',
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
  calls = { search: [], guests: 0, grants: [], revokes: [], loaded: [], changed: 0, toasts: [] };
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
    revokeRole: async (id, code) => {
      calls.revokes.push([id, code]);
      userRows = userRows.map((user) => user.id === id ? { ...user, roles: user.roles.filter((item) => item.code !== code) } : user);
    }
  });
  window.confirm = () => true;
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
const editor = () => q('[data-testid="rbac-user-editor"]');
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

test('users auto-load once in StrictMode and render compact table columns with eight-row pagination', async () => {
  await mod.mount('users', userProps());
  assert.deepEqual(calls.search, ['']);
  assert.deepEqual(calls.loaded, [18]);
  const table = q('table[aria-label="注册用户"]');
  assert.deepEqual(all('th', table).map((cell) => cell.textContent), ['用户名', '角色', '注册', '最后活跃', '操作']);
  assert.match(table.className, /text-sm/);
  assert.match(q('thead', table).className, /text-xs text-slate-400/);
  assert.equal(rows().length, 8);
  const cells = all('td', rows()[0]);
  assert.match(cells[0].textContent, /用户0.*usr_000/);
  assert.match(cells[1].textContent, /普通用户（默认）.*超级管理员/);
  assert.equal(cells[2].textContent, mod.formatTime(userRows[0].createdAt));
  assert.equal(cells[3].textContent, '从未');
  assert.equal(all('td', rows()[1])[3].textContent, mod.formatTime(userRows[1].lastActiveAt));
  assert.equal(editor(), null);
  assert.ok(button('上一页').disabled);
  assert.match(q('footer').textContent, /共 18 位注册用户.*第 1 \/ 3 页/);
  await click(button('下一页'));
  assert.equal(rows().length, 8);
  assert.match(rows()[0].textContent, /usr_008/);
  await click(button('下一页'));
  assert.equal(rows().length, 2);
  assert.ok(button('下一页').disabled);
  await click(button('上一页'));
  assert.match(q('footer').textContent, /第 2 \/ 3 页/);
  assert.deepEqual(calls.search, [''], 'pagination stays on the loaded result set');
});

test('role chips match codes exactly and paginate the client-filtered result set', async () => {
  await mod.mount('users', userProps());
  const filters = q('[aria-label="按角色筛选"]');
  assert.deepEqual(all('button', filters).map((item) => item.textContent), ['全部', '超级管理员', '管理员', 'SVIP', 'VIP', '竞价看板', '无额外角色']);
  await click(button('下一页'));
  await click(button('VIP', filters));
  assert.equal(button('VIP', filters).getAttribute('aria-pressed'), 'true');
  assert.equal(rows().length, 8);
  assert.match(q('footer').textContent, /筛选 13 \/ 18 位注册用户.*第 1 \/ 2 页/);
  assert.ok(rows().every((row) => !row.textContent.includes('SVIP')));
  await click(button('下一页'));
  assert.equal(rows().length, 5);
  for (const [label, id] of [['超级管理员', 'usr_000'], ['管理员', 'usr_001'], ['SVIP', 'usr_002'], ['竞价看板', 'usr_003'], ['无额外角色', 'usr_004']]) {
    await click(button(label, filters));
    assert.equal(rows().length, 1);
    assert.ok(rows()[0].textContent.includes(id));
    assert.match(q('footer').textContent, /第 1 \/ 1 页/);
  }
  await click(button('全部', filters));
  assert.equal(rows().length, 8);
  assert.deepEqual(calls.search, [''], 'chips never call searchUsers');
  assert.deepEqual(calls.loaded, [18], 'loaded count is independent of local filters');
});

test('the search form queries the server only on submit, reports new loaded counts and resets the page', async () => {
  await mod.mount('users', userProps());
  await click(button('下一页'));
  const input = q('[aria-label="搜索用户"]');
  await change(input, '用户17');
  assert.deepEqual(calls.search, ['']);
  userRows = [userRows[17]];
  await submit(input.form);
  assert.deepEqual(calls.search, ['', '用户17']);
  assert.deepEqual(calls.loaded, [18, 1]);
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /usr_017/);
  assert.match(q('footer').textContent, /共 1 位注册用户.*第 1 \/ 1 页/);
  userRows = [];
  await searchUsers('不存在');
  assert.match(document.body.textContent, /暂无匹配用户。/);
  assert.equal(rows().length, 0);
});

test('only one inline grant editor expands, with unchanged role gates and already-owned roles excluded', async () => {
  await mod.mount('users', userProps());
  await click(button('授予角色', rows()[5]));
  assert.equal(all('[data-testid="rbac-user-editor"]').length, 1);
  assert.equal(q('td', editor()).colSpan, 5);
  assert.equal(editor().previousElementSibling, rows()[5]);
  const select = q('select', editor());
  const options = all('option', select);
  for (const code of ['guest', 'user', 'superadmin', 'virtual_test', 'vip']) {
    assert.equal(options.find((option) => option.value === code), undefined, code + ' must not be grantable');
  }
  assert.ok(options.find((option) => option.value === 'admin').disabled);
  assert.ok(options.find((option) => option.value === 'privileged_test').disabled);
  assert.equal(options.find((option) => option.value === 'svip').disabled, false);
  assert.ok(button('确认授予', editor()).disabled);
  await change(select, 'svip');
  await change(q('input[type="date"]', editor()), '2026-12-31');
  await click(button('授予角色', rows()[4]));
  assert.equal(all('[data-testid="rbac-user-editor"]').length, 1);
  assert.equal(editor().previousElementSibling, rows()[4]);
  assert.equal(q('select', editor()).value, '');
  assert.equal(q('input', editor()).value, '');
  await click(button('取消', editor()));
  assert.equal(editor(), null);
  await click(button('授予角色', rows()[0]));
  await click(button('下一页'));
  assert.equal(editor(), null);
  await click(button('授予角色', rows()[0]));
  await click(button('无额外角色', q('[aria-label="按角色筛选"]')));
  assert.equal(editor(), null);
  assert.equal(q('[aria-label="撤销超级管理员"]'), null);
  await click(button('全部', q('[aria-label="按角色筛选"]')));
  assert.equal(q('[aria-label="撤销管理员"]'), null, 'ordinary admins cannot revoke privileged roles');
});

test('grant keeps the query, expiry conversion, toast and onChanged flow and closes the editor', async () => {
  userRows = [makeUsers()[5]];
  await mod.mount('users', userProps());
  await searchUsers('用户5');
  await click(button('授予角色', rows()[0]));
  await change(q('select', editor()), 'svip');
  await change(q('input[type="date"]', editor()), '2026-12-31');
  await submit(q('form', editor()));
  assert.deepEqual(calls.grants, [['usr_005', 'svip', '2026-12-31T15:59:59.000Z']]);
  assert.deepEqual(calls.search, ['', '用户5', '用户5']);
  assert.equal(calls.changed, 1);
  assert.equal(calls.toasts[0].title, '已授予角色');
  assert.equal(calls.toasts[0].description, '用户5 → svip');
  assert.equal(editor(), null);
  assert.match(rows()[0].textContent, /SVIP.*2026-12-31 到期/);
});

test('superadmins can grant a permanent admin role and revoke admins while superadmin stays locked', async () => {
  await mod.mount('users', userProps({ canGrantAdmin: true }));
  assert.ok(q('[aria-label="撤销管理员"]'));
  assert.equal(q('[aria-label="撤销超级管理员"]'), null);
  await click(button('授予角色', rows()[4]));
  assert.equal(q('option[value="admin"]', editor()).disabled, false);
  assert.equal(q('option[value="privileged_test"]', editor()).disabled, false);
  await change(q('select', editor()), 'admin');
  await submit(q('form', editor()));
  assert.deepEqual(calls.grants, [['usr_004', 'admin', null]]);
});

test('grant failures preserve the draft and do not refresh or notify success; pending grants disable repeat submit', async () => {
  const pending = deferred();
  mod.rbacAdminApi.grantRole = (...args) => { calls.grants.push(args); return pending.promise; };
  await mod.mount('users', userProps());
  await click(button('授予角色', rows()[4]));
  await change(q('select', editor()), 'vip');
  await submit(q('form', editor()));
  assert.ok(button('授予中…', editor()).disabled);
  assert.ok(q('select', editor()).disabled);
  await submit(q('form', editor()));
  assert.equal(calls.grants.length, 1);
  await mod.act(async () => { pending.reject(new Error('授予失败')); });
  assert.match(document.body.textContent, /授予失败/);
  assert.equal(q('select', editor()).value, 'vip');
  assert.deepEqual(calls.search, ['']);
  assert.equal(calls.changed, 0);
  assert.deepEqual(calls.toasts, []);
});

test('revoke preserves confirmation, the current query, toast and onChanged', async () => {
  userRows = [makeUsers()[5]];
  await mod.mount('users', userProps());
  await searchUsers('用户5');
  const confirmations = [];
  window.confirm = (message) => { confirmations.push(message); return false; };
  await click(q('[aria-label="撤销VIP"]'));
  assert.deepEqual(calls.revokes, []);
  window.confirm = (message) => { confirmations.push(message); return true; };
  await click(q('[aria-label="撤销VIP"]'));
  assert.deepEqual(confirmations, ['确认撤销 用户5 的「VIP」角色？', '确认撤销 用户5 的「VIP」角色？']);
  assert.deepEqual(calls.revokes, [['usr_005', 'vip']]);
  assert.deepEqual(calls.search, ['', '用户5', '用户5']);
  assert.equal(calls.changed, 1);
  assert.equal(calls.toasts[0].title, '已撤销角色');
  assert.equal(q('[aria-label="撤销VIP"]'), null);
  assert.match(rows()[0].textContent, /普通用户（默认）/);
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

test('guests load once, render a compact aggregated table, paginate and search visitor IDs locally', async () => {
  await mod.mount('guests', { onLoaded: (count) => calls.loaded.push(count) });
  assert.equal(calls.guests, 1);
  assert.deepEqual(calls.loaded, [18]);
  const table = q('table[aria-label="游客"]');
  assert.deepEqual(all('th', table).map((cell) => cell.textContent), ['访客标识', '首次访问', '最近活跃', '活跃天数']);
  assert.match(table.className, /text-sm/);
  assert.match(q('thead', table).className, /text-xs text-slate-400/);
  assert.equal(rows('guest').length, 8);
  const cells = all('td', rows('guest')[0]);
  assert.equal(cells[0].title, guestData.guests[0].visitorId);
  assert.equal(cells[0].textContent, guestData.guests[0].visitorId.slice(0, 18) + '…');
  assert.match(cells[0].className, /font-mono/);
  assert.deepEqual(cells.slice(1).map((cell) => cell.textContent), ['2026-10-01', '2026-10-23', '1']);
  assert.match(q('footer').textContent, /共 18 位游客/);
  assert.doesNotMatch(q('footer').textContent, /取前 200/);
  assert.ok(button('上一页').disabled);
  await click(button('下一页'));
  assert.equal(rows('guest').length, 8);
  await click(button('下一页'));
  assert.equal(rows('guest').length, 2);
  assert.ok(button('下一页').disabled);
  await change(q('[aria-label="搜索游客"]'), ' GUEST-017 ');
  assert.equal(rows('guest').length, 1);
  assert.equal(q('td', rows('guest')[0]).title, guestData.guests[17].visitorId);
  assert.match(q('footer').textContent, /筛选 1 \/ 18 位游客.*第 1 \/ 1 页/);
  await change(q('[aria-label="搜索游客"]'), 'no-such-visitor');
  assert.equal(rows('guest').length, 0);
  assert.match(document.body.textContent, /暂无匹配游客。/);
  await change(q('[aria-label="搜索游客"]'), '');
  assert.equal(rows('guest').length, 8);
  assert.equal(calls.guests, 1, 'searching and paging do not re-fetch guests');
  assert.deepEqual(calls.loaded, [18], 'local searches do not change the loaded count');
});

test('guest loading stays distinct from unavailable and empty states', async () => {
  const pending = deferred();
  mod.rbacAdminApi.listGuests = () => { calls.guests += 1; return pending.promise; };
  await mod.mount('guests', { onLoaded: (count) => calls.loaded.push(count) });
  assert.match(document.body.textContent, /正在加载游客…/);
  assert.doesNotMatch(document.body.textContent, /暂无游客/);
  assert.ok(button('下一页').disabled);
  await resolveRequest(pending, { available: false, guests: [] });
  assert.match(document.body.textContent, /暂无游客数据（分析库不可用）/);
  assert.doesNotMatch(document.body.textContent, /正在加载游客|暂无游客访问记录/);
  assert.deepEqual(calls.loaded, [0]);
  assert.equal(calls.guests, 1);
});

test('available empty guests show the empty state and report zero loaded rows', async () => {
  guestData = { available: true, guests: [] };
  await mod.mount('guests', { onLoaded: (count) => calls.loaded.push(count) });
  assert.match(document.body.textContent, /暂无游客访问记录。/);
  assert.doesNotMatch(document.body.textContent, /分析库不可用/);
  assert.equal(rows('guest').length, 0);
  assert.deepEqual(calls.loaded, [0]);
  assert.match(q('footer').textContent, /共 0 位游客.*第 1 \/ 1 页/);
});

test('guest request failures display the error without pretending the data source is empty', async () => {
  mod.rbacAdminApi.listGuests = async () => { throw new Error('游客请求失败'); };
  await mod.mount('guests', { onLoaded: (count) => calls.loaded.push(count) });
  assert.match(document.body.textContent, /游客请求失败/);
  assert.doesNotMatch(document.body.textContent, /正在加载游客|暂无游客访问记录|分析库不可用/);
  assert.deepEqual(calls.loaded, []);
});

test('the users tab defaults to registered users and segments show loaded counts while preserving each view', async () => {
  await mod.mount('page');
  const segments = q('[aria-label="用户类型"]');
  const [registered, guests] = all('button', segments);
  assert.equal(registered.textContent, '注册用户18');
  assert.equal(registered.getAttribute('aria-pressed'), 'true');
  assert.equal(guests.textContent, '游客');
  assert.equal(calls.guests, 0, 'guests load when their segment is first visited');
  const usersTable = q('table[aria-label="注册用户"]');
  const usersSection = usersTable.closest('section');
  assert.equal(usersTable.closest('[hidden]'), null);
  await click(button('下一页', usersSection));
  await click(guests);
  const guestsTable = q('table[aria-label="游客"]');
  assert.ok(usersTable.closest('[hidden]'));
  assert.equal(guestsTable.closest('[hidden]'), null);
  assert.equal(guests.getAttribute('aria-pressed'), 'true');
  assert.equal(registered.getAttribute('aria-pressed'), 'false');
  assert.equal(guests.textContent, '游客18');
  await change(q('[aria-label="搜索游客"]'), 'guest-017');
  assert.equal(guests.textContent, '游客18', 'the badge counts loaded rows, not filtered rows');
  await click(registered);
  assert.equal(usersTable.closest('[hidden]'), null);
  assert.ok(guestsTable.closest('[hidden]'));
  assert.match(q('footer', usersSection).textContent, /第 2 \/ 3 页/);
  await click(guests);
  assert.equal(q('[aria-label="搜索游客"]').value, 'guest-017');
  assert.equal(rows('guest').length, 1);
  assert.deepEqual(calls.search, ['']);
  assert.equal(calls.guests, 1, 'returning to a loaded segment does not repeat its request');
  await click(registered);
  userRows = [userRows[17]];
  await searchUsers('用户17');
  assert.equal(registered.textContent, '注册用户1');
  assert.equal(guests.textContent, '游客18');
});

test('segment counts show 200+ at the cap and guest footer describes only a capped response', async () => {
  userRows = makeUsers(200);
  guestData = { available: true, guests: makeGuests(200) };
  await mod.mount('page');
  const [registered, guests] = all('button', q('[aria-label="用户类型"]'));
  assert.equal(registered.textContent, '注册用户200+');
  assert.match(q('footer').textContent, /共 200 位注册用户（当前查询取前 200）/);
  await click(guests);
  assert.equal(guests.textContent, '游客200+');
  const footer = q('footer', q('table[aria-label="游客"]').closest('section'));
  assert.match(footer.textContent, /共 200 位游客（按最近活跃排序，取前 200）/);
  assert.match(footer.textContent, /第 1 \/ 25 页/);
  await change(q('[aria-label="搜索游客"]'), 'guest-199');
  assert.match(footer.textContent, /筛选 1 \/ 200 位游客（按最近活跃排序，取前 200）/);
});

test('the client retains the 200-row limits and the CF guest source; other admin sections remain wired', () => {
  const api = readFileSync(join(root, 'src/app/rbac/rbacAdminApi.js'), 'utf8');
  assert.match(api, /searchUsers:.*limit=200/);
  assert.match(api, /fetch\(apiUrl\('\/api\/sync\/analytics\/guests\?limit=200'\)/);
  assert.doesNotMatch(api, /request\('GET', '\/guests'\)/);
  const page = readFileSync(join(root, 'src/pages/AdminRbacExperience.jsx'), 'utf8');
  for (const [section, panel] of [['roles', 'RbacRolesPanel'], ['menus', 'RbacMenusPanel'], ['audit', 'RbacAuditPanel']]) {
    assert.ok(page.includes("section === '" + section + "' ? <" + panel));
  }
});
