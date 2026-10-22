/* global URL */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
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
    ['adminRadar', '#shares', true, false],
    ['adminRadar', '#radar', false, true],
    ['adminRadar', '#auction', false, true],
    ['adminRadar', '', false, true],
    ['adminAuction', '#shares', false, true],
    ['adminAuction', '', false, true],
    ['adminAuction', '', true, false],
    ['otherAdmin', '#shares', false, true],
    ['adminRadar', '#radar', true, false]
  ]) {
    const updates = [];
    run({ location: { hash } }, tab, admin,
      { adminRadar: { adminOnly: true }, adminAuction: { adminOnly: true }, otherAdmin: { adminOnly: true } },
      (value) => updates.push(value), (value) => value, DEFAULT_WORKSPACE_TAB, (effect) => effect());
    assert.deepEqual(updates, reset ? [DEFAULT_WORKSPACE_TAB] : [], `${tab} ${hash} admin=${admin}`);
  }
});

test('tab selection allows public shares while retaining other admin guards', () => {
  const start = source.indexOf('  function handleSelectTab(');
  const end = source.indexOf('    const hash =', start);
  const select = new Function('nextTab', 'options', 'isAdminUser', 'WORKSPACE_TAB_META',
    'normalizeWorkspaceTab', source.slice(start, end) + '\nreturn true;\n}\nreturn handleSelectTab(nextTab, options);');
  const meta = { adminRadar: { adminOnly: true }, adminAuction: { adminOnly: true }, otherAdmin: { adminOnly: true } };
  for (const [tab, hash, admin, allowed] of [
    ['adminRadar', '#shares', false, true],
    ['adminRadar', '#shares', true, true],
    ['adminRadar', '#radar', false, false],
    ['adminRadar', '#auction', false, false],
    ['adminRadar', undefined, false, false],
    ['adminAuction', '#shares', false, false],
    ['adminAuction', undefined, false, false],
    ['adminAuction', undefined, true, true],
    ['otherAdmin', '#shares', false, false],
    ['adminRadar', '#radar', true, true]
  ]) {
    assert.equal(select(tab, { hash }, admin, meta, (value) => value), allowed ? true : undefined,
      `${tab} ${hash} admin=${admin}`);
  }
});

test('radar page always requires admin access', () => {
  const radarSource = readFileSync(new URL('../src/pages/AdminRadarExperience.jsx', import.meta.url), 'utf8');
  const condition = radarSource.match(/if \((.*?)\) \{\n {4}return <p/)[1];
  const denied = new Function('session', 'isAnalyticsAdmin', `return ${condition};`);
  assert.equal(denied(null, () => false), true);
  assert.equal(denied({}, () => true), false);
  assert.doesNotMatch(radarSource, /SharesExperience|PageTabs|#shares/);
});

const panelSource = source.match(/ {2}function renderActivePanel\(\) \{[\s\S]*?\n {2}\}/)[0];
const panelCode = transformSync(panelSource, { loader: 'jsx' }).code;
const renderPanel = new Function('activeTab', 'isAdminUser', 'window', 'links', 'inPagesDir', 'React',
  'SharesExperience', 'AdminRadarExperience', 'AdminAuctionExperience', 'HoldingsExperience',
  `${panelCode}\nreturn renderActivePanel();`);
const resolvePanel = (tab, hash, admin) => renderPanel(tab, admin, { location: { hash } }, {}, false,
  { createElement: (component) => component }, 'shares', 'radar', 'auction', 'holdings');

test('workspace renders legacy shares directly for admins and non-admins', () => {
  for (const admin of [false, true]) {
    assert.equal(resolvePanel('adminRadar', '#shares', admin), 'shares');
    assert.equal(resolvePanel('shares', '', admin), 'shares');
  }
  assert.match(source, /const SharesExperience = lazy\(\(\) => import\('\.\/SharesExperience\.jsx'\)\);/);
  assert.match(source, /case 'shares':\s*return <SharesExperience \/>;/);
});

test('workspace keeps radar admin-only for every other hash', () => {
  for (const hash of ['', '#radar', '#auction', '#unknown']) {
    assert.equal(resolvePanel('adminRadar', hash, false), 'holdings', `hash=${hash}`);
    assert.equal(resolvePanel('adminRadar', hash, true), 'radar', `hash=${hash}`);
  }
});

test('workspace auction panel requires an admin even with the legacy shares hash', () => {
  for (const hash of ['', '#shares', '#auction']) {
    assert.equal(resolvePanel('adminAuction', hash, false), 'holdings', `hash=${hash}`);
    assert.equal(resolvePanel('adminAuction', hash, true), 'auction', `hash=${hash}`);
  }
});
