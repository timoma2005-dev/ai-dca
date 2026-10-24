import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRadarTeaser, buildSwitchTeaser, handleDemoTeaserRoute, resetTeaserState, SWITCH_PAIRS_PER_DAY } from '../src/demo/teaser.js';

const sample = {
  date: '2026-10-23',
  computedAt: 'x',
  premiumSource: 'eastmoney-fundmobapi-nav',
  etfs: [
    { code: '159501', name: 'A', premium: 17.64 },
    { code: '513100', name: 'B', premium: 15.71 },
    { code: '159696', name: 'C', premium: 15.23 },
    { code: '159941', name: 'D', premium: 15.04 },
    { code: '159513', name: 'E', premium: 9.86 },
  ],
  bestPair: { sell: { code: '159501' }, buy: { code: '159513', name: 'E', premium: 9.86 }, spread: 7.78, percentile: 90, historyDays: 20 },
  recentOpportunities: [{ date: '2026-10-23', pair: '159501 → 159513', spread: 7.78 }],
};

test('radar teaser exposes only top 3 and never the buy side or pairs', () => {
  const t = buildRadarTeaser(sample);
  assert.equal(t.top.length, 3);
  assert.equal(t.hiddenCount, 2);
  assert.equal(t.bestPair.sell.code, '159501');
  assert.equal(t.bestPair.per100k, 7780);
  const json = JSON.stringify({ ...t, codes: [], names: {} });
  assert.ok(!json.includes('159513'), 'buy side must not leak');
  assert.ok(!json.includes('9.86'), 'hidden premiums must not leak');
  assert.ok(!('pair' in t.recent[0]));
});

test('switch teaser returns only the chosen pair', () => {
  const t = buildSwitchTeaser(sample, '513100', '159941');
  assert.equal(t.spread, 0.67);
  assert.equal(t.triggered, false);
  assert.equal(t.gapToBest, 7.11);
  assert.equal(buildSwitchTeaser(sample, '513100', '513100'), null);
});

test('route caches upstream and limits switch pairs per IP per day', async () => {
  resetTeaserState();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ ok: true, data: sample })); };
  const headers = { 'x-real-ip': '1.2.3.4' };
  const r = await handleDemoTeaserRoute('GET', new URL('http://x/api/notify/demo-teaser/radar'), headers, { fetchImpl });
  assert.equal(r.body.ok, true);
  const codes = ['513100', '159696', '159941', '159513'];
  for (let i = 0; i < SWITCH_PAIRS_PER_DAY; i += 1) {
    const res = await handleDemoTeaserRoute('GET', new URL(`http://x/api/notify/demo-teaser/switch?sell=159501&buy=${codes[i]}`), headers, { fetchImpl });
    assert.equal(res.body.ok, true);
  }
  const again = await handleDemoTeaserRoute('GET', new URL('http://x/api/notify/demo-teaser/switch?sell=159501&buy=513100'), headers, { fetchImpl });
  assert.equal(again.body.ok, true, 'repeating a used pair does not consume quota');
  const over = await handleDemoTeaserRoute('GET', new URL('http://x/api/notify/demo-teaser/switch?sell=159501&buy=159513'), headers, { fetchImpl });
  assert.equal(over.status, 429);
  assert.equal(calls, 1);
  assert.equal(await handleDemoTeaserRoute('GET', new URL('http://x/api/notify/switch/config'), headers, { fetchImpl }), null);
});
