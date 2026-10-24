/* global URL */
// 菜单渲染：用 rolldown 打包真实组件后以 react-dom/server 渲染，检查锁图标、守卫页与角色角标。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromRoot = createRequire(join(root, 'package.json'));
const abs = (rel) => JSON.stringify(join(root, rel));

// 入口写在临时目录，所有依赖用绝对路径（与组件解析到同一份 react）。
const entrySource = `
import { createElement as h } from ${JSON.stringify(requireFromRoot.resolve('react'))};
import { renderToStaticMarkup } from ${JSON.stringify(requireFromRoot.resolve('react-dom/server'))};
import { ConsoleLayout } from ${abs('src/components/console-layout.jsx')};
import { MobileBottomNav } from ${abs('src/components/mobile-bottom-nav.jsx')};
import { GlobalSearch } from ${abs('src/components/global-search.jsx')};
import { AccessGuardPage } from ${abs('src/components/rbac/access-guard-page.jsx')};
import { RoleAvatar, RoleBadge, RoleList } from ${abs('src/components/rbac/role-badge.jsx')};
import { buildGuestFallback, flattenMenus, splitSidebarMenus } from ${abs('src/app/rbac/menuModel.js')};
import { resolveMenuIcon } from ${abs('src/components/rbac/menu-icons.js')};
export function render(name, props) {
  const map = { ConsoleLayout, MobileBottomNav, GlobalSearch, AccessGuardPage, RoleAvatar, RoleBadge, RoleList };
  return renderToStaticMarkup(h(map[name], props));
}
export { buildGuestFallback, flattenMenus, splitSidebarMenus, resolveMenuIcon };
`;

async function loadBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'rbac-ui-'));
  const entry = join(dir, 'entry.jsx');
  writeFileSync(entry, entrySource);
  const bundle = await rolldown({
    input: entry,
    platform: 'node',
    logLevel: 'silent',
    moduleTypes: { '.css': 'empty', '.jpg': 'empty', '.png': 'empty', '.svg': 'empty' },
    transform: { jsx: 'react-jsx', define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' } },
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  const file = join(dir, 'bundle.mjs');
  writeFileSync(file, output[0].code);
  const mod = await import(pathToFileURL(file).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const { mod, cleanup } = await loadBundle();
test.after(cleanup);

test('sidebar renders server menus with a lock icon on locked items', () => {
  const guest = mod.buildGuestFallback();
  const { primary } = mod.splitSidebarMenus(guest.menus);
  const nav = primary.map((m) => ({ key: m.key, label: m.label, href: `?tab=${m.key}`, icon: mod.resolveMenuIcon(m.icon, m.key), locked: m.locked }));
  const html = mod.render('ConsoleLayout', { brand: 'x', sidebarNav: nav, activeKey: 'home', children: null });
  assert.match(html, /首页/);
  assert.match(html, /持仓总览/);
  const lockedLinks = html.match(/data-locked="true"/g) || [];
  assert.equal(lockedLinks.length, 6, 'markets/holdings/tradePlans/fundSwitch/notify/dataRepair are locked for guests');
  assert.equal((html.match(/data-menu-lock="true"/g) || []).length, 6);
  assert.doesNotMatch(html, /雷达|权限管理/);
});

test('mobile bottom nav renders only server-visible menus and marks locked ones', () => {
  const menus = mod.flattenMenus(mod.buildGuestFallback().menus);
  const html = mod.render('MobileBottomNav', { activeKey: 'home', menus, onSelectTab() {}, onOpenAccount() {} });
  assert.match(html, /首页/);
  assert.match(html, /持仓/);
  assert.match(html, /data-locked="true"/);
  assert.doesNotMatch(html, /量化|雷达|竞价看板/);
});

test('global search lists menu entries with lock state', () => {
  const menus = [
    { key: 'holdings', label: '持仓总览', locked: false },
    { key: 'adminRadar', label: '雷达', locked: true, requiredRole: { code: 'vip', name: 'VIP' } },
  ];
  const html = mod.render('GlobalSearch', { open: true, menus, onClose() {}, onSelectTab() {} });
  assert.match(html, /持仓总览/);
  assert.match(html, /VIP 专享/);
  assert.equal((html.match(/data-locked="true"/g) || []).length, 1);
});

test('route guard pages: 403 shows the required role, login page shows the login button', () => {
  const forbidden = mod.render('AccessGuardPage', { status: 'forbidden', requiredRole: { code: 'svip', name: 'SVIP' }, menuLabel: '竞价看板' });
  assert.match(forbidden, /data-testid="access-guard-paid"/);
  assert.match(forbidden, /SVIP 专享/);
  assert.doesNotMatch(forbidden, /403/);
  const paid = mod.render('AccessGuardPage', { status: 'forbidden', requiredRole: { code: 'vip', name: 'VIP' }, menuLabel: '雷达', username: 'lovexl', onUpgrade() {} });
  assert.match(paid, /请随意打赏并备注账号名/);
  assert.match(paid, /lovexl/);
  assert.match(paid, /管理员看到后会尽快为您开通/);
  assert.match(paid, /打赏开通/);
  const adminOnly = mod.render('AccessGuardPage', { status: 'forbidden', requiredRole: { code: 'admin', name: '管理员' }, menuLabel: '权限管理' });
  assert.match(adminOnly, /data-testid="access-guard-forbidden"/);
  assert.match(adminOnly, /403/);
  assert.match(adminOnly, /仅管理员可访问/);
  assert.doesNotMatch(adminOnly, /打赏/);
  const login = mod.render('AccessGuardPage', { status: 'login', requiredRole: { code: 'user', name: '普通用户' }, menuLabel: '持仓总览' });
  assert.match(login, /data-testid="access-guard-login"/);
  assert.match(login, /登录 \/ 注册/);
});

test('route guard demo offer: intro points render one per line, signup note is two lines, demo button reads 体验一下', () => {
  const demo = { remaining: 2, perDay: 3, points: ['实时对比各只纳指 ETF 的溢价差', '设好切出、切回阈值，命中就提醒'] };
  const login = mod.render('AccessGuardPage', { status: 'login', requiredRole: { code: 'vip', name: 'VIP' }, menuLabel: '换基策略', demo, onDemo() {}, autoPromptLogin: false });
  assert.match(login, /data-testid="access-guard-points"/);
  assert.equal((login.match(/<li /g) || []).length, 2);
  assert.match(login, /免费注册送 3 个月 VIP<\/span><span class="block">数据存在账号里，换设备也能接着用/);
  assert.match(login, /体验一下/);
  assert.doesNotMatch(login, /免费体验|分钟/);
  assert.match(login, /今日还可体验 2 次/);
  const paid = mod.render('AccessGuardPage', { status: 'forbidden', requiredRole: { code: 'vip', name: 'VIP' }, menuLabel: '雷达', demo: { remaining: 0, pitch: '旧的一段介绍' }, onDemo() {}, onUpgrade() {} });
  assert.equal((paid.match(/<li /g) || []).length, 1); // 兼容旧 pitch 字符串
  assert.match(paid, /旧的一段介绍/);
  assert.match(paid, /体验一下/);
  assert.match(paid, /今日体验次数已用完/);
});

test('avatar role badge: VIP gold crown, SVIP diamond, admin shield, none for user; role list shows expiry', () => {
  assert.match(mod.render('RoleBadge', { topRole: { code: 'vip' } }), /data-role-badge="crown"[^>]*|bg-amber-400/);
  assert.match(mod.render('RoleBadge', { topRole: { code: 'svip' } }), /data-role-badge="diamond"/);
  assert.match(mod.render('RoleBadge', { topRole: { code: 'admin' } }), /data-role-badge="shield"/);
  assert.equal(mod.render('RoleBadge', { topRole: { code: 'user' } }), '');
  const list = mod.render('RoleList', { roles: [{ code: 'vip', name: 'VIP', expiresAt: '2026-12-31T15:59:59.000Z' }, { code: 'user', name: '普通用户', expiresAt: null }] });
  assert.match(list, /2026-12-31 到期/);
  assert.match(list, /长期有效/);
});

test('avatar ring: tiered gradient ring per role, superadmin four-colour, plain grey for user, chip only on lg', () => {
  const vip = mod.render('RoleAvatar', { topRole: { code: 'vip', name: 'VIP' }, initial: 'L' });
  assert.match(vip, /data-role-ring="vip"/);
  assert.match(vip, /#f59e0b/);
  assert.doesNotMatch(vip, /data-role-chip/);
  const svip = mod.render('RoleAvatar', { topRole: { code: 'svip' }, initial: 'L', size: 'lg', showChip: true });
  assert.match(svip, /animate-spin/);
  assert.match(svip, /motion-reduce:animate-none/);
  assert.match(svip, /data-role-chip="svip"/);
  const superadmin = mod.render('RoleAvatar', { topRole: { code: 'superadmin' }, initial: 'L', size: 'lg', showChip: true });
  assert.match(superadmin, /#4285f4 0 25%, #ea4335 0 50%, #fbbc05 0 75%, #34a853 0 100%/);
  assert.match(superadmin, />超管</);
  assert.match(mod.render('RoleAvatar', { topRole: { code: 'admin' }, initial: 'L' }), /data-role-ring="admin"/);
  const user = mod.render('RoleAvatar', { topRole: { code: 'user' }, initial: 'L', size: 'lg', showChip: true });
  assert.match(user, /data-role-ring="none"/);
  assert.match(user, /#e2e8f0/);
  assert.doesNotMatch(user, /data-role-chip/);
});
