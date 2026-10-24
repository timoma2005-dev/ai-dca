/* global URL */
// WorkspacePage 路由守卫（RBAC）：?tab= 不再静默回退；游客点锁住的菜单弹登录；角色不足显示 403；旧份额链接保持公开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { DEFAULT_WORKSPACE_TAB, LEGACY_TAB_REDIRECTS, WORKSPACE_TAB_META, isWorkspaceGroup } from '../src/app/screens.js';
import { buildGuestFallback, evaluateTabAccess } from '../src/app/rbac/menuModel.js';
import { demoFeatureFor } from '../src/app/demo/featureDemo.js';

const source = readFileSync(new URL('../src/pages/WorkspacePage.jsx', import.meta.url), 'utf8');

function menu(key, locked, requiredRole = null, group = 'primary') {
  return { key, label: key, tab: key, group, locked, requiredRole, children: [] };
}
const STATES = {
  guest: buildGuestFallback(),
  user: {
    loggedIn: true,
    menus: [menu('home', false), menu('shares', false), menu('holdings', false),
      menu('adminRadar', true, { code: 'vip', name: 'VIP' }, 'admin'), menu('adminAuction', true, { code: 'svip', name: 'SVIP' }, 'admin')],
    perms: ['menu:home:access', 'menu:shares:access', 'menu:holdings:access'],
  },
  auctionOnly: {
    loggedIn: true,
    menus: [menu('home', false), menu('shares', false), menu('holdings', false), menu('adminAuction', false, null, 'admin'), menu('adminRadar', true, { code: 'vip', name: 'VIP' }, 'admin')],
    perms: ['menu:home:access', 'menu:shares:access', 'menu:holdings:access', 'menu:adminAuction:access'],
  },
  admin: {
    loggedIn: true,
    menus: ['home', 'shares', 'holdings', 'adminRadar', 'adminAuction', 'adminRbac'].map((k) => menu(k, false)),
    perms: ['home', 'shares', 'holdings', 'adminRadar', 'adminAuction', 'adminRbac'].map((k) => `menu:${k}:access`),
  },
};

// 从源码取出 tabAccessOf 的判定体，保证测试跑的就是页面里的逻辑。
const accessSource = source.match(/ {2}const tabAccessOf = useCallback\(\(tabKey, hash = ''\) => \{[\s\S]*?\n {2}\}, \[rbac\]\);/)[0];
const makeAccess = new Function('rbac', 'evaluateTabAccess', 'useCallback', `${accessSource}\nreturn tabAccessOf;`);
const tabAccessFor = (name) => makeAccess(STATES[name], evaluateTabAccess, (cb) => cb);

test('shares URL resolves directly to the shares primary tab without a legacy redirect', () => {
  const window = { location: new URL('https://example.test/home.html?tab=shares') };
  const helpers = source.slice(source.indexOf('function normalizeWorkspaceTab'), source.indexOf('function buildWorkspaceUrl'));
  const read = new Function('window', 'DEFAULT_WORKSPACE_TAB', 'LEGACY_TAB_REDIRECTS', 'isWorkspaceGroup',
    helpers + '; return readTabFromLocation();');
  assert.equal(read(window, DEFAULT_WORKSPACE_TAB, LEGACY_TAB_REDIRECTS, isWorkspaceGroup), 'shares');
  assert.equal(Object.hasOwn(LEGACY_TAB_REDIRECTS, 'shares'), false);
  assert.equal(isWorkspaceGroup('adminRbac'), true);
});

test('route guard: no silent fallback effect remains', () => {
  assert.doesNotMatch(source, /!canAccessTab\(activeTab\)/);
  assert.doesNotMatch(source, /isPublicShares && !canAccessTab/);
  assert.match(source, /const activeAccess = tabAccessOf\(activeTab,/);
});

test('route guard decisions per role (legacy #shares link stays public)', () => {
  const cases = [
    ['guest', 'home', '', 'ok'],
    ['guest', 'holdings', '', 'login'],
    ['guest', 'adminRadar', '#shares', 'ok'],
    ['guest', 'adminRadar', '', 'login'],
    ['user', 'holdings', '', 'ok'],
    ['user', 'adminRadar', '', 'forbidden'],
    ['user', 'adminRadar', '#shares', 'ok'],
    ['user', 'adminAuction', '#shares', 'forbidden'],
    ['user', 'adminRbac', '', 'forbidden'],
    ['auctionOnly', 'adminAuction', '', 'ok'],
    ['auctionOnly', 'adminRbac', '', 'forbidden'],
    ['auctionOnly', 'adminRadar', '#radar', 'forbidden'],
    ['admin', 'adminRbac', '', 'ok'],
  ];
  for (const [state, tab, hash, expected] of cases) {
    assert.equal(tabAccessFor(state)(tab, hash).status, expected, `${state} ${tab}${hash}`);
  }
});

test('tab selection: guests clicking a locked menu get the login dialog instead of navigation', () => {
  const start = source.indexOf('  function handleSelectTab(');
  const end = source.indexOf('    const hash =', start);
  const select = new Function('nextTab', 'options', 'tabAccessOf', 'normalizeWorkspaceTab', 'openAccountAuth', 'demoFeatureFor',
    source.slice(start, end) + '\nreturn true;\n}\nreturn handleSelectTab(nextTab, options);');
  for (const [state, tab, hash, navigates, opensLogin] of [
    ['guest', 'adminAuction', undefined, true, false], // 竞价看板有演示（模拟行情演示页）：进入守卫页先体验
    ['guest', 'holdings', undefined, true, false], // 持仓总览有演示：进入守卫页先体验
    ['guest', 'home', undefined, true, false],
    ['guest', 'markets', undefined, true, false], // 有演示的付费功能：进入守卫页先体验
    ['guest', 'adminRadar', '#shares', true, false],
    ['user', 'adminRadar', undefined, true, false], // 角色不足：照常切换，由 403 页展示
    ['user', 'holdings', undefined, true, false],
  ]) {
    const prompts = [];
    const result = select(tab, { hash }, tabAccessFor(state), (v) => v, (detail) => prompts.push(detail), demoFeatureFor);
    assert.equal(result === true, navigates, `${state} ${tab} navigates`);
    assert.equal(prompts.length > 0, opensLogin, `${state} ${tab} login prompt`);
    if (opensLogin) assert.equal(prompts[0].mode, 'login');
  }
  // 无演示的锁定功能：弹登录、不切换
  const prompts = [];
  assert.equal(select('adminAuction', {}, tabAccessFor('guest'), (v) => v, (detail) => prompts.push(detail), () => null), undefined);
  assert.equal(prompts[0]?.mode, 'login');
});

const panelSource = source.match(/ {2}function renderActivePanel\([^)]*\) \{[\s\S]*?\n {2}\}\n/)[0];
const panelCode = (await transformWithOxc(panelSource, 'panel.jsx', { lang: 'jsx', jsx: { runtime: 'classic' } })).code;
const renderPanel = new Function('activeTab', 'activeAccess', 'window', 'links', 'inPagesDir', 'React', 'WORKSPACE_TAB_META',
  'openAccountAuth', 'handleSelectTab', 'AccessGuardPage',
  'SharesExperience', 'AdminRadarExperience', 'AdminAuctionExperience', 'HoldingsExperience', 'AdminRbacExperience', 'accountUsername', 'demoOffer', 'startFeatureDemo',
  `${panelCode}\nreturn renderActivePanel();`);
const resolvePanel = (state, tab, hash = '') => {
  const element = renderPanel(tab, tabAccessFor(state)(tab, hash), { location: { hash } }, {}, false,
    { createElement: (component, props) => (component === 'guard' ? `guard:${props.status}:${props.requiredRole?.code || ''}` : component) },
    WORKSPACE_TAB_META, () => {}, () => {}, 'guard',
    'shares', 'radar', 'auction', 'holdings', 'rbac', '', null, () => {});
  return element;
};

test('panel rendering: guard page replaces the panel instead of silently showing holdings', () => {
  assert.equal(resolvePanel('guest', 'holdings'), 'guard:login:user');
  assert.equal(resolvePanel('user', 'adminRadar'), 'guard:forbidden:vip');
  assert.equal(resolvePanel('user', 'adminAuction'), 'guard:forbidden:svip');
  assert.equal(resolvePanel('auctionOnly', 'adminAuction'), 'auction');
  assert.equal(resolvePanel('auctionOnly', 'adminRbac'), 'guard:forbidden:', 'hidden menu: forbidden without a role hint');
  assert.equal(resolvePanel('admin', 'adminRadar'), 'radar');
  assert.equal(resolvePanel('admin', 'adminRbac'), 'rbac');
  for (const state of ['guest', 'user', 'auctionOnly', 'admin']) {
    assert.equal(resolvePanel(state, 'adminRadar', '#shares'), 'shares', `${state} legacy shares link`);
    assert.equal(resolvePanel(state, 'shares'), 'shares');
  }
  assert.match(source, /const SharesExperience = lazy\(\(\) => import\('\.\/SharesExperience\.jsx'\)\);/);
  assert.match(source, /case 'shares':\s*return <SharesExperience \/>;/);
});

test('radar page requires the radar menu permission (VIP+), not a hardcoded user', () => {
  const radarSource = readFileSync(new URL('../src/pages/AdminRadarExperience.jsx', import.meta.url), 'utf8');
  assert.match(radarSource, /canAccessMenuFromSession\(session, 'adminRadar'\)/);
  assert.doesNotMatch(radarSource, /lovexl|SharesExperience|PageTabs|#shares/);
});
