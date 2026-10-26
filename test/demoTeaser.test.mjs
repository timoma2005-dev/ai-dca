import test from 'node:test';
import assert from 'node:assert/strict';
import fixture, { buildRadarTeaserSnapshot } from '../src/app/demo/fixtures/adminRadar.js';
import { createDemoFetch } from '../src/app/demo/featureDemo.js';
import { candidatePair, rankRadarEtfs, validBestPair, validateRadarSnapshot } from '../src/app/radarModel.js';

const teaser = {
  date: '2026-10-23',
  computedAt: 'x',
  premiumSource: 'eastmoney-fundmobapi-nav',
  total: 12,
  top: [
    { code: '159501', name: '纳指ETF嘉实', premium: 17.64 },
    { code: '513100', name: '纳指ETF国泰', premium: 15.71 },
    { code: '159696', name: '纳指ETF易方达', premium: 15.23 },
  ],
  hiddenCount: 9,
  bestPair: { sell: { code: '159501', name: '纳指ETF嘉实', premium: 17.64 }, spread: 7.78, percentile: 95, historyDays: 20, per100k: 7780 },
  recent: [{ date: '2026-10-23', spread: 7.78 }, { date: '2026-10-22', spread: 6.06 }],
};

test('radar teaser snapshot keeps real top 3 and masks the buy side', () => {
  const snap = buildRadarTeaserSnapshot(teaser);
  assert.ok(validateRadarSnapshot(snap));
  const ranked = rankRadarEtfs(snap);
  assert.equal(ranked.length, 12);
  assert.deepEqual(ranked.slice(0, 3).map((e) => e.code), ['159501', '513100', '159696']);
  const pair = validBestPair(snap);
  assert.equal(pair.sell.code, '159501');
  assert.equal(pair.spread, 7.78);
  assert.ok(pair.buy.code.startsWith('demo-hidden-'));
  assert.equal(candidatePair(snap).buy.code, pair.buy.code);
  assert.ok(snap.recentOpportunities.every((r) => r.pair === '升级查看'));
  assert.equal(buildRadarTeaserSnapshot(null), null);
});

test('radar demo route reads the teaser through the real fetch and falls back to synthetic', async () => {
  const calls = [];
  const realFetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, data: teaser }), { headers: { 'content-type': 'application/json' } });
  };
  const { routes } = fixture.createFixtures({});
  const demoFetch = createDemoFetch({ realFetch, fixtures: routes, origin: 'http://localhost' });
  const res = await demoFetch('http://localhost/api/notify/nasdaq-radar');
  const json = await res.json();
  assert.equal(json.data.teaser, true);
  assert.deepEqual(calls, ['/api/notify/demo-teaser/radar']);

  const failing = fixture.createFixtures({}).routes;
  const fallbackFetch = createDemoFetch({ realFetch: async () => new Response('{}', { status: 503 }), fixtures: failing, origin: 'http://localhost' });
  const fb = await (await fallbackFetch('http://localhost/api/notify/nasdaq-radar')).json();
  assert.equal(fb.data.demo, true);
  assert.notEqual(fb.data.teaser, true);
});

test('雷达演示预告：评分用服务端下发的正式 scoring，买入方遮罩；无 scoring 时不展示合成评分', async () => {

  const base = { date: '2026-10-23', top: [{ code: '159501', name: '嘉实', premium: 17.64 }, { code: '513100', name: '国泰', premium: 15.71 }, { code: '159696', name: '易方达', premium: 15.23 }], hiddenCount: 9, bestPair: { spread: 7.78 }, recent: [] };
  const plain = buildRadarTeaserSnapshot(base);
  assert.equal(plain.scoring, null);
  const scoring = { version: 2, date: '2026-10-23', quotaDate: '2026-10-26', etfs: { 159501: { code: '159501', name: '嘉实', premium: 17.64, sellScore: 77, buyScore: 26, quota: { state: 'steady' } }, 513300: { code: '513300', name: '华夏', quota: { state: 'tight' }, hidden: true } }, recommendedPair: { sell: { code: '159501', name: '嘉实', premium: 17.64 }, buy: null, score: 87, netSpread: 7.71 } };
  const snap = buildRadarTeaserSnapshot({ ...base, scoring });
  assert.equal(snap.scoring.recommendedPair.score, 87);
  assert.match(snap.scoring.recommendedPair.buy.code, /^demo-hidden-/);
  assert.equal(snap.scoring.etfs['513300'].quota.state, 'tight');
});
