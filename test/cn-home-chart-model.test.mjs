import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE,
  buildChartModel,
  computeZones,
  isLofLine,
  lineKey,
  pointTime,
  resolveEndLabels,
  tooltipRows,
  valueOfPoint,
} from '../src/pages/cn-home/chartModel.mjs';

function line(key, code, name, values, times) {
  return {
    key, code, name,
    points: values.map((value, i) => ({
      t: times ? times[i] : `09:${String(30 + i).padStart(2, '0')}`,
      value,
    })),
  };
}

test('empty series yields an empty model (renders the 暂无今日走势 state)', () => {
  const model = buildChartModel([], 'premium', []);
  assert.deepEqual(model.rows, []);
  assert.equal(model.length, 0);
  assert.deepEqual(model.zones, []);
  assert.deepEqual(model.gaps, []);
});

test('valueOfPoint is defensive across server point shapes', () => {
  assert.equal(valueOfPoint({ value: 1.5 }, 'premium'), 1.5);
  assert.equal(valueOfPoint({ premiumPercent: 2.5 }, 'premium'), 2.5);
  assert.equal(valueOfPoint({ pr: 3.5 }, 'premium'), 3.5);
  assert.equal(valueOfPoint({ price: 4.5 }, 'price'), 4.5);
  assert.equal(valueOfPoint({ p: 5.5 }, 'price'), 5.5);
  assert.equal(valueOfPoint({ value: 'oops' }, 'premium'), null);
  assert.equal(valueOfPoint(null, 'premium'), null);
});

test('pointTime falls back through t / time / label / timestamp', () => {
  assert.equal(pointTime({ t: '09:30' }), '09:30');
  assert.equal(pointTime({ time: '10:00' }), '10:00');
  assert.equal(pointTime({ label: '10:30' }), '10:30');
  assert.equal(pointTime({ timestamp: '11:00' }), '11:00');
  assert.equal(pointTime({}), '');
});

test('computeZones splits latest values into high/medium/low thirds with medians', () => {
  const rows = [
    line('a', '159001', 'A', [13, 13.5]),
    line('b', '159002', 'B', [12, 12.5]),
    line('c', '159003', 'C', [11, 11.5]),
    line('d', '159004', 'D', [10, 10.5]),
    line('e', '159005', 'E', [9, 9.5]),
    line('f', '159006', 'F', [8, 8.5]),
  ].map((l, i) => ({ ...l, rowKey: lineKey(l, i), color: PALETTE[i], points: l.points.map((p) => ({ ...p, value: p.value, t: p.t })) }));
  const zones = computeZones(rows, 'premium');
  assert.equal(zones.length, 3);
  assert.deepEqual(zones.map((z) => z.key), ['high', 'medium', 'low']);
  assert.deepEqual(zones.map((z) => z.count), [2, 2, 2]);
  // medians: high (13.5+12.5)/2, medium (11.5+10.5)/2, low (9.5+8.5)/2
  assert.deepEqual(zones.map((z) => z.value), [13, 11, 9]);
});

test('computeZones excludes LOF lines and requires at least 3 non-LOF lines', () => {
  const rows = [
    line('a', '159001', 'A', [13, 13.5]),
    line('b', '161001', 'LOF联接', [99, 99.9]),
    line('c', '159003', 'C', [11, 11.5]),
  ].map((l, i) => ({ ...l, rowKey: lineKey(l, i), color: PALETTE[i], points: l.points.map((p) => ({ ...p, value: p.value, t: p.t })) }));
  assert.ok(isLofLine(rows[1]));
  assert.deepEqual(computeZones(rows, 'premium'), []);
  // price mode never produces zones
  const six = Array.from({ length: 6 }, (_, i) => ({ ...line(`k${i}`, `15900${i}`, `F${i}`, [i, i + 1]), rowKey: `k${i}`, color: PALETTE[i], points: [{ value: i, t: '09:30' }, { value: i + 1, t: '09:35' }] }));
  assert.deepEqual(computeZones(six, 'price'), []);
});

test('buildChartModel computes high-medium / medium-low / high-low gaps', () => {
  const series = [
    line('a', '159001', 'A', [13, 13.5]),
    line('b', '159002', 'B', [12, 12.5]),
    line('c', '159003', 'C', [11, 11.5]),
    line('d', '159004', 'D', [10, 10.5]),
    line('e', '159005', 'E', [9, 9.5]),
    line('f', '159006', 'F', [8, 8.5]),
  ];
  const model = buildChartModel(series, 'premium', []);
  assert.deepEqual(model.gaps.map((g) => g.key), ['high-medium', 'medium-low', 'high-low']);
  assert.deepEqual(model.gaps.map((g) => g.value), [2, 2, 4]);
});

test('hiddenKeys removes the line from rows (its path is never rendered)', () => {
  const series = [
    line('a', '159001', 'A', [1, 2]),
    line('b', '159002', 'B', [3, 4]),
  ];
  const model = buildChartModel(series, 'premium', ['a']);
  assert.deepEqual(model.rows.map((r) => r.rowKey), ['b']);
  // colors stay stable by original series index
  assert.equal(model.rows[0].color, PALETTE[1]);
  // hiding everything yields the empty state
  const empty = buildChartModel(series, 'premium', ['a', 'b']);
  assert.deepEqual(empty.rows, []);
});

test('resolveEndLabels keeps labels separated and inside the plot bounds', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    rowKey: `k${i}`,
    points: [{ value: 5 + i * 0.05, t: '09:30' }],
  }));
  const yFor = (v) => 200 - v * 10;
  const labels = resolveEndLabels(rows, yFor, { top: 26, bottom: 344, minGapMax: 13 });
  assert.equal(labels.length, 10);
  for (const l of labels) {
    assert.ok(l.y >= 26 && l.y <= 344, `label y=${l.y} out of bounds`);
  }
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].y - sorted[i - 1].y >= 12.9, 'labels overlap');
  }
});

test('resolveEndLabels returns [] for no rows', () => {
  assert.deepEqual(resolveEndLabels([], () => 0, { top: 0, bottom: 100 }), []);
});

test('tooltipRows ranks by value desc in premium mode and keeps order in price mode', () => {
  const rows = [
    { rowKey: 'a', points: [{ value: 1, t: '09:30' }] },
    { rowKey: 'b', points: [{ value: 5, t: '09:30' }] },
    { rowKey: 'c', points: [{ value: 3, t: '09:30' }] },
  ];
  assert.deepEqual(tooltipRows(rows, 0, 'premium').map((r) => r.line.rowKey), ['b', 'c', 'a']);
  assert.deepEqual(tooltipRows(rows, 0, 'price').map((r) => r.line.rowKey), ['a', 'b', 'c']);
});
