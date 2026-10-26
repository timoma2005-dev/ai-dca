import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRounds, extractSwitches, reviewFromLedger, summarizeRounds } from '../src/app/radarReview.js';
import { formatShares, heroNotes, quotaBadge, quotaEvents, scoredRows, shortName } from '../src/app/radarScoreModel.js';

// 4 个交易日：A=159501（卖），B=159513（买）
const series = {
  dates: ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'],
  etfs: {
    159501: { price: [2.2, 2.2, 2.15, 2.1], nav: [1.9, 1.9, 1.9, 1.9], premium: [15.79, 15.79, 13.16, 10.53], limit: [1e6, 1e6, 1e6, 1e6], sell: [80, 85, 70, 60], buy: [20, 18, 30, 40] },
    159513: { price: [1.8, 1.8, 1.81, 1.82], nav: [1.65, 1.65, 1.65, 1.65], premium: [9.09, 9.09, 9.7, 10.3], limit: [1.5e7, 1.5e7, 1.5e7, 1.5e7], sell: [30, 30, 30, 30], buy: [80, 82, 80, 78] },
  },
};

const txs = [
  { id: 'b1', type: 'BUY', code: '159513', date: '2026-10-21', price: 1.8, shares: 10000 },
  { id: 's1', type: 'SELL', code: '159501', date: '2026-10-21', price: 2.2, shares: 8182, switchPairId: 'b1' },
  { id: 'x', type: 'BUY', code: '000001', date: '2026-10-21', price: 1, shares: 1 },
];

test('extractSwitches: SELL.switchPairId → BUY.id；池外基金忽略；两边共用 id 也能配对', () => {
  const sw = extractSwitches(txs);
  assert.equal(sw.length, 1);
  assert.equal(sw[0].sell.code, '159501');
  assert.equal(sw[0].buy.code, '159513');
  const shared = extractSwitches([
    { id: 's', type: 'SELL', code: '513100', date: '2026-10-22', price: 2, shares: 1, switchPairId: 'p' },
    { id: 'b', type: 'BUY', code: '513390', date: '2026-10-22', price: 2, shares: 1, switchPairId: 'p' },
  ]);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].buy.code, '513390');
});

test('buildRounds: 相对收益、归因恒等、信号价差与当时换基分', () => {
  const [r] = buildRounds(extractSwitches(txs), series);
  assert.equal(r.status, 'ok');
  assert.equal(r.open, true);
  // (1.82/1.8)/(2.1/2.2) − 1 = 5.926%，减估算佣金 0.02
  assert.equal(r.grossPct, 5.93);
  assert.equal(r.netPct, 5.91);
  const sum = r.parts.filter((p) => !p.context).reduce((s, p) => s + p.value, 0);
  assert.ok(Math.abs(sum - r.netPct) < 0.03, `parts sum ${sum} vs net ${r.netPct}`);
  assert.equal(r.signalSpread, 6.7); // 10-20 收盘：15.79 − 9.09
  assert.ok(Number.isInteger(r.signalScore));
  assert.equal(r.reason, null);
  assert.ok(r.extraYuan > 0);
});

test('buildRounds: 买入方随后放开额度且亏损 → 主因份额事件反向', () => {
  const s2 = JSON.parse(JSON.stringify(series));
  s2.etfs['159513'].price = [1.8, 1.8, 1.75, 1.7];
  s2.etfs['159513'].limit = [1e6, 1e6, 1e7, 1e7];
  s2.etfs['159501'].price = [2.2, 2.2, 2.2, 2.2];
  const [r] = buildRounds(extractSwitches(txs), s2);
  assert.ok(r.netPct < 0);
  assert.equal(r.reason.label, '份额事件反向');
  assert.equal(r.events[0].kind, 'relax');
});

test('buildRounds: 早于雷达日线 → insufficient；已切出的轮次用切出价', () => {
  const early = buildRounds(extractSwitches([
    { id: 'b', type: 'BUY', code: '159513', date: '2026-09-01', price: 1.8, shares: 1 },
    { id: 's', type: 'SELL', code: '159501', date: '2026-09-01', price: 2.2, shares: 1, switchPairId: 'b' },
  ]), series);
  assert.equal(early[0].status, 'insufficient');
  const closed = buildRounds(extractSwitches([
    ...txs,
    { id: 'b2', type: 'BUY', code: '159501', date: '2026-10-23', price: 2.1, shares: 8000 },
    { id: 's2', type: 'SELL', code: '159513', date: '2026-10-23', price: 1.83, shares: 10000, switchPairId: 'b2' },
  ]), series);
  assert.equal(closed[0].open, false);
  assert.equal(closed[0].bEnd, 1.83);
  assert.equal(closed[1].open, true);
});

test('summarizeRounds / reviewFromLedger', () => {
  const { rounds, summary } = reviewFromLedger(txs, { series });
  assert.equal(rounds.length, 1);
  assert.equal(summary.winRate, 1);
  assert.equal(summary.open, 1);
  assert.equal(summary.buckets.reduce((s, b) => s + b.count, 0), 1);
  assert.equal(summarizeRounds([]).winRate, null);
});

const data = {
  date: '2026-10-23',
  scoring: {
    date: '2026-10-23',
    etfs: {
      513100: { code: '513100', name: '国泰', premium: 15.7, premiumVsPeer: 3, sellScore: 95, buyScore: 10, sellTag: '果断卖出', buyBlocked: '等放开结束', quota: { state: 'relax', label: '刚放开', limitShares: 2.5e7, prevLimitShares: 2.5e6, deltaRatioPct: 4.2, strong: true }, parts: {} },
      513390: { code: '513390', name: '博时', premium: 10.2, premiumVsPeer: -2.2, sellScore: 15, buyScore: 90, sellTag: '', buyBlocked: '', quota: { state: 'tight', label: '刚收紧', limitShares: 1e6, prevLimitShares: 5e6 }, parts: {} },
      159513: { code: '159513', name: '大成', premium: 9.86, premiumVsPeer: -2.5, sellScore: 30, buyScore: 20, sellTag: '', buyBlocked: '等放开结束', quota: { state: 'relaxing', label: '放开中', strong: true, changeDate: '2026-10-21' }, parts: {} },
      159941: { code: '159941', name: '广发', premium: 15, premiumVsPeer: 2.6, sellScore: 70, buyScore: 22, sellTag: '', buyBlocked: '', quota: { state: 'steady', label: '额度稳定', limitShares: 1.3e6 }, parts: {} },
    },
    recommendedPair: { sell: { code: '513100', premium: 15.7 }, buy: { code: '513390', premium: 10.2 }, score: 91, netSpread: 5.42, costPct: 0.08 },
    blockedPairs: [{ sell: { code: '513100' }, buy: { code: '159513' } }],
  },
};

test('radarScoreModel: 排序、份额徽标、份额动态、提示条', () => {
  assert.equal(shortName('513390'), '博时');
  assert.equal(formatShares(2.5e7), '2500万');
  assert.equal(formatShares(null, { unlimited: true }), '不设限');
  assert.equal(quotaBadge(data.scoring.etfs['513100'].quota).detail, '250万→2500万份');
  assert.deepEqual(scoredRows(data, 'sell').map((r) => r.code), ['513100', '159941', '159513', '513390']);
  assert.deepEqual(scoredRows(data, 'quota').map((r) => r.code), ['513100', '513390', '159513']);
  const { events, steadyCount } = quotaEvents(data);
  assert.equal(events[0].state, 'relax');
  assert.equal(steadyCount, 1);
  const notes = heroNotes(data);
  assert.deepEqual(notes.map((n) => n.tag), ['果断卖出', '买入加分', '已跳过']);
});
