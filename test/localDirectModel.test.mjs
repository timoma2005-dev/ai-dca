import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDirectRows,
  buildLinePath,
  computePremiumPercent,
  normalizeDirectSearchResults,
  sortDirectRows,
  summarizeDirectRows,
} from '../src/app/localDirectModel.js';

const universe = [
  { code: '513100', name: '纳指ETF国泰' },
  { code: '159941', name: '纳指ETF广发' },
  { code: '513500', name: '标普500ETF' },
];

const quotes = {
  513100: {
    price: 2.167, previousClose: 2.158, open: 2.15, high: 2.175, low: 2.14,
    changePercent: 0.42, volume: 3356138, time: '20260703161434', source: 'tencent-direct',
  },
  159941: {
    price: 1.94, previousClose: 1.96, open: 1.955, high: 1.96, low: 1.93,
    changePercent: -1.02, time: '20260703161434', source: 'tencent-direct',
  },
  // 513500 缺行情，应标记为 unavailable
};

const navs = {
  513100: { latestNav: 2.05, latestNavDate: '2026-07-02' },
  159941: { latestNav: 2.0, latestNavDate: '2026-07-02' },
};

test('computePremiumPercent guards invalid inputs', () => {
  assert.equal(computePremiumPercent(2.167, 2.05), 5.71);
  assert.equal(computePremiumPercent(2, 2), 0);
  assert.equal(computePremiumPercent(null, 2), null);
  assert.equal(computePremiumPercent(2, 0), null);
  assert.equal(computePremiumPercent('x', 2), null);
});

test('buildDirectRows merges quotes and navs, marks missing symbols', () => {
  const rows = buildDirectRows({ universe, quotes, navs });
  assert.equal(rows.length, 3);
  const [first, second, third] = rows;

  assert.deepEqual(
    { code: first.code, name: first.name, available: first.available, price: first.price, premiumPercent: first.premiumPercent },
    { code: '513100', name: '纳指ETF国泰', available: true, price: 2.167, premiumPercent: 5.71 }
  );
  assert.equal(first.navDate, '2026-07-02');
  assert.equal(second.available, true);
  assert.equal(second.premiumPercent, -3);
  assert.equal(third.available, false);
  assert.equal(third.price, null);
  assert.equal(third.premiumPercent, null);
  // 缺省 name 时回退到代码。
  const fallback = buildDirectRows({ universe: [{ code: '000001' }], quotes: {}, navs: {} });
  assert.equal(fallback[0].name, '000001');
});

test('summarizeDirectRows counts availability and directions', () => {
  const rows = buildDirectRows({ universe, quotes, navs });
  const summary = summarizeDirectRows(rows);
  assert.deepEqual(summary, {
    total: 3, available: 2, up: 1, down: 1, flat: 0, missing: 1, premiumAvailable: 2,
  });
  assert.deepEqual(summarizeDirectRows([]), {
    total: 0, available: 0, up: 0, down: 0, flat: 0, missing: 0, premiumAvailable: 0,
  });
});

test('sortDirectRows: premium mode puts nulls last, then premium desc; otherwise change desc', () => {
  const rows = buildDirectRows({ universe, quotes, navs });
  const byPremium = sortDirectRows(rows, { byPremium: true }).map((r) => r.code);
  assert.deepEqual(byPremium, ['513100', '159941', '513500']);

  const byChange = sortDirectRows(rows, { byPremium: false }).map((r) => r.code);
  assert.deepEqual(byChange, ['513100', '159941', '513500']);

  // 溢价高者优先，即使它涨跌幅为负。
  const mixed = [
    { code: 'A', changePercent: 5, premiumPercent: 1 },
    { code: 'B', changePercent: -3, premiumPercent: 9 },
    { code: 'C', changePercent: 9, premiumPercent: null },
  ];
  assert.deepEqual(sortDirectRows(mixed, { byPremium: true }).map((r) => r.code), ['B', 'A', 'C']);
});

test('buildLinePath produces svg geometry and handles insufficient data', () => {
  const empty = buildLinePath([], { width: 640, height: 220 });
  assert.equal(empty.line, '');
  assert.equal(empty.last, null);

  const single = buildLinePath([{ c: 1 }], { width: 640, height: 220 });
  assert.equal(single.line, '');

  const candles = [{ c: 1 }, { c: 2 }, { c: 1.5 }, { c: 3 }];
  const geo = buildLinePath(candles, { width: 640, height: 220, pad: 10 });
  assert.match(geo.line, /^M10 /);
  assert.equal(geo.points.length, 4);
  assert.equal(geo.min, 1);
  assert.equal(geo.max, 3);
  // 最低点在底部、最高点在顶部。
  assert.equal(geo.points[0].y, 210);
  assert.equal(geo.points[3].y, 10);
  assert.equal(geo.last.x, 630);
  assert.ok(geo.area.endsWith('Z'));
});

test('normalizeDirectSearchResults keeps only 6-digit CN fund codes', () => {
  const results = normalizeDirectSearchResults([
    { code: '513100', name: '纳指ETF' },
    { code: 'usAAPL', name: 'Apple' },
    { code: '12345', name: '位数不足' },
    { code: '159941', name: '纳指ETF广发' },
    null,
  ]);
  assert.deepEqual(results, [
    { code: '513100', name: '纳指ETF' },
    { code: '159941', name: '纳指ETF广发' },
  ]);
  assert.deepEqual(normalizeDirectSearchResults(null), []);
});
