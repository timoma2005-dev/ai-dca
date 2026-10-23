import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_TAB_ORDER, PRIMARY_TAB_META, createPageLinks, getAdminTabs, isWorkspaceGroup } from '../src/app/screens.js';
import { SCENARIOS } from '../src/app/scenarios.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath) => fs.readFileSync(path.resolve(testDir, '..', relativePath), 'utf8');
const radarSource = readSource('src/pages/AdminRadarExperience.jsx');
const auctionSource = readSource('src/pages/AdminAuctionExperience.jsx');
const workspaceSource = readSource('src/pages/WorkspacePage.jsx');

test('auction is a top-level admin tab immediately after radar', () => {
  assert.deepEqual(ADMIN_TAB_ORDER, ['adminQuant', 'adminRadar', 'adminAuction']);
  assert.deepEqual(PRIMARY_TAB_META.adminAuction, { label: '竞价看板', hrefKey: 'adminAuction', adminOnly: true });
  assert.equal(isWorkspaceGroup('adminAuction'), true);
  assert.deepEqual(SCENARIOS.stock.visibleTabs.slice(-3), ADMIN_TAB_ORDER);
});

test('auction links point to the workspace in both page directories', () => {
  for (const [inPagesDir, href] of [[false, './home.html?tab=adminAuction'], [true, '../home.html?tab=adminAuction']]) {
    const links = createPageLinks({ inPagesDir });
    assert.equal(links.adminAuction, href);
    assert.deepEqual(getAdminTabs(links).at(-1), { key: 'adminAuction', label: '竞价看板', href });
  }
});

test('workspace registers the auction title, Gavel icon and lazy admin panel', () => {
  assert.match(workspaceSource, /const WORKSPACE_TITLES = \{[^}]*adminAuction: '竞价看板'/);
  assert.match(workspaceSource, /import \{[^}]*\bGavel\b[^}]*\} from 'lucide-react';/);
  assert.match(workspaceSource, /const SIDEBAR_ICONS = \{[^}]*adminAuction: Gavel/);
  assert.match(workspaceSource, /const AdminAuctionExperience = lazy\(\(\) => import\('\.\/AdminAuctionExperience\.jsx'\)\);/);
  assert.match(workspaceSource, /case 'adminAuction':\s*return canAccessTab\('adminAuction'\) \? <AdminAuctionExperience \{\.\.\.sharedProps\} \/> : <HoldingsExperience \{\.\.\.sharedProps\} \/>;/);
});

test('legacy radar shares hash renders SharesExperience before the admin radar guard', () => {
  assert.match(workspaceSource, /case 'adminRadar':\s*if \(window\.location\.hash === '#shares'\) return <SharesExperience \/>;\s*return isAdminUser \? <AdminRadarExperience \{\.\.\.sharedProps\} \/> : <HoldingsExperience \{\.\.\.sharedProps\} \/>;/);
});

test('radar is a single admin panel without shares, auction or hash tabs', () => {
  assert.doesNotMatch(radarSource, /份额新增|SharesExperience|PageTabs|AuctionBoardPanel|竞价看板|getRadarTabFromHash|hashchange|activeTab|useState|useEffect/);
  assert.match(radarSource, /import \{ isAnalyticsAdmin \} from '\.\.\/app\/analytics\.js';/);
  assert.match(radarSource, /if \(!isAnalyticsAdmin\(session\)\) \{\s*return <p[^>]*>当前账号没有权限。请使用 lovexl 登录后访问。<\/p>;/);
  assert.match(radarSource, /<div className="mx-auto max-w-6xl min-w-0 p-4">\s*<RadarPanel session=\{session\} \/>\s*<\/div>/);
  assert.equal(fs.existsSync(path.resolve(testDir, '../src/pages/radar/AuctionBoardPanel.jsx')), false);
});

test('auction iframe embeds the static board eagerly with an accessible title', () => {
  assert.match(auctionSource, /export default function AdminAuctionExperience\(\)/);
  assert.match(auctionSource, /<section\b[^>]*aria-label="竞价看板"/);
  assert.match(auctionSource, /<iframe\b[^>]*title="纳指期指与ETF竞价看板"[^>]*src="\/auction-board\.html"[^>]*loading="eager"/);
  assert.match(auctionSource, /referrerPolicy="strict-origin-when-cross-origin"/);
});

test('auction panel matches the article iframe container and height classes', () => {
  const articlesSource = readSource('src/pages/ArticlesExperience.jsx');
  for (const element of ['section', 'iframe']) {
    const classPattern = new RegExp(`<${element}\\b[^>]*className="([^"]+)"`);
    const actual = auctionSource.match(classPattern);
    const expected = articlesSource.match(classPattern);
    assert.ok(actual);
    assert.ok(expected);
    assert.equal(actual[1], expected[1], `${element} classes match ArticlesExperience`);
  }
});

test('public auction board exists with the supplied title', () => {
  const htmlPath = path.resolve(testDir, '../public/auction-board.html');
  assert.equal(fs.existsSync(htmlPath), true);
  assert.match(fs.readFileSync(htmlPath, 'utf8'), /<title>纳指期指与ETF竞价看板<\/title>/);
});
