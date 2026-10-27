import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEastmoneyPeriodIncrease, parseEastmoneyFundDetail } from '../src/app/directMarketData.js';
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
