/* global URL */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_WORKSPACE_TAB, LEGACY_TAB_REDIRECTS, isWorkspaceGroup } from '../src/app/screens.js';

const source = readFileSync(new URL('../src/pages/WorkspacePage.jsx', import.meta.url), 'utf8');
test('shares URL resolves directly to the shares primary tab without a legacy redirect', () => {
  const window = { location: new URL('https://example.test/home.html?tab=shares') };
  const helpers = source.slice(source.indexOf('function normalizeWorkspaceTab'), source.indexOf('function buildWorkspaceUrl'));
  const read = new Function('window', 'DEFAULT_WORKSPACE_TAB', 'LEGACY_TAB_REDIRECTS', 'isWorkspaceGroup',
    helpers + '; return readTabFromLocation();');
  assert.equal(read(window, DEFAULT_WORKSPACE_TAB, LEGACY_TAB_REDIRECTS, isWorkspaceGroup), 'shares');
  assert.equal(Object.hasOwn(LEGACY_TAB_REDIRECTS, 'shares'), false);
});

test('workspace admin effect allows public shares and still resets other admin tabs', () => {
  const marker = source.indexOf('const isPublicShares = activeTab');
  const start = source.lastIndexOf('  useEffect(() => {', marker);
  const end = source.indexOf('\n\n  useEffect', marker);
  const run = new Function('window', 'activeTab', 'isAdminUser', 'WORKSPACE_TAB_META',
    'setActiveTab', 'resolveDefaultWorkspaceTab', 'DEFAULT_WORKSPACE_TAB', 'useEffect',
    source.slice(start, end));
  for (const [tab, hash, admin, reset] of [
    ['adminRadar', '#shares', false, false],
    ['adminRadar', '#radar', false, true],
    ['adminRadar', '', false, true],
    ['otherAdmin', '#shares', false, true],
    ['adminRadar', '#radar', true, false]
  ]) {
    const updates = [];
    run({ location: { hash } }, tab, admin,
      { adminRadar: { adminOnly: true }, otherAdmin: { adminOnly: true } },
      (value) => updates.push(value), (value) => value, DEFAULT_WORKSPACE_TAB, (effect) => effect());
    assert.deepEqual(updates, reset ? [DEFAULT_WORKSPACE_TAB] : [], `${tab} ${hash} admin=${admin}`);
  }
});

test('tab selection allows public shares while retaining other admin guards', () => {
  const start = source.indexOf('  function handleSelectTab(');
  const end = source.indexOf('    const hash =', start);
  const select = new Function('nextTab', 'options', 'isAdminUser', 'WORKSPACE_TAB_META',
    'normalizeWorkspaceTab', source.slice(start, end) + '\nreturn true;\n}\nreturn handleSelectTab(nextTab, options);');
  const meta = { adminRadar: { adminOnly: true }, otherAdmin: { adminOnly: true } };
  for (const [tab, hash, admin, allowed] of [
    ['adminRadar', '#shares', false, true],
    ['adminRadar', '#radar', false, false],
    ['adminRadar', undefined, false, false],
    ['otherAdmin', '#shares', false, false],
    ['adminRadar', '#radar', true, true]
  ]) {
    assert.equal(select(tab, { hash }, admin, meta, (value) => value), allowed ? true : undefined,
      `${tab} ${hash} admin=${admin}`);
  }
});

test('radar page only grants non-admin access to the shares subtab', () => {
  const radarSource = readFileSync(new URL('../src/pages/AdminRadarExperience.jsx', import.meta.url), 'utf8');
  const condition = radarSource.match(/if \((.*?)\) \{\n {4}return <p/)[1];
  const denied = new Function('activeTab', 'session', 'isAnalyticsAdmin', `return ${condition};`);
  assert.equal(denied('shares', null, () => false), false);
  assert.equal(denied('radar', null, () => false), true);
  assert.equal(denied('radar', {}, () => true), false);
  // 雷达 #shares 子 tab 直接挂载新组件，权限与 hash 逻辑保持不变。
  assert.match(radarSource, /import SharesExperience from '\.\/SharesExperience\.jsx';/);
  assert.match(radarSource, /\{activeTab === 'shares' && <SharesExperience \/>\}/);
});

test('workspace renders public legacy shares while retaining the radar admin guard', () => {
  const condition = source.match(/case 'adminRadar':\s*return (.*?) \? <AdminRadarExperience/)[1];
  const allowed = new Function('isAdminUser', 'window', `return ${condition};`);
  assert.equal(allowed(false, { location: { hash: '#shares' } }), true);
  assert.equal(allowed(false, { location: { hash: '#radar' } }), false);
  assert.equal(allowed(false, { location: { hash: '' } }), false);
  assert.equal(allowed(true, { location: { hash: '#radar' } }), true);
  // shares 主 tab 懒加载新组件，保留 lazy 路径与公共访问逻辑。
  assert.match(source, /const SharesExperience = lazy\(\(\) => import\('\.\/SharesExperience\.jsx'\)\);/);
  assert.match(source, /case 'shares':\s*return <SharesExperience \/>;/);
});
