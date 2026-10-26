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
  assert.equal(calls, 2, 'radar + features fetched once');
  assert.equal(await handleDemoTeaserRoute('GET', new URL('http://x/api/notify/switch/config'), headers, { fetchImpl }), null);
});

test('pair backtest rotates on threshold and only returns totals', async () => {
  const { backtestPair } = await import('../src/demo/teaser.js');
  const h = [
    { date: '2026-10-01', premiums: { A: 10, B: 8 } },
    { date: '2026-10-02', premiums: { A: 9, B: 9.5 } },
    { date: '2026-10-03', premiums: { A: 8, B: 10 } },
    { date: '2026-10-04', premiums: { A: 8, B: 8.5 } },
    { date: '2026-10-05', premiums: { A: 7, B: 9 } },
  ];
  const r = backtestPair(h, 'A', 'B');
  assert.equal(r.switches, 2);
  // 10/1 A→B ×1.10/1.08，10/3 B→A ×1.10/1.08，期末持有 A：相对一直拿 A 为 (1.10/1.08)^2 - 1
  assert.equal(r.gainPct, +(((1.1 / 1.08) ** 2 - 1) * 100).toFixed(2));
  assert.deepEqual(Object.keys(r).sort(), ['days', 'from', 'gainPct', 'per100k', 'switches', 'to']);
  assert.equal(backtestPair(h.slice(0, 3), 'A', 'B'), null);
});

test('雷达预告：评分与正式同源，隐藏行只给份额状态，买入方不在前 3 时不下发', () => {
  const q = (state) => ({ state, label: state, limitShares: 1e6 });
  const etfs = {
    A: { code: 'A', name: 'A基金', premium: 15, sellScore: 80, buyScore: 20, quota: q('steady') },
    B: { code: 'B', name: 'B基金', premium: 14, sellScore: 70, buyScore: 30, quota: q('steady') },
    C: { code: 'C', name: 'C基金', premium: 13, sellScore: 60, buyScore: 40, quota: q('steady') },
    D: { code: 'D', name: 'D基金', premium: 10, sellScore: 20, buyScore: 85, quota: q('tight') },
  };
  const data = {
    etfs: Object.values(etfs).map(({ code, name, premium }) => ({ code, name, premium })),
    bestPair: { spread: 5 },
    scoring: { version: 2, date: '2026-10-23', quotaDate: '2026-10-26', etfs, recommendedPair: { sell: { code: 'A', name: 'A基金', premium: 15 }, buy: { code: 'D', name: 'D基金', premium: 10 }, score: 88, netSpread: 4.9, buyScore: 85, reasons: ['A基金 溢价处于自身高位', 'D基金 额度刚收紧，溢价易升'] }, blockedPairs: [{}] },
    series: { dates: ['2026-10-23'], etfs: { A: { limit: [1e6], premium: [15] }, D: { limit: [5e6] } } },
  };
  const t = buildRadarTeaser(data);
  assert.equal(t.scoring.quotaDate, '2026-10-26');
  assert.equal(t.scoring.etfs.A.sellScore, 80);
  assert.deepEqual(Object.keys(t.scoring.etfs.D).sort(), ['code', 'hidden', 'name', 'quota']);
  assert.equal(t.scoring.etfs.D.quota.state, 'tight');
  assert.equal(t.scoring.recommendedPair.buy, null);
  assert.equal(t.scoring.recommendedPair.buyScore, null);
  assert.deepEqual(t.scoring.recommendedPair.reasons, ['A基金 溢价处于自身高位']);
  assert.deepEqual(t.scoring.blockedPairs, []);
  assert.deepEqual(Object.keys(t.series.etfs), ['A']);
  assert.equal(t.series.etfs.A.premium, undefined);
});
