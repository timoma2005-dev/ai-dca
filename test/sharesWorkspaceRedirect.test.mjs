/* global URL */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_WORKSPACE_TAB, LEGACY_TAB_REDIRECTS, isWorkspaceGroup } from '../src/app/screens.js';

const source = readFileSync(new URL('../src/pages/WorkspacePage.jsx', import.meta.url), 'utf8');
test('shares legacy URL resolves to adminRadar, rewrites the target and notifies the shares subtab', () => {
  let current = new URL('https://example.test/home.html?tab=shares');
  const events = [];
  const window = {
    get location() { return current; },
    history: { replaceState(state, _, next) {
      assert.equal(state.tab, 'adminRadar');
      current = new URL(next);
    } },
    dispatchEvent(event) { events.push(event.type); }
  };
  const helpers = source.slice(source.indexOf('function normalizeWorkspaceTab'), source.indexOf('function buildWorkspaceUrl'));
  const read = new Function('window', 'DEFAULT_WORKSPACE_TAB', 'LEGACY_TAB_REDIRECTS', 'isWorkspaceGroup',
    helpers + '; return readTabFromLocation();');
  assert.equal(read(window, DEFAULT_WORKSPACE_TAB, LEGACY_TAB_REDIRECTS, isWorkspaceGroup), 'adminRadar');
  const start = source.indexOf('  useEffect(() => {', source.indexOf('// Legacy tab 重写'));
  const end = source.indexOf('\n\n  useEffect', start);
  new Function('window', 'LEGACY_TAB_REDIRECTS', 'useEffect', 'HashChangeEvent', helpers + source.slice(start, end))(
    window, LEGACY_TAB_REDIRECTS, (effect) => effect(), class { constructor(type) { this.type = type; } }
  );
  assert.equal(current.searchParams.get('tab'), 'adminRadar');
  assert.equal(current.hash, '#shares');
  assert.deepEqual(events, ['hashchange']);
  assert.match(source, /HASH_ROUTE_TABS = new Set\(\[[^\]]*'adminRadar'/);
});
