import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartModel, niceTicks, staleSegments, tickDecimals, timeTickIndices } from '../src/pages/cn-home/chartModel.mjs';

test('niceTicks uses round steps covering the range', () => {
  const { ticks, step } = niceTicks(4.1, 30.7);
  assert.equal(step, 10);
  assert.deepEqual(ticks, [0, 10, 20, 30, 40]);
  assert.equal(niceTicks(15.2, 18.9).step, 1);
  assert.equal(tickDecimals(2.5), 1);
  assert.equal(tickDecimals(0.05), 2);
  assert.equal(tickDecimals(5), 0);
});

test('buildChartModel domain matches first/last tick', () => {
  const m = buildChartModel([{ code: 'a', points: [{ t: '09:30', value: 4.65 }, { t: '09:31', value: 30.22 }] }], 'premium');
  assert.equal(m.min, m.ticks[0]);
  assert.equal(m.max, m.ticks[m.ticks.length - 1]);
  assert.ok(m.min <= 4.65 && m.max >= 30.22);
});

test('staleSegments marks long unchanged runs as dashed', () => {
  const pts = [1, 1, 1, 1, 1, 1, 1, 2, 3, 3].map((value) => ({ value }));
  assert.deepEqual(staleSegments(pts), [
    { from: 0, to: 6, stale: true },
    { from: 6, to: 9, stale: false },
  ]);
  assert.deepEqual(staleSegments([{ value: 1 }, { value: 2 }]), [{ from: 0, to: 1, stale: false }]);
  assert.deepEqual(staleSegments([]), []);
});

test('timeTickIndices uses session hours for intraday', () => {
  const times = ['09:30', '09:31', '10:30', '10:31', '11:30', '13:00', '14:00', '14:01'];
  const ticks = timeTickIndices(times.map((t) => ({ t })));
  assert.deepEqual(ticks.map((x) => x.label), ['09:30', '10:30', '11:30', '14:00']);
  assert.deepEqual(ticks.map((x) => x.idx), [0, 2, 4, 6]);
  const daily = timeTickIndices(['2026-11-01', '2026-11-02', '2026-11-03'].map((t) => ({ t })), { daily: true });
  assert.equal(daily[0].label, '2026-11-01');
});
