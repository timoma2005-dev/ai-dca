import test from 'node:test';
import assert from 'node:assert/strict';
import { premiumOverpayAmount, formatPremiumOverpay, estimatePremiumArbitrage } from '../src/pages/markets/marketDisplayUtils.js';
import { parseIndexFutures } from '../src/pages/markets/useIndexFutures.js';

test('10万溢价成本', () => {
  assert.equal(premiumOverpayAmount(20), 16667);
  assert.equal(premiumOverpayAmount(0), 0);
  assert.equal(premiumOverpayAmount(null), null);
  assert.equal(formatPremiumOverpay(12.5), '多付 ¥11,111');
  assert.equal(formatPremiumOverpay(-1), '少付 ¥1,010');
});

test('申购套利估算', () => {
  const open = estimatePremiumArbitrage(8.93, { buyStatus: 'limited', maxPurchasePerDay: 100 });
  assert.equal(open.netPct, 8.75);
  assert.equal(open.suspended, false);
  assert.equal(open.profitAtCap, 9);
  const sus = estimatePremiumArbitrage(8.93, { buyStatus: 'suspended', buyStatusText: '暂停申购', maxPurchasePerDay: 10 });
  assert.equal(sus.suspended, true);
  assert.equal(sus.profitAtCap, null);
  assert.equal(estimatePremiumArbitrage(null, null), null);
});

test('东财期货解析', () => {
  const out = parseIndexFutures({ data: { diff: [
    { f1: 2, f2: 2810892, f3: -7, f12: 'NQ00Y', f124: 1793687669 },
    { f1: 2, f2: '-', f3: '-', f12: 'ES00Y' },
  ] } });
  assert.equal(out.NQ00Y.price, 28108.92);
  assert.equal(out.NQ00Y.changePercent, -0.07);
  assert.equal(out.ES00Y, undefined);
});
