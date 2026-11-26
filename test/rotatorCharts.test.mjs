import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basePrice, defaultBuyShares, deviationBars, minuteLabel, shanghaiTs, shortName, switchPnlSeries, tradingMinute
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
