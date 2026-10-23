/* global URL */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { DEFAULT_WORKSPACE_TAB, LEGACY_TAB_REDIRECTS, WORKSPACE_TAB_META, isWorkspaceGroup } from '../src/app/screens.js';

const source = readFileSync(new URL('../src/pages/WorkspacePage.jsx', import.meta.url), 'utf8');
const predicateSource = source.match(/ {2}const canAccessTab = useCallback\([\s\S]*?\n {2}\}, \[canAccessAuction, isAdminUser\]\);/)[0];
const createPredicate = new Function('WORKSPACE_TAB_META', 'isAdminUser', 'canAccessAuction', 'useCallback',
  `${predicateSource}\nreturn canAccessTab;`);
const tabAccess = (admin, auction = admin) => createPredicate(
  { ...WORKSPACE_TAB_META, otherAdmin: { adminOnly: true } }, admin, auction, (callback) => callback,
);

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
  const run = new Function('window', 'activeTab', 'canAccessTab',
    'setActiveTab', 'resolveDefaultWorkspaceTab', 'DEFAULT_WORKSPACE_TAB', 'useEffect',
    source.slice(start, end));
  for (const [tab, hash, admin, reset, auction = admin] of [
    ['adminRadar', '#shares', false, false],
    ['adminRadar', '#shares', true, false],
    ['adminRadar', '#radar', false, true],
    ['adminRadar', '#auction', false, true],
    ['adminRadar', '', false, true],
    ['adminAuction', '#shares', false, true],
    ['adminAuction', '', false, true],
    ['adminAuction', '', true, false],
    ['otherAdmin', '#shares', false, true],
    ['adminRadar', '#radar', true, false],
    ['adminAuction', '#shares', false, false, true],
    ['adminAuction', '', false, false, true],
    ['adminQuant', '', false, true, true],
    ['adminRadar', '#radar', false, true, true],
    ['adminRadar', '#shares', false, false, true],
    ['otherAdmin', '#shares', false, true, true]
  ]) {
    const updates = [];
    run({ location: { hash } }, tab, tabAccess(admin, auction),
      (value) => updates.push(value), (value) => value, DEFAULT_WORKSPACE_TAB, (effect) => effect());
    assert.deepEqual(updates, reset ? [DEFAULT_WORKSPACE_TAB] : [], `${tab} ${hash} admin=${admin} auction=${auction}`);
  }
});

test('tab selection allows public shares while retaining other admin guards', () => {
  const start = source.indexOf('  function handleSelectTab(');
  const end = source.indexOf('    const hash =', start);
  const select = new Function('nextTab', 'options', 'canAccessTab',
    'normalizeWorkspaceTab', source.slice(start, end) + '\nreturn true;\n}\nreturn handleSelectTab(nextTab, options);');
  for (const [tab, hash, admin, allowed, auction = admin] of [
    ['adminRadar', '#shares', false, true],
    ['adminRadar', '#shares', true, true],
    ['adminRadar', '#radar', false, false],
    ['adminRadar', '#auction', false, false],
    ['adminRadar', undefined, false, false],
    ['adminAuction', '#shares', false, false],
    ['adminAuction', undefined, false, false],
    ['adminAuction', undefined, true, true],
    ['otherAdmin', '#shares', false, false],
    ['adminRadar', '#radar', true, true],
    ['adminAuction', '#shares', false, true, true],
    ['adminAuction', undefined, false, true, true],
    ['adminQuant', undefined, false, false, true],
    ['adminRadar', '#radar', false, false, true],
    ['adminRadar', '#shares', false, true, true],
    ['otherAdmin', '#shares', false, false, true]
  ]) {
    assert.equal(select(tab, { hash }, tabAccess(admin, auction), (value) => value), allowed ? true : undefined,
      `${tab} ${hash} admin=${admin} auction=${auction}`);
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
const renderPanel = new Function('activeTab', 'isAdminUser', 'canAccessTab', 'window', 'links', 'inPagesDir', 'React',
  'SharesExperience', 'AdminQuantExperience', 'AdminRadarExperience', 'AdminAuctionExperience', 'HoldingsExperience',
  `${panelCode}\nreturn renderActivePanel();`);
const resolvePanel = (tab, hash, admin, auction = admin) => renderPanel(tab, admin, tabAccess(admin, auction),
  { location: { hash } }, {}, false,
  { createElement: (component) => component }, 'shares', 'quant', 'radar', 'auction', 'holdings');

test('workspace renders legacy shares directly for admins and non-admins', () => {
  for (const [admin, auction] of [[false, false], [false, true], [true, true]]) {
    assert.equal(resolvePanel('adminRadar', '#shares', admin, auction), 'shares');
    assert.equal(resolvePanel('shares', '', admin, auction), 'shares');
  }
  assert.match(source, /const SharesExperience = lazy\(\(\) => import\('\.\/SharesExperience\.jsx'\)\);/);
  assert.match(source, /case 'shares':\s*return <SharesExperience \/>;/);
});

test('workspace keeps radar admin-only for every other hash', () => {
  for (const hash of ['', '#radar', '#auction', '#unknown']) {
    assert.equal(resolvePanel('adminRadar', hash, false), 'holdings', `hash=${hash}`);
    assert.equal(resolvePanel('adminRadar', hash, false, true), 'holdings', `hash=${hash} auction-only`);
    assert.equal(resolvePanel('adminRadar', hash, true), 'radar', `hash=${hash}`);
  }
});

test('workspace keeps quant admin-only for auction-only accounts', () => {
  assert.equal(resolvePanel('adminQuant', '', false, true), 'holdings');
  assert.equal(resolvePanel('adminQuant', '', true), 'quant');
});

test('workspace auction panel allows admins or auction permission even with the legacy shares hash', () => {
  for (const hash of ['', '#shares', '#auction']) {
    assert.equal(resolvePanel('adminAuction', hash, false), 'holdings', `hash=${hash}`);
    assert.equal(resolvePanel('adminAuction', hash, false, true), 'auction', `hash=${hash} auction-only`);
    assert.equal(resolvePanel('adminAuction', hash, true), 'auction', `hash=${hash}`);
  }
});
