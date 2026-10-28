import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEastmoneyPeriodIncrease, parseEastmoneyFundDetail, pickYearBaseClose } from '../src/app/directMarketData.js';
import { buildLocalDirectMarketRows } from '../src/app/localDirectModel.js';

test('FundMNPeriodIncrease maps period titles to row return fields', () => {
  const parsed = parseEastmoneyPeriodIncrease({
    Datas: [
      { title: 'Z', syl: '-0.96' },
      { title: 'Y', syl: '-4.59' },
      { title: '3Y', syl: '2.13' },
      { title: '6Y', syl: '3.13' },
      { title: '1N', syl: '7.38' },
      { title: 'JN', syl: '8.86' },
      { title: 'LN', syl: '516.86' },
      { title: '5N', syl: '' },
    ],
    Expansion: { TIME: '2026-10-26' },
  });
  assert.deepEqual(parsed, {
    return1w: -0.96, return1m: -4.59, return3m: 2.13, return6m: 3.13, return1y: 7.38,
    ytdReturn: 8.86, returnBase: 516.86, returnsAsOf: '2026-10-26',
  });
});

test('FundMNDetailInformation sums annual fees', () => {
  const parsed = parseEastmoneyFundDetail({ Datas: { MGREXP: '0.80%', TRUSTEXP: '0.20%', SALESEXP: '0.00%', ENDNAV: '4958120057.2', SHORTNAME: '大成纳斯达克100ETF联接(QDII)A' } });
  assert.equal(parsed.annualFeeRate, 1);
  assert.equal(parsed.fundScale, 4958120057.2);
  assert.equal(parsed.name, '大成纳斯达克100ETF联接(QDII)A');
});

test('local direct rows merge fund profiles (otc ignores shares)', () => {
  const rows = buildLocalDirectMarketRows(['000834', '513500'], {
    navs: { '000834': { latestNav: 6.1686, navChangePercent: 1.05, name: '大成纳斯达克100ETF联接(QDII)A' } },
    quotes: { 513500: { price: 2.664, changePercent: 2.34, previousClose: 2.603 } },
    profiles: {
      '000834': { ytdReturn: 8.86, return1m: -4.59, annualFeeRate: 1, totalShares: 5 },
      513500: { ytdReturn: 7.16, totalShares: 10678638592, annualFeeRate: 0.6 },
    },
  });
  const otc = rows.find((row) => row.code === '000834');
  const etf = rows.find((row) => row.code === '513500');
  assert.equal(otc.ytdReturn, 8.86);
  assert.equal(otc.currentYearPercent, 8.86);
  assert.equal(otc.return1m, -4.59);
  assert.equal(otc.feeRate, 1);
  assert.equal(otc.totalShares, undefined);
  assert.equal(etf.totalShares, 10678638592);
  assert.equal(etf.feeRate, 0.6);
});

test('exchange rows split price ytd (year base) and nav ytd (eastmoney JN)', () => {
  const rows = buildLocalDirectMarketRows(['513100', '159509'], {
    quotes: { 513100: { price: 2.291, changePercent: 1.87 }, 159509: { price: 3.104 } },
    profiles: { 513100: { ytdReturn: 10.41 }, 159509: { ytdReturn: 18.2 } },
    yearBases: { 513100: { close: 1.904, date: '2025-12-31', year: 2026 } },
  });
  const a = rows.find((row) => row.code === '513100');
  const b = rows.find((row) => row.code === '159509');
  assert.equal(a.ytdReturn, 20.33);
  assert.equal(a.currentYearPercent, 20.33);
  assert.equal(a.navYtdReturn, 10.41);
  // 没有基准时价格口径留空，不拿净值冒充。
  assert.equal(b.ytdReturn, undefined);
  assert.equal(b.navYtdReturn, 18.2);
});

test('pickYearBaseClose uses last close before Jan 1, falls back to first close of year', () => {
  const candles = [
    { date: '2025-12-30', c: 1.914 },
    { date: '2025-12-31', c: 1.904 },
    { date: '2026-01-05', c: 1.93 },
  ];
  assert.deepEqual(pickYearBaseClose(candles, 2026), { date: '2025-12-31', close: 1.904 });
  assert.deepEqual(pickYearBaseClose(candles.slice(2), 2026), { date: '2026-01-05', close: 1.93 });
  assert.equal(pickYearBaseClose([], 2026), null);
});
