import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath) => fs.readFileSync(path.resolve(testDir, '..', relativePath), 'utf8');
const radarSource = readSource('src/pages/AdminRadarExperience.jsx');
const panelSource = readSource('src/pages/radar/AuctionBoardPanel.jsx');

test('radar adds the auction tab after shares', () => {
  assert.match(radarSource, /\{ key: 'shares', label: '份额新增', href: '#shares' \},\s*\{ key: 'auction', label: '竞价看板', href: '#auction' \}/);
  assert.match(radarSource, /import AuctionBoardPanel from '\.\/radar\/AuctionBoardPanel\.jsx';/);
});

test('radar hash mapping handles auction and shares with radar as the fallback', () => {
  const mapping = radarSource.match(/function getRadarTabFromHash\(hash\) \{([\s\S]*?)\n\}/);
  assert.ok(mapping, 'radar defines one shared hash mapping function');
  const resolveHash = new Function('hash', mapping[1]);
  for (const [hash, expected] of [
    ['#auction', 'auction'],
    ['#shares', 'shares'],
    ['#radar', 'radar'],
    ['#unknown', 'radar'],
    ['', 'radar'],
    [undefined, 'radar']
  ]) {
    assert.equal(resolveHash(hash), expected, `hash=${hash}`);
  }
});

test('initial state and hashchange use the same radar hash mapping', () => {
  assert.match(radarSource, /useState\(\(\) => getRadarTabFromHash\(typeof window !== 'undefined' \? window\.location\.hash : ''\)\)/);
  assert.match(radarSource, /const syncHash = \(\) => setActiveTab\(getRadarTabFromHash\(window\.location\.hash\)\)/);
  assert.match(radarSource, /window\.addEventListener\('hashchange', syncHash\)/);
  assert.match(radarSource, /window\.removeEventListener\('hashchange', syncHash\)/);
});

test('auction panel has tab accessibility attributes and mounts only when selected', () => {
  assert.match(radarSource, /<div role="tabpanel" id="panel-auction" aria-labelledby="tab-auction" hidden=\{activeTab !== 'auction'\} tabIndex=\{0\} className="mt-4">\s*\{activeTab === 'auction' && <AuctionBoardPanel \/>\}\s*<\/div>/);
});

test('auction iframe embeds the static board eagerly with an accessible title', () => {
  assert.match(panelSource, /<section\b[^>]*aria-label="竞价看板"/);
  assert.match(panelSource, /<iframe\b[^>]*title="纳指期指与ETF竞价看板"[^>]*src="\/auction-board\.html"[^>]*loading="eager"/);
  assert.match(panelSource, /referrerPolicy="strict-origin-when-cross-origin"/);
});

test('auction panel matches the article iframe container and height classes', () => {
  const articlesSource = readSource('src/pages/ArticlesExperience.jsx');
  for (const element of ['section', 'iframe']) {
    const classPattern = new RegExp(`<${element}\\b[^>]*className="([^"]+)"`);
    const actual = panelSource.match(classPattern);
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

test('auction keeps the existing admin guard while shares remains public', () => {
  assert.match(radarSource, /activeTab !== 'shares' && !isAnalyticsAdmin\(session\)/);
  const condition = radarSource.match(/if \((.*?)\) \{\n {4}return <p/);
  assert.ok(condition);
  const denied = new Function('activeTab', 'session', 'isAnalyticsAdmin', `return ${condition[1]};`);
  for (const tab of ['radar', 'auction']) {
    assert.equal(denied(tab, null, () => false), true, `${tab} requires an admin`);
    assert.equal(denied(tab, {}, () => true), false, `${tab} allows admins`);
  }
  assert.equal(denied('shares', null, () => false), false);
});
