import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_DIRECT_HIDDEN_RANGES,
  buildLocalDirectDetailData,
  buildLocalDirectMarketRows,
  localDirectKlineTimeframe,
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
  513100: { latestNav: 2.05, latestNavDate: '2026-10-24', navSource: 'eastmoney-zjl', premiumPercent: 2.38 },
  159941: { latestNav: 2.0, latestNavDate: '2026-07-02', navSource: 'danjuan-direct' },
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
    // 东财 ZJL 显式溢价率优先，不用本地 price/nav 重算的 5.71。
    { code: '513100', name: '纳指ETF国泰', available: true, price: 2.167, premiumPercent: 2.38 }
  );
  assert.equal(first.navDate, '2026-10-24');
  assert.equal(first.navSource, 'eastmoney-zjl');
  assert.equal(second.available, true);
  assert.equal(second.premiumPercent, -3);
  assert.equal(third.available, false);
  assert.equal(third.price, null);
  assert.equal(third.premiumPercent, null);
  // 缺省 name 时回退到代码。
  const fallback = buildDirectRows({ universe: [{ code: '000001' }], quotes: {}, navs: {} });
  assert.equal(fallback[0].name, '000001');
});

test('explicit eastmoney premium wins over local calc, including zero; missing falls back', () => {
  const rows = buildDirectRows({
    universe: [{ code: '513100', name: '纳指ETF国泰' }, { code: '159941', name: '纳指ETF广发' }],
    quotes: {
      513100: { price: 2.167 },
      159941: { price: 1.94 },
    },
    navs: {
      // 显式 0 是合法溢价率，不能被 ?? 之后的本地重算覆盖。
      513100: { latestNav: 2.05, premiumPercent: 0, navSource: 'eastmoney-zjl' },
      159941: { latestNav: 2.0, navSource: 'danjuan-direct' },
    },
  });
  assert.equal(rows[0].premiumPercent, 0);
  // 无显式溢价率时回退 (1.94 / 2 - 1) * 100 = -3。
  assert.equal(rows[1].premiumPercent, -3);
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

test('buildLocalDirectMarketRows maps direct quotes to cloud-shaped rows', () => {
  const rows = buildLocalDirectMarketRows(['159509', '513100', '159509'], {
    quotes: {
      159509: { name: '纳指科技ETF', price: 3.012, previousClose: 2.957, change: 0.055, changePercent: 1.86, high: 3.033, low: 2.99, turnover: 12345.6, time: '20261027150003' },
    },
    navs: {
      159509: { latestNav: 2.2335, latestNavDate: '2026-10-24', premiumPercent: 34.86 },
      513100: { latestNav: 1.8, latestNavDate: '2026-10-24', premiumPercent: null, navChangePercent: 0.5 },
    },
    heldCodes: new Set(['513100']),
  });
  assert.equal(rows.length, 2);
  const [etf, navOnly] = rows;
  assert.equal(etf.symbol, '159509');
  assert.equal(etf.price, 3.012);
  assert.equal(etf.premiumPercent, 34.86);
  assert.equal(etf.turnover, 123456000);
  assert.equal(etf.fundKind, 'exchange_fund');
  assert.equal(etf.lastUpdated, new Date('2026-10-27T15:00:03+08:00').toISOString());
  // 无场内行情只有净值时按净值展示，不编造溢价。
  assert.equal(navOnly.fundKind, 'otc');
  assert.equal(navOnly.price, 1.8);
  assert.equal(navOnly.changePercent, 0.5);
  assert.equal(navOnly.premiumPercent, null);
  assert.equal(navOnly.isHeld, true);
});

test('local direct chart helpers skip intraday ranges', () => {
  assert.deepEqual([...LOCAL_DIRECT_HIDDEN_RANGES], ['1d', '5d']);
  assert.equal(localDirectKlineTimeframe('6mo'), '1d');
  assert.equal(localDirectKlineTimeframe('max'), '1w');
  const detail = buildLocalDirectDetailData({ latestNav: 1.2, latestNavDate: '2026-10-24', premiumPercent: 3.1, turnover: 100 });
  assert.equal(detail.premiumPercent, 3.1);
  assert.equal(detail.amount, 100);
});
