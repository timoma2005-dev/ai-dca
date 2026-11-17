import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSwitchGuide, shortEtfName } from '../services/cn-data/src/demo/teaser.js';
import { buildLadder, buildPlan, buildGuideRulePayload, judgePlan, pairStat } from '../src/pages/switch/switchGuideModel.js';

function sampleData() {
  const history = [];
  for (let i = 0; i < 130; i += 1) {
    const day = new Date(Date.UTC(2026, 4, 1) + i * 86400000).toISOString().slice(0, 10);
    history.push({ date: day, premiums: { 513100: 17 + (i % 5) * 0.1, 159513: 13, 159941: 15 } });
  }
  return {
    date: '2026-11-16',
    etfs: [
      { code: '513100', name: '纳指ETF国泰', premium: 17.14 },
      { code: '159513', name: '纳斯达克100ETF大成', premium: 12.43 },
      { code: '159941', name: '纳指ETF广发', premium: 15.43 }
    ],
    premiumHistory: history
  };
}

test('shortEtfName strips the index prefix', () => {
  assert.equal(shortEtfName('纳斯达克100ETF大成'), '大成');
  assert.equal(shortEtfName('纳指100ETF博时'), '博时');
});

test('buildSwitchGuide gives per-window relative medians and pair quantiles only', () => {
  const guide = buildSwitchGuide(sampleData());
  assert.deepEqual(Object.keys(guide.win).sort(), ['120', '180', '60']);
  assert.equal(guide.win[60].days, 60);
  assert.ok(guide.win[60].rel['513100'] > 0);
  assert.ok(guide.win[60].rel['159513'] < 0);
  const [m, lo, hi] = guide.win[60].pairs['159513-513100'];
  assert.ok(m < 0 && lo <= m && m <= hi);
  assert.equal(guide.premiumHistory, undefined);
});

test('plan picks the usually-pricier fund as H and fills thresholds from the quartiles', () => {
  const guide = buildSwitchGuide(sampleData());
  assert.equal(buildLadder(guide, 60)[0].code, '513100');
  const stat = pairStat(guide, '513100', '159513', 60);
  assert.ok(stat.m > 0);
  const plan = buildPlan(guide, '159513', '513100', 60);
  assert.equal(plan.X, '513100');
  assert.equal(plan.holdX, false);
  assert.ok(plan.back <= plan.go - 0.3);
  const payload = buildGuideRulePayload({ plan, hold: '159513', target: '513100', name: 'x' });
  assert.deepEqual(payload.highCodes, ['513100']);
  assert.equal(payload.holdingSide, 'L');
  const verdict = judgePlan({ ...plan, gap: plan.back - 1, nameX: '国泰', nameY: '大成', codeX: '513100', codeY: '159513' });
  assert.equal(verdict.kind, 'back');
});

test('buildSwitchGuide prefers minute-level stats when provided, keeping daily for missing codes', () => {
  const minute = { win: { 60: { from: '2026-08-14', days: 60, minutes: 14220, rel: { 513100: 3.3, 159513: -0.83 }, pairs: { '159513-513100': [-4.24, -5.31, -3.25] } } } };
  const guide = buildSwitchGuide(sampleData(), minute);
  assert.equal(guide.win[60].basis, 'minute');
  assert.equal(guide.win[60].from, '2026-08-14');
  assert.equal(guide.win[60].rel['513100'], 3.3);
  assert.ok(Number.isFinite(guide.win[60].rel['159941']));
  assert.deepEqual(guide.win[60].pairs['159513-513100'], [-4.24, -5.31, -3.25]);
  assert.equal(guide.win[120].basis, 'daily');
});
