import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basePrice, closeAdvice, defaultBuyShares, deviationBars, minuteLabel, priceAt, rotationPortfolio, shanghaiTs, shortName, switchPnlSeries, tradingMinute
} from '../src/pages/rotator/rotatorCharts.js';

test('shortName strips index/ETF words', () => {
  assert.equal(shortName('纳指ETF华安'), '华安');
  assert.equal(shortName('纳100ETF招商'), '招商');
  assert.equal(shortName('', '159632'), '159632');
});

test('basePrice is consistent with dev_bps', () => {
  const row = { price: 1.522, iopv: 1.3006, prem_bps: 1702.8, base_bps: 1672.4 };
  const bp = basePrice(row);
  const dev = (row.prem_bps - row.base_bps) / (1 + row.base_bps / 1e4);
  assert.ok(Math.abs((row.iopv * (1 + row.prem_bps / 1e4)) / bp - 1 - dev / 1e4) < 1e-9);
  assert.equal(basePrice({ iopv: 1, base_bps: null }), null);
});

test('deviationBars sorts cheap first and skips missing dev', () => {
  const bars = deviationBars([{ code: 'a', dev_bps: 26 }, { code: 'b', dev_bps: -31 }, { code: 'c', dev_bps: null }]);
  assert.deepEqual(bars.map((b) => b.code), ['b', 'a']);
  assert.equal(bars[0].ratio, 1);
});

test('trading minute axis compresses lunch', () => {
  assert.equal(tradingMinute(shanghaiTs('2026-11-26', '09:30')), 0);
  assert.equal(tradingMinute(shanghaiTs('2026-11-26', '11:30')), 120);
  assert.equal(tradingMinute(shanghaiTs('2026-11-26', '12:10')), 120);
  assert.equal(tradingMinute(shanghaiTs('2026-11-26', '13:30')), 150);
  assert.equal(tradingMinute(shanghaiTs('2026-11-26', '15:00')), 240);
  assert.equal(minuteLabel(150), '13:30');
  assert.equal(minuteLabel(57), '10:27');
});

test('defaultBuyShares rounds down to 100', () => {
  assert.equal(defaultBuyShares(52000, 2.272, 2.216), 53300);
  assert.equal(defaultBuyShares('', 1, 1), 0);
});

test('switchPnlSeries: value vs holding A, forward filled', () => {
  const t0 = shanghaiTs('2026-11-26', '10:47:00');
  const seriesA = [[t0 - 5, 2.0], [t0 + 10, 2.02]];
  const seriesB = [[t0, 1.0], [t0 + 5, 1.01]];
  const r = switchPnlSeries({ seriesA, seriesB, switchTs: t0, sellPx: 2.0, sellShares: 1000, buyPx: 1.0, buyShares: 2000 });
  assert.deepEqual(r.points.map((p) => p.v), [0, 20, 0]);
  assert.equal(r.min.v, 0);
  assert.equal(r.max.v, 20);
  assert.equal(r.last.v, 0);
  const fee = switchPnlSeries({ seriesA, seriesB, switchTs: t0, sellPx: 2.0, sellShares: 1000, buyPx: 1.0, buyShares: 2000, commBps: 0.5 });
  assert.equal(fee.points[0].v, -0.2);
  assert.equal(switchPnlSeries({ seriesA, seriesB, switchTs: t0, sellPx: 0, sellShares: 1, buyPx: 1, buyShares: 1 }), null);
});

test('rotationPortfolio: two switches vs holding the start fund', () => {
  const S = {
    A: [[100, 1.0], [200, 1.0], [300, 1.1]],
    B: [[100, 2.0], [200, 2.1], [300, 2.0]],
    C: [[100, 1.0], [200, 1.0], [300, 1.2]]
  };
  const r = rotationPortfolio({
    seriesByCode: S, startCode: 'A', startShares: 1000,
    switches: [{ ts: 200, buyCode: 'C', buyPx: 1.0 }, { ts: 100, buyCode: 'B', sellPx: 1.0, buyPx: 2.0 }]
  });
  assert.equal(r.legs.length, 2);
  assert.deepEqual(r.legs.map((l) => [l.from, l.to, l.sellShares, l.buyShares]), [['A', 'B', 1000, 500], ['B', 'C', 500, 1000]]);
  assert.equal(r.legs[1].sellPx, 2.1);
  // 第二次卖 B 得 1050，买 C 1000 份花 1000，余 50
  assert.deepEqual(r.points.map((p) => [p.mine, p.base]), [[0, 0], [50, 0], [250, 100]]);
  assert.deepEqual(r.last.up, [100, 250]);
  assert.equal(r.legs[1].single.last.v, 1000 * 1.2 + 50 - 500 * 2.0);
});

test('rotationPortfolio: rejects buying the fund already held', () => {
  const r = rotationPortfolio({ seriesByCode: { A: [[1, 1]] }, startCode: 'A', startShares: 100, switches: [{ ts: 1, buyCode: 'A' }] });
  assert.match(r.error, /不能和当前持仓相同/);
});

test('priceAt forward-fills and tolerates a slightly early time', () => {
  const s = [[1000, 1.5], [1005, 1.6]];
  assert.equal(priceAt(s, 1003), 1.5);
  assert.equal(priceAt(s, 2000), 1.6);
  assert.equal(priceAt(s, 900), 1.5);
  assert.equal(priceAt(s, 500), null);
});

test('planImport: summary screenshot without times → chained switches with estimated times', async () => {
  const { planImport } = await import('../src/pages/rotator/tradeImport.js');
  const t = (hm) => shanghaiTs('2026-11-26', hm);
  const flat = (px) => [[t('09:30'), px], [t('15:00'), px]];
  const seriesByCode = {
    A: [[t('09:30'), 1.50], [t('10:30'), 1.521], [t('15:00'), 1.53]],
    B: [[t('09:30'), 2.25], [t('10:30'), 2.274], [t('11:00'), 2.293], [t('15:00'), 2.30]],
    C: [[t('09:30'), 2.20], [t('11:00'), 2.218], [t('15:00'), 2.23]],
    D: flat(3.0)
  };
  const pool = ['A', 'B', 'C', 'D'].map((code) => ({ code, name: `纳指ETF${code}` }));
  const rows = [
    { code: '纳指', type: '买入', price: 2.218, shares: 77500, amount: 171926.8 },
    { code: '纳斯达克', type: '卖出', price: 2.293, shares: 75000, amount: 171975 },
    { code: '纳斯达克', type: '买入', price: 2.274, shares: 75000, amount: 170550 },
    { code: '纳指ETF', type: '卖出', price: 1.521, shares: 112100, amount: 170504.1 }
  ];
  const r = planImport({ rows, pool, seriesByCode });
  assert.equal(r.startCode, 'A');
  assert.equal(r.startShares, 112100);
  assert.deepEqual(r.switches.map((s) => [s.buyCode, s.est]), [['B', true], ['C', true]]);
  assert.ok(r.switches[0].time < r.switches[1].time);
  const fixed = planImport({ rows, pool, seriesByCode, fixed: { 纳指: 'D' } });
  assert.equal(fixed.switches[1].buyCode, 'D');
  assert.ok(fixed.warnings.length > 0);
});

test('planImport: timed fills are merged and paired in order', async () => {
  const { planImport } = await import('../src/pages/rotator/tradeImport.js');
  const t = (hm) => shanghaiTs('2026-11-26', hm);
  const seriesByCode = { A: [[t('09:30'), 1.5], [t('15:00'), 1.5]], B: [[t('09:30'), 2.0], [t('15:00'), 2.0]] };
  const pool = [{ code: 'A', name: 'A' }, { code: 'B', name: 'B' }];
  const rows = [
    { date: '2026-11-26 10:31:05', code: 'x', type: '卖出', price: 1.5, shares: 1000, amount: 1500 },
    { date: '2026-11-26 10:31:09', code: 'x', type: '卖出', price: 1.5, shares: 1000, amount: 1500 },
    { date: '2026-11-26 10:31:20', code: 'y', type: '买入', price: 2.0, shares: 1500, amount: 3000 }
  ];
  const r = planImport({ rows, pool, seriesByCode });
  assert.equal(r.day, '2026-11-26');
  assert.equal(r.startShares, 2000);
  assert.deepEqual(r.switches, [{ time: '10:31:05', est: false, buyCode: 'B', sellPx: 1.5, buyPx: 2.0, buyShares: 1500 }]);
});

test('emptyHint: market-closed messages by Shanghai time', async () => {
  const { emptyHint } = await import('../src/pages/rotator/rotatorCharts.js');
  const at = (s) => Date.parse(`${s}+08:00`);
  assert.equal(emptyHint(at('2026-11-27T08:46:00'))[0], '还没开盘');
  assert.equal(emptyHint(at('2026-11-27T12:00:00'))[0], '午休中');
  assert.equal(emptyHint(at('2026-11-27T15:30:00'))[0], '今天已收盘');
  assert.equal(emptyHint(at('2026-11-28T10:00:00'))[0], '今天休市');
});

test('inLunch / shanghaiDay', async () => {
  const { inLunch, shanghaiDay } = await import('../src/pages/rotator/rotatorCharts.js');
  const at = (s) => Date.parse(`${s}+08:00`);
  assert.equal(inLunch(at('2026-11-27T12:10:00')), true);
  assert.equal(inLunch(at('2026-11-27T13:00:00')), false);
  assert.equal(inLunch(at('2026-11-28T12:10:00')), false);
  assert.equal(shanghaiDay(at('2026-11-27T00:30:00')), '2026-11-27');
});

test('smoothSeries: one averaged point per minute', async () => {
  const { smoothSeries } = await import('../src/pages/rotator/rotatorCharts.js');
  const b = 1795700000 - (1795700000 % 60);
  assert.deepEqual(smoothSeries([[b, 2.211], [b + 5, 2.212], [b + 10, 2.211], [b + 15, 2.212], [b + 60, 2.213]]), [[b + 15, 2.2115], [b + 60, 2.213]]);
});

test('closeAdvice uses the 14:56 snapshot when present', () => {
  const snap = { enter: 15, holding: '159659', holding_name: '招商', cheapest: '159632', cheapest_name: '华安', gap_bps: 26, switch: true };
  const hit = closeAdvice({ close: snap });
  assert.equal(hit.final, true);
  assert.equal(hit.action, 'switch');
  assert.match(hit.text, /从 招商 换到 华安/);
  assert.match(hit.text, /0\.26%/);
  assert.equal(closeAdvice({ close: { ...snap, gap_bps: 8, switch: false } }).action, 'hold');
  assert.equal(closeAdvice({ close: { ...snap, holding: '159632', holding_name: '华安', gap_bps: 0, switch: false } }).action, 'hold');
  assert.equal(closeAdvice({ close: { ...snap, holding: null, gap_bps: null, switch: false } }).action, 'none');
});

test('closeAdvice falls back to a live estimate before 14:56', () => {
  assert.equal(closeAdvice({}), null);
  assert.equal(closeAdvice({ holding: '159659', cheapest: '159632', gap: null }), null);
  const est = closeAdvice({ holding: '159659', cheapest: '159632', gap: 15, holdingName: '招商', cheapestName: '华安' });
  assert.equal(est.final, false);
  assert.equal(est.action, 'switch');
  assert.equal(closeAdvice({ holding: '159659', cheapest: '159632', gap: 14.9 }).action, 'hold');
  assert.equal(closeAdvice({ holding: '159632', cheapest: '159632', gap: 0 }).action, 'hold');
});
