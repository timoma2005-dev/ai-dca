import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_RANGES, buildDailySeries, rangeLabel } from '../src/pages/cn-home/dailyPremium.mjs';

const payload = {
  dates: ['2026-10-27', '2026-10-28', '2026-10-29'],
  groups: [{ key: 'all', label: '全部' }, { key: 'nasdaq-100', label: '纳指 100' }],
  funds: [
    { code: '513100', name: '纳指ETF国泰', groupKey: 'nasdaq-100', prem: [10, null, 12], close: [2, 2.1, 2.2] },
    { code: '159501', name: '纳指ETF嘉实', groupKey: 'nasdaq-100', prem: [14, 15, 16], close: [1, 1.1, 1.2] },
    { code: '161130', name: '纳斯达克100LOF', groupKey: 'nasdaq-100', prem: [1, 1, 1], close: [4, 4, 4] },
  ],
};

test('ranges: today + 3m/半年/1年', () => {
  assert.deepEqual(HOME_RANGES.map((r) => r.label), ['今日', '3月', '半年', '1年']);
  assert.equal(rangeLabel('6m'), '近半年 · 日收盘');
  assert.equal(rangeLabel('today'), '');
});

test('group lines forward-fill missing premium and keep dates aligned', () => {
  const lines = buildDailySeries(payload, { mode: 'premium', group: 'nasdaq-100', range: '3m' });
  assert.equal(lines.length, 3);
  const gt = lines.find((l) => l.code === '513100');
  assert.deepEqual(gt.points.map((p) => p.value), [10, 10, 12]);
  assert.deepEqual(gt.points.map((p) => p.t), payload.dates);
});

test('all group = per-group median excluding LOF', () => {
  const lines = buildDailySeries(payload, { mode: 'premium', group: 'all', range: '1y' });
  assert.equal(lines[0].label, '全部中位数');
  assert.deepEqual(lines[0].points.map((p) => p.value), [12, 12.5, 14]);
});

test('price mode all = equal-weight normalized to 100', () => {
  const lines = buildDailySeries(payload, { mode: 'price', group: 'all', range: '1y' });
  assert.equal(lines[0].points[0].value, 100);
});
