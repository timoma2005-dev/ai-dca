/* global URL */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canAccessAdminAuction, isAnalyticsAdmin } from '../src/app/analytics.js';
import { WORKSPACE_TAB_META } from '../src/app/screens.js';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const analyticsSource = readSource('../src/app/analytics.js');
const workspaceSource = readSource('../src/pages/WorkspacePage.jsx');
const searchSource = readSource('../src/components/global-search.jsx');
const mobileSource = readSource('../src/components/mobile-bottom-nav.jsx');
const mobileConfigSource = readSource('../src/components/mobile-bottom-nav-config.js');

test('auction permission accepts the normalized account and trimmed email input', () => {
  assert.equal(canAccessAdminAuction({ username: '551668745qq.com' }), true);
  assert.equal(canAccessAdminAuction({ username: '551668745@qq.com ' }), true);
  assert.equal(canAccessAdminAuction({ username: ' 551668745QQ.COM ' }), true);
  assert.equal(isAnalyticsAdmin({ username: '551668745qq.com' }), false);
  assert.equal(isAnalyticsAdmin({ username: '551668745@qq.com ' }), false);
});

test('auction permission preserves full admins and denies unlisted or missing users', () => {
  assert.equal(canAccessAdminAuction({ username: 'lovexl' }), true);
  assert.equal(canAccessAdminAuction({ username: ' LOVEXL ' }), true);
  assert.equal(canAccessAdminAuction({ username: 'another-admin', isAdmin: true }), true);
  assert.equal(canAccessAdminAuction({ username: 'someoneelse' }), false);
  assert.equal(canAccessAdminAuction({}), false);
  assert.equal(canAccessAdminAuction(null), false);
  assert.equal(canAccessAdminAuction(), false);
});

test('auction allowlist stays separate from the lovexl-only full admin allowlist', () => {
  assert.match(analyticsSource, /const ADMIN_USERS = new Set\(\['lovexl'\]\);/);
  assert.match(analyticsSource, /const ADMIN_AUCTION_USERS = new Set\(\['551668745qq\.com'\]\);/);
  assert.match(analyticsSource, /export function canAccessAdminAuction\(session = readAnalyticsSession\(\)\) \{\s*if \(isAnalyticsAdmin\(session\)\) return true;/);
});

test('workspace predicate grants only auction among admin tabs to the designated user', () => {
  const predicateSource = workspaceSource.match(/ {2}const canAccessTab = useCallback\([\s\S]*?\n {2}\}, \[canAccessAuction, isAdminUser\]\);/)[0];
  const createPredicate = new Function('WORKSPACE_TAB_META', 'isAdminUser', 'canAccessAuction', 'useCallback',
    `${predicateSource}\nreturn canAccessTab;`);
  for (const [session, expectedTabs] of [
    [{ username: '551668745qq.com' }, ['holdings', 'adminAuction']],
    [{ username: 'lovexl' }, ['holdings', 'adminQuant', 'adminRadar', 'adminAuction']],
    [{ username: 'someoneelse' }, ['holdings']],
    [null, ['holdings']],
  ]) {
    const canAccessTab = createPredicate(WORKSPACE_TAB_META, isAnalyticsAdmin(session),
      canAccessAdminAuction(session), (callback) => callback);
    assert.deepEqual(['holdings', 'adminQuant', 'adminRadar', 'adminAuction'].filter(canAccessTab), expectedTabs);
  }
});

test('workspace uses one predicate for visibility, active tab, selection and auction rendering', () => {
  assert.match(workspaceSource, /import \{[^}]*\bcanAccessAdminAuction\b[^}]*\} from '\.\.\/app\/analytics\.js';/);
  assert.match(workspaceSource, /const isAdminUser = isAnalyticsAdmin\(cloudSession\);\s*const canAccessAuction = canAccessAdminAuction\(cloudSession\);/);
  assert.match(workspaceSource, /\.filter\(\(tab\) => canAccessTab\(tab\.key\)\)/);
  assert.match(workspaceSource, /if \(!isPublicShares && !canAccessTab\(activeTab\)\)/);
  assert.match(workspaceSource, /if \(!isPublicShares && !canAccessTab\(normalizedTab\)\)/);
  assert.match(workspaceSource, /case 'adminAuction':\s*return canAccessTab\('adminAuction'\) \? <AdminAuctionExperience/);
  assert.match(workspaceSource, /case 'adminQuant':\s*return isAdminUser \? <AdminQuantExperience/);
  assert.match(workspaceSource, /case 'adminRadar':\s*if \(window\.location\.hash === '#shares'\) return <SharesExperience \/>;\s*return isAdminUser \? <AdminRadarExperience/);
});

test('global search registers auction as an admin entry and accepts the separate permission', () => {
  assert.match(workspaceSource, /<GlobalSearch\b[\s\S]*?showAdminTabs=\{isAdminUser\}\s*showAuctionTab=\{canAccessAuction\}/);
  assert.match(searchSource, /showAuctionTab = false/);
  const entriesSource = searchSource.match(/const TAB_ENTRIES = (\[[\s\S]*?\n\]);/)[1];
  const entries = new Function('Wallet', 'BarChart3', 'Shuffle', 'Bell', 'Gavel', `return ${entriesSource};`)();
  const auction = entries.find((tab) => tab.key === 'adminAuction');
  assert.equal(auction?.label, '竞价看板');
  assert.equal(auction?.adminOnly, true);

  const resultsSource = searchSource.match(/ {2}const tabResults = useMemo\([\s\S]*?\n {2}\}, \[q, showAdminTabs, showAuctionTab\]\);/)[0];
  const getResults = new Function('TAB_ENTRIES', 'q', 'showAdminTabs', 'showAuctionTab', 'useMemo',
    `${resultsSource}\nreturn tabResults;`);
  const tabs = [...entries, { key: 'adminQuant', adminOnly: true }, { key: 'adminRadar', adminOnly: true }];
  const keys = (admin, auctionAccess, query = '') => getResults(tabs, query, admin, auctionAccess,
    (callback) => callback()).map((tab) => tab.key);
  const publicKeys = entries.filter((tab) => !tab.adminOnly).map((tab) => tab.key);
  assert.deepEqual(keys(false, false), publicKeys);
  assert.deepEqual(keys(false, true), [...publicKeys, 'adminAuction']);
  assert.deepEqual(keys(true, false), tabs.map((tab) => tab.key));
  assert.deepEqual(keys(false, false, '竞价'), []);
  assert.deepEqual(keys(false, true, '竞价'), ['adminAuction']);
});

test('mobile nav forwards auction permission on mount and updates with compatible config arguments', () => {
  assert.match(workspaceSource, /<MobileBottomNav\b[\s\S]*?isAdmin=\{isAdminUser\}\s*canAccessAuction=\{canAccessAuction\}/);
  assert.match(mobileSource, /canAccessAuction = false/);
  assert.equal([...mobileSource.matchAll(/splitMobileBottomNavItems\(visibleTabs, undefined, isAdmin, canAccessAuction\)/g)].length, 2);
  assert.match(mobileSource, /\[visibleTabs, isAdmin, canAccessAuction\]/);
  assert.match(mobileConfigSource, /export function splitMobileBottomNavItems\(\s*visibleTabs = null,\s*maxTabs = MOBILE_BOTTOM_NAV_MAX_TABS,\s*isAdmin = false,\s*canAccessAuction = false,/);
  assert.match(mobileConfigSource, /resolveMobileBottomNavItems\(visibleTabs, isAdmin, canAccessAuction\)/);
});
