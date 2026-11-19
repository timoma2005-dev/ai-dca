import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableShares,
  buildFlippedRule,
  buildQuietRule,
  buildSwitchLedgerDrafts,
  estimateBuyShares,
  findRowForEntry,
  normalizeQuietSignals,
  pickSwitchPair,
  removeQuietToday,
  resolveSignalPrompt,
  signalRuleForSide
} from '../src/app/switchSignalAnswer.js';
import { isSwitchSignalQuiet, normalizeSwitchConfig } from '../workers/notify/src/switchStrategy.js';

const rule = {
  id: 'rule-1',
  name: '招商→易方达',
  enabled: true,
  benchmarkCodes: ['159659'],
  enabledCodes: ['159696'],
  premiumClass: { 159659: 'L', 159696: 'H' },
  intraSellLowerPct: 1.5,
  intraBuyOtherPct: 3,
  holdingFundCode: '159659'
};
const row = {
  id: 'rule-1',
  name: rule.name,
  enabled: true,
  rule,
  holdingSide: 'L',
  highCodes: ['159696'],
  lowCodes: ['159659'],
  highCode: '159696',
  lowCode: '159659',
  highQuotes: [{ code: '159696', name: '纳指ETF易方达', price: 2.011 }],
  lowQuotes: [{ code: '159659', name: '纳斯达克100ETF招商', price: 2.308 }],
  gauge: { triggered: true },
  hitCount: 2,
  lowerPct: 1.5,
  upperPct: 3
};
const today = '2026-11-19';

test('signal rule follows holding side', () => {
  assert.equal(signalRuleForSide('L'), 'A');
  assert.equal(signalRuleForSide('H'), 'B');
});

test('prompt shows when at the line and hides after skip or same-day switch', () => {
  const prompt = resolveSignalPrompt(row, { today });
  assert.equal(prompt.fromCode, '159659');
  assert.equal(prompt.toCode, '159696');
  assert.equal(prompt.signalRule, 'A');
  assert.equal(prompt.fromPrice, 2.308);
  const quiet = buildQuietRule(rule, { signalRule: 'A', today });
  assert.equal(resolveSignalPrompt({ ...row, rule: quiet }, { today }), null);
  assert.ok(resolveSignalPrompt({ ...row, rule: removeQuietToday(quiet, { signalRule: 'A', today }) }, { today }));
  assert.equal(resolveSignalPrompt({ ...row, gauge: { triggered: false }, hitCount: 0 }, { today }), null);
});

test('quiet signals drop past dates and junk', () => {
  const list = normalizeQuietSignals([
    { pair: '*', rule: 'A', date: '2026-11-18' },
    { pair: '*', rule: 'A', date: today },
    { pair: 'x', rule: 'A', date: today },
    { pair: '*', rule: 'C', date: today }
  ], today);
  assert.deepEqual(list, [{ pair: '*', rule: 'A', date: today }]);
});

test('flip moves holding to the other side and clears quiet', () => {
  const quiet = buildQuietRule(rule, { signalRule: 'A', today });
  const next = buildFlippedRule(quiet, { fromCode: '159659', toCode: '159696', toName: '纳指ETF易方达', signalRule: 'A', at: '2026-11-19T05:19:00Z', buyShares: 13700 });
  assert.deepEqual(next.benchmarkCodes, ['159696']);
  assert.deepEqual(next.enabledCodes, ['159659']);
  assert.equal(next.holdingFundCode, '159696');
  assert.equal(next.holdingQuantity, 13700);
  assert.deepEqual(next.quietSignals, []);
  assert.equal(next.lastSwitch.toCode, '159696');
  const normalized = normalizeSwitchConfig({ enabled: true, rules: [next] });
  assert.deepEqual(normalized.rules[0].benchmarkCodes, ['159696']);
});

test('notification entry finds its plan and pair', () => {
  const entry = { fromNotification: true, notificationCode: '159659', notificationTargetCode: '159696' };
  assert.equal(findRowForEntry([row], entry)?.id, 'rule-1');
  assert.equal(findRowForEntry([row], { ...entry, notificationCode: '159696' }), null);
  assert.equal(pickSwitchPair(row, entry).toCode, '159696');
  const prompt = resolveSignalPrompt({ ...row, gauge: { triggered: false }, hitCount: 0 }, { today, entry });
  assert.equal(prompt.fromEntry, true);
});

test('ledger helpers', () => {
  const txs = [
    { code: '159659', type: 'BUY', shares: 15000 },
    { code: '159659', type: 'SELL', shares: 3000 },
    { code: '159696', type: 'BUY', shares: 100 }
  ];
  assert.equal(availableShares(txs, '159659'), 12000);
  assert.equal(estimateBuyShares({ sellPrice: 2.308, sellShares: 12000, buyPrice: 2.012 }), 13700);
  let n = 0;
  const [sell, buy] = buildSwitchLedgerDrafts({ fromCode: '159659', toCode: '159696', sellPrice: 2.308, sellShares: 12000, buyPrice: 2.012, buyShares: 13700, date: today, makeId: () => `t${++n}` });
  assert.equal(sell.type, 'SELL');
  assert.equal(sell.switchPairId, buy.id);
  assert.equal(buy.switchPairId, sell.id);
});

test('worker keeps quiet signals and skips quiet direction', () => {
  const normalized = normalizeSwitchConfig({ enabled: true, rules: [{ ...rule, quietSignals: [{ pair: '*', rule: 'A', date: today }, { rule: 'Z', date: today }] }] });
  assert.deepEqual(normalized.rules[0].quietSignals, [{ pair: '*', rule: 'A', date: today }]);
  const r = normalized.rules[0];
  assert.equal(isSwitchSignalQuiet(r, '159659:159696', 'A', today), true);
  assert.equal(isSwitchSignalQuiet(r, '159659:159696', 'B', today), false);
  assert.equal(isSwitchSignalQuiet(r, '159659:159696', 'A', '2026-11-20'), false);
  assert.equal(isSwitchSignalQuiet({ quietSignals: [{ pair: '159659:159632', rule: 'A', date: today }] }, '159659:159696', 'A', today), false);
});
