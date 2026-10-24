/* global Response */
// 纳指雷达演示 mock：命中、结构可通过前端校验、只读（计算 403）、无 mock 的 503 / 403 不回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ACCESS_TOKEN, DEMO_READONLY_CODE, createDemoFetch, demoFeatureFor, installFeatureDemo, loadDemoModule, readDemoSession } from '../src/app/demo/featureDemo.js';
import { RADAR_DEMO_ETFS, buildRadarDemoSnapshot } from '../src/app/demo/fixtures/adminRadar.js';
import { RADAR_FRESHNESS, RADAR_PREMIUM_SOURCE, candidatePair, percentileView, snapshotFreshness, validBestPair, validateRadarSnapshot } from '../src/app/radarModel.js';
import { createRadarClient, RADAR_GET_URLS, RADAR_COMPUTE_URL } from '../src/app/radarClient.js';
import { fetchWithFallback } from '../src/app/apiBase.js';

const CODES = ['513100', '159501', '159941', '159696', '159659', '159632', '513300', '513870', '513110', '159660', '513390', '159513'];

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

test('adminRadar demo is ready and lazily loads its fixtures module', async () => {
  assert.ok(demoFeatureFor('adminRadar'));
  const mod = await loadDemoModule('adminRadar');
  assert.equal(typeof mod.createFixtures, 'function');
  assert.deepEqual(mod.keepKeys, [], 'read-only demo keeps nothing');
  assert.equal(mod.seed, undefined);
  const { routes, getState } = mod.createFixtures({ state: null });
  assert.deepEqual(Object.keys(routes), ['GET /api/notify/nasdaq-radar'], 'only the radar GET is mocked; compute stays blocked');
  assert.equal(getState, undefined);
});

test('demo snapshot matches the worker shape with all 12 Nasdaq QDII ETFs and passes radar validation', () => {
  const now = Date.parse('2026-10-24T02:23:00.000Z'); // 周六 10:23 北京时间
  const data = buildRadarDemoSnapshot(now);
  assert.equal(validateRadarSnapshot(data), true);
  assert.equal(data.premiumSource, RADAR_PREMIUM_SOURCE);
  assert.equal(data.date, '2026-10-23', 'weekend → last trading day');
  assert.equal(snapshotFreshness(data, now).status, RADAR_FRESHNESS.OK);
  assert.deepEqual(data.etfs.map((e) => e.code).sort(), [...CODES].sort());
  assert.deepEqual(RADAR_DEMO_ETFS.map((e) => e.code).sort(), [...CODES].sort());
  for (const etf of data.etfs) {
    assert.ok(Number.isFinite(etf.premium) && etf.premium > 5 && etf.premium < 20, `${etf.code} ${etf.premium}`);
    assert.match(etf.name, /纳/);
  }
  const premiums = data.etfs.map((e) => e.premium);
  assert.deepEqual(premiums, [...premiums].sort((a, b) => b - a), 'sorted desc like the worker');
  const pair = validBestPair(data);
  assert.equal(pair.sell.code, data.etfs[0].code);
  assert.equal(pair.buy.code, data.etfs.at(-1).code);
  assert.deepEqual(candidatePair(data).sell.code, pair.sell.code);
  assert.ok(Math.abs(pair.spread - (pair.sell.premium - pair.buy.premium)) < 1e-6);
  assert.equal(pair.historyDays, 20);
  assert.equal(percentileView(data).visible, true);
  assert.ok(pair.percentile >= 0 && pair.percentile <= 100);
  assert.equal(data.recentOpportunities.length, 5);
  assert.equal(data.recentOpportunities[0].date, '2026-10-23');
  assert.equal(data.recentOpportunities[1].date, '2026-10-22');
  assert.match(data.recentOpportunities[0].pair, /^\d{6} → \d{6}$/);
  assert.equal(data.maturity.level, 3);
  assert.ok(data.maturity.enabledWeights.base.length > 0);
  assert.equal(Date.parse(data.computedAt), Date.parse('2026-10-23T13:36:08.000Z'));
  assert.deepEqual(buildRadarDemoSnapshot(now), data, 'deterministic for the same day');
  // 交易日 21:35 后预期当天快照；国庆后首个交易日向前跳过假期。
  assert.equal(buildRadarDemoSnapshot(Date.parse('2026-10-22T14:00:00.000Z')).date, '2026-10-22');
  const afterHoliday = buildRadarDemoSnapshot(Date.parse('2026-10-08T14:00:00.000Z'));
  assert.equal(afterHoliday.date, '2026-10-08');
  assert.equal(afterHoliday.recentOpportunities[1].date, '2026-09-30');
});

test('installed radar demo: the real radar client reads the mock (both hosts), compute is blocked read-only', async () => {
  const storage = new FakeStorage();
  const realCalls = [];
  const win = {
    fetch: async (input) => { realCalls.push(String(input)); return new Response('{"real":true}'); },
    localStorage: storage,
    location: { origin: 'https://fast.example' },
  };
  const blocked = [];
  const mod = await loadDemoModule('adminRadar');
  const env = installFeatureDemo('adminRadar', { win, module: mod, onBlocked: (key) => blocked.push(key) });
  const client = createRadarClient({
    getUrls: { primary: 'https://fast.example/api/notify/nasdaq-radar', fallback: 'https://api.freebacktrack.tech/api/notify/nasdaq-radar' },
    computeUrl: 'https://fast.example/api/notify/nasdaq-radar/compute',
    fetchImpl: (...args) => win.fetch(...args),
    fallbackFetchImpl: (urls, options) => win.fetch(urls.primary, options),
  });
  const read = await client.subscribe().promise;
  assert.equal(read.state, 'ready');
  assert.equal(read.data.etfs.length, 12);
  assert.equal(read.data.demo, true);
  const fallbackHost = await (await win.fetch('https://api.freebacktrack.tech/api/notify/nasdaq-radar')).json();
  assert.equal(fallbackHost.ok, true);
  const computed = await client.compute();
  assert.equal(computed.state, 'failure');
  assert.equal(computed.reason, 'http_error');
  assert.deepEqual(blocked, ['POST /api/notify/nasdaq-radar/compute']);
  assert.deepEqual(realCalls, [], 'nothing reaches the network');
  env.uninstall();
  assert.equal(readDemoSession('adminRadar', { storage }), null, 'read-only demo leaves nothing to keep');
  assert.ok(RADAR_GET_URLS.primary.endsWith('/api/notify/nasdaq-radar'));
  assert.ok(RADAR_COMPUTE_URL.endsWith('/api/notify/nasdaq-radar/compute'));
  assert.equal(typeof fetchWithFallback, 'function');
});

test('no regression: demo-token GET without a mock → 503, writes → 403; radar mock still wins', async () => {
  const mod = await loadDemoModule('adminRadar');
  let hits = 0;
  const f = createDemoFetch({ realFetch: async () => { hits += 1; return new Response('{}'); }, fixtures: mod.createFixtures({}).routes, origin: 'https://x.example' });
  const auth = { headers: { authorization: `Bearer ${DEMO_ACCESS_TOKEN}` } };
  assert.equal((await f('/api/notify/nasdaq-radar', auth)).status, 200);
  const missing = await f('/api/notify/nasdaq-radar/history', auth);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'DEMO_NO_FIXTURE');
  const write = await f('/api/notify/nasdaq-radar', { method: 'POST', ...auth });
  assert.equal(write.status, 403);
  assert.equal((await write.json()).code, DEMO_READONLY_CODE);
  assert.equal((await f('/api/notify/nasdaq-radar/compute', { method: 'POST' })).status, 403, 'compute blocked even without the demo token');
  assert.equal(hits, 0);
});
