/* global URL */
// 演示限制方式（limit）：time 限时 + 计次、count 只渲染可见条数（其余占位遮罩）、save 不计时并提示演示数据去留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { rolldown } from 'rolldown';
import {
  DEMO_FEATURES, DEMO_LIMITS, DEMO_RUNS_PER_DAY, consumeDemoQuota, demoBannerNote, demoLimitOf, demoQuotaFor,
} from '../src/app/demo/featureDemo.js';
import { buildRadarDemoSnapshot } from '../src/app/demo/fixtures/adminRadar.js';
import { rankRadarEtfs, validBestPair } from '../src/app/radarModel.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromRoot = createRequire(join(root, 'package.json'));
const abs = (rel) => JSON.stringify(join(root, rel));

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const EXPECTED = {
  markets: 'time', adminAuction: 'time',
  adminRadar: 'count',
  holdings: 'save', tradePlans: 'save', fundSwitch: 'save', notify: 'save', dataRepair: 'save',
};

test('every demo feature declares a limit type; time ones run 3 minutes, others are untimed', () => {
  for (const [tab, feature] of Object.entries(DEMO_FEATURES)) {
    assert.ok(Object.values(DEMO_LIMITS).includes(feature.limit), `${tab} limit`);
    assert.equal(feature.limit, EXPECTED[tab], tab);
    const info = demoLimitOf(tab);
    assert.equal(info.timed, feature.limit === 'time', tab);
    if (info.timed) assert.equal(info.durationSec, 180, tab);
    else assert.equal(info.durationSec, null, `${tab} has no countdown`);
  }
  assert.equal(demoLimitOf('adminRadar').visibleRows, 3);
  assert.equal(demoLimitOf('markets').visibleRows, Infinity);
  assert.deepEqual(Object.keys(DEMO_FEATURES).filter((t) => DEMO_FEATURES[t].keeps).sort(), ['fundSwitch', 'holdings', 'markets', 'tradePlans']);
});

test('quota: only time demos are counted per day; count / save demos are unlimited and never write the quota', () => {
  const storage = new FakeStorage();
  const now = Date.parse('2026-10-24T10:00:00+08:00');
  for (const tab of ['adminRadar', 'holdings', 'notify', 'dataRepair']) {
    const q = demoQuotaFor(tab, { storage, now });
    assert.equal(q.unlimited, true, tab);
    assert.equal(q.remaining, Infinity, tab);
    for (let i = 0; i < DEMO_RUNS_PER_DAY + 2; i += 1) assert.equal(consumeDemoQuota(tab, { storage, now }), true, tab);
  }
  assert.equal(storage.getItem('aiDcaFeatureDemoQuota'), null);
  for (let i = 0; i < DEMO_RUNS_PER_DAY; i += 1) assert.equal(consumeDemoQuota('adminAuction', { storage, now }), true);
  assert.equal(consumeDemoQuota('adminAuction', { storage, now }), false);
  assert.equal(demoQuotaFor('adminAuction', { storage, now }).remaining, 0);
  assert.ok(!demoQuotaFor('adminAuction', { storage, now }).unlimited);
});

test('banner note per limit type', () => {
  assert.equal(demoBannerNote('holdings', { guest: true }), '演示数据，结束演示后删除；注册后可保留你新增的内容');
  assert.equal(demoBannerNote('tradePlans', { guest: false }), '演示数据，结束演示后删除；升级后可保留你新增的内容');
  assert.equal(demoBannerNote('notify', { guest: true }), '演示数据，结束演示后删除');
  assert.equal(demoBannerNote('dataRepair', { guest: false }), '演示数据，结束演示后删除');
  assert.match(demoBannerNote('adminRadar', { guest: false, roleLabel: 'SVIP' }), /部分数据.*升级 SVIP/);
  assert.equal(demoBannerNote('adminAuction'), '模拟数据，到时自动结束演示');
  assert.match(demoBannerNote('markets', { guest: true }), /保留 15 分钟/);
});

test('countdown effect is gated to time demos in the FeatureDemo source', () => {
  const src = readFileSync(new URL('../src/components/rbac/feature-demo.jsx', import.meta.url), 'utf8');
  assert.match(src, /if \(!limitInfo\.timed \|\| !ready \|\| ended\) return undefined;/);
  assert.match(src, /data-testid="feature-demo-exit"[\s\S]{0,40}结束演示|结束演示[\s\S]{0,10}<\/button>/);
});

// ---- 渲染：真实组件打包后 SSR ----
const entrySource = `
import { createElement as h } from ${JSON.stringify(requireFromRoot.resolve('react'))};
import { renderToStaticMarkup } from ${JSON.stringify(requireFromRoot.resolve('react-dom/server'))};
import { FeatureDemo } from ${abs('src/components/rbac/feature-demo.jsx')};
import { FeatureDemoContext } from ${abs('src/components/rbac/demo-lock.jsx')};
import { AccessGuardPage } from ${abs('src/components/rbac/access-guard-page.jsx')};
import RadarRanking from ${abs('src/pages/radar/RadarRanking.jsx')};
import RadarOpportunityCards from ${abs('src/pages/radar/RadarOpportunityCards.jsx')};
import RadarSidebar from ${abs('src/pages/radar/RadarSidebar.jsx')};
const map = { FeatureDemo, AccessGuardPage, RadarRanking, RadarOpportunityCards, RadarSidebar };
export function render(name, props, demo = null) {
  const el = h(map[name], props);
  return renderToStaticMarkup(demo ? h(FeatureDemoContext.Provider, { value: demo }, el) : el);
}
`;

async function loadBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'demo-limits-'));
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
  // featureDemo.js 动态 import fixtures 会拆出多个 chunk，全部写盘。
  for (const chunk of output) writeFileSync(join(dir, chunk.fileName), chunk.type === 'chunk' ? chunk.code : chunk.source);
  const file = join(dir, output[0].fileName);
  const mod = await import(pathToFileURL(file).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const { mod, cleanup } = await loadBundle();
test.after(cleanup);

const NOW = Date.parse('2026-10-24T10:23:00+08:00');
const DATA = buildRadarDemoSnapshot(NOW);
const RANKED = rankRadarEtfs(DATA);
const COUNT_DEMO = { tab: 'adminRadar', limit: 'count', visibleRows: 3, guest: true, roleLabel: 'SVIP', onUpgrade() {} };

test('radar ranking in a count demo renders only the first 3 ETFs; the rest are placeholder rows behind a CTA overlay', () => {
  const html = mod.render('RadarRanking', { data: DATA, selectedCode: null }, COUNT_DEMO);
  for (const etf of RANKED.slice(0, 3)) assert.ok(html.includes(etf.code), `visible ${etf.code}`);
  for (const etf of RANKED.slice(3)) {
    assert.ok(!html.includes(etf.code), `hidden code ${etf.code} not in DOM`);
    assert.ok(!html.includes(`${etf.premium.toFixed(2)}%`) || RANKED.slice(0, 3).some((v) => v.premium === etf.premium), `hidden premium ${etf.code}`);
  }
  assert.equal((html.match(/aria-pressed=/g) || []).length, 3, 'only 3 real rows');
  assert.match(html, new RegExp(`data-locked-count="${RANKED.length - 3}"`));
  assert.match(html, /注册\/升级 S?VIP 查看全部/);
  assert.match(html, /注册查看全部/);
  // 未在演示中：全部渲染、无遮罩
  const full = mod.render('RadarRanking', { data: DATA, selectedCode: null });
  for (const etf of RANKED) assert.ok(full.includes(etf.code));
  assert.doesNotMatch(full, /demo-lock/);
});

test('radar rotation advice hides the off-screen lowest ETF and the spread in a count demo', () => {
  const sel = RANKED[0].code;
  const lowest = RANKED.at(-1);
  const html = mod.render('RadarRanking', { data: DATA, selectedCode: sel }, { ...COUNT_DEMO, guest: false });
  assert.ok(!html.includes(lowest.code));
  assert.match(html, /--\.--/);
  assert.match(html, /升级 SVIP 查看全部/);
});

test('best pair shows only the sell half in a count demo; recent opportunities are masked', () => {
  const pair = validBestPair(DATA);
  const html = mod.render('RadarOpportunityCards', { data: DATA }, COUNT_DEMO);
  assert.ok(html.includes(pair.sell.code));
  assert.ok(!html.includes(pair.buy.code), 'buy side code not in DOM');
  assert.ok(!html.includes(pair.buy.name));
  assert.ok(!html.includes(`${pair.spread.toFixed(2)}%`), 'spread not in DOM');
  assert.match(html, /data-testid="demo-locked-value"/);
  const side = mod.render('RadarSidebar', { data: DATA, receivedAt: NOW, session: { label: '盘中' }, clockNow: NOW, computeState: 'idle', showPipeline: false }, COUNT_DEMO);
  for (const item of DATA.recentOpportunities) assert.ok(!side.includes(item.pair), `recent ${item.pair} masked`);
  assert.match(side, /data-locked-count="5"/);
});

test('FeatureDemo banner: time shows a countdown; count / save show no timer and the right note plus an explicit 结束演示 button', () => {
  const time = mod.render('FeatureDemo', { tab: 'adminAuction', guest: true, onUpgrade() {} });
  assert.match(time, /data-demo-limit="time"/);
  assert.match(time, /剩余 03:00/);
  const save = mod.render('FeatureDemo', { tab: 'holdings', guest: true, onUpgrade() {} });
  assert.match(save, /data-demo-limit="save"/);
  assert.doesNotMatch(save, /剩余/);
  assert.match(save, /演示数据，结束演示后删除；注册后可保留你新增的内容/);
  assert.match(save, /data-testid="feature-demo-exit"[^>]*>结束演示</);
  const repair = mod.render('FeatureDemo', { tab: 'dataRepair', guest: false, onUpgrade() {} });
  assert.match(repair, /演示数据，结束演示后删除</);
  const count = mod.render('FeatureDemo', { tab: 'adminRadar', guest: false, roleLabel: 'SVIP', onUpgrade() {} });
  assert.match(count, /部分数据/);
  assert.doesNotMatch(count, /剩余/);
});

test('guard page: button reads 体验一下; unlimited demos hide the daily count, time demos keep it', () => {
  const unlimited = mod.render('AccessGuardPage', { status: 'login', requiredRole: { code: 'vip', name: 'VIP' }, demo: { ...demoQuotaFor('holdings', { storage: new FakeStorage() }), points: ['a'] }, onDemo() {}, autoPromptLogin: false });
  assert.match(unlimited, /体验一下/);
  assert.doesNotMatch(unlimited, /今日还可体验|次数已用完/);
  assert.doesNotMatch(unlimited, /disabled=""/);
  const paid = mod.render('AccessGuardPage', { status: 'forbidden', requiredRole: { code: 'svip', name: 'SVIP' }, demo: { ...demoQuotaFor('adminRadar', { storage: new FakeStorage() }) }, onDemo() {}, onUpgrade() {} });
  assert.doesNotMatch(paid, /今日还可体验/);
  assert.match(paid, /开通后刷新页面即可使用/);
  const timed = mod.render('AccessGuardPage', { status: 'login', requiredRole: { code: 'vip', name: 'VIP' }, demo: { ...demoQuotaFor('markets', { storage: new FakeStorage() }) }, onDemo() {}, autoPromptLogin: false });
  assert.match(timed, /体验一下/);
  assert.match(timed, /今日还可体验 3 次/);
});
