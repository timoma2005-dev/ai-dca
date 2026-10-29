import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuota,
  effectiveSubscribeLimit,
  percentileRank,
  quotaSellFactor,
  scoreRadar,
  turnoverYuan,
} from '../src/radarScoring.js';
import { buildRadarSeries, readLimitHistory } from '../src/nasdaqRadar.js';

const day = (date, limit) => ({ date, limit });

test('effectiveSubscribeLimit: 取总量 / 净申购较小者，暂停 = 0，均不设限 = Infinity', () => {
  assert.equal(effectiveSubscribeLimit({ totalSubscribeLimitKind: 'limited', totalSubscribeLimitShares: 5e6, netSubscribeLimitKind: 'limited', netSubscribeLimitShares: 1e6 }), 1e6);
  assert.equal(effectiveSubscribeLimit({ subscriptionAllowed: false, totalSubscribeLimitKind: 'limited', totalSubscribeLimitShares: 5e6 }), 0);
  assert.equal(effectiveSubscribeLimit({ totalSubscribeLimitKind: 'unlimited', netSubscribeLimitKind: 'unlimited' }), Infinity);
  assert.equal(effectiveSubscribeLimit(null), null);
});

test('turnoverYuan: 万元与元两种口径', () => {
  assert.equal(turnoverYuan(15329), 153290000);
  assert.equal(turnoverYuan(71300000), 71300000);
  assert.equal(turnoverYuan(null), null);
});

test('classifyQuota: 刚放开且新增额度 ≥ 日均成交 1% → strong', () => {
  const q = classifyQuota([day('d1', 1e6), day('d2', 1e6), day('d3', 1e7)], { nav: 2, adtvYuan: 1e8 });
  assert.equal(q.state, 'relax');
  assert.equal(q.strong, true);
  assert.equal(q.deltaRatioPct, 18);
  assert.equal(q.quotaRatioPct, 20);
});

test('classifyQuota: 小幅放开（新增 < 1%）不算 strong', () => {
  const q = classifyQuota([day('d1', 1e5), day('d2', 3e5)], { nav: 2, adtvYuan: 1e8 });
  assert.equal(q.state, 'relax');
  assert.equal(q.strong, false);
});

test('classifyQuota: 不设限视为彻底放开；放开后 2 日内维持高额度为放开中', () => {
  assert.equal(classifyQuota([day('d1', 1e6), day('d2', Infinity)], { nav: 2, adtvYuan: 1e8 }).strong, true);
  const q = classifyQuota([day('d1', 1e6), day('d2', 1e7), day('d3', 1e7)], { nav: 2, adtvYuan: 1e8 });
  assert.equal(q.state, 'relaxing');
  assert.equal(q.changeDate, 'd2');
});

test('classifyQuota: 收紧 / 暂停 / 稳定 / 无数据', () => {
  assert.equal(classifyQuota([day('d1', 5e6), day('d2', 1e6)]).state, 'tight');
  assert.equal(classifyQuota([day('d1', 5e6), day('d2', 0)]).state, 'closed');
  assert.equal(classifyQuota([day('d1', 5e6), day('d2', 5e6)]).state, 'steady');
  assert.equal(classifyQuota([]).state, 'unknown');
});

test('quotaSellFactor 顺序：放开 > 稳定 = 暂停 > 收紧（v2.1 暂停申购按中性）', () => {
  const f = (state, extra = {}) => quotaSellFactor({ state, ...extra });
  assert.ok(f('relax', { strong: true }) > f('relaxing') && f('relaxing') > f('steady') && f('steady') > f('tight'));
  assert.equal(f('closed'), f('steady'));
});

test('percentileRank: 样本不足返回 0.5', () => {
  assert.equal(percentileRank([1, 2], 3), 0.5);
  assert.equal(percentileRank([1, 2, 3, 4], 3), 0.75);
});

function etf(code, premium, extra = {}) {
  return { code, name: `基金${code}`, premium, latestNav: 2, turnover: 10000, bidAskSpreadBps: 4, depth5: 50000, ...extra };
}

test('scoreRadar: 刚放开的高溢价基金 ≥90 果断卖出，并禁止作为买入', () => {
  const etfs = { A: etf('A', 15), B: etf('B', 10), C: etf('C', 12) };
  const limitHistory = {
    A: [day('d1', 1e6), day('d2', 2e7)],
    B: [day('d1', 1e6), day('d2', 1e6)],
    C: [day('d1', 1e6), day('d2', 1e6)],
  };
  const r = scoreRadar({ etfs, limitHistory, date: 'd2' });
  assert.ok(r.etfs.A.sellScore >= 90);
  assert.equal(r.etfs.A.sellTag, '果断卖出');
  assert.equal(r.etfs.A.buyBlocked, '等放开结束');
  assert.equal(r.recommendedPair.sell.code, 'A');
  assert.equal(r.recommendedPair.buy.code, 'B');
  assert.ok(r.pairs.every((pair) => pair.buy.code !== 'A'));
  assert.equal(r.mode, 'shadow');
});

test('scoreRadar: 买入方刚放开时，即使价差最大也不推荐', () => {
  const etfs = { A: etf('A', 15), B: etf('B', 8), C: etf('C', 10) };
  const limitHistory = {
    A: [day('d1', 1e6), day('d2', 1e6)],
    B: [day('d1', 1e6), day('d2', 3e7)],
    C: [day('d1', 1e6), day('d2', 1e6)],
  };
  const r = scoreRadar({ etfs, limitHistory, date: 'd2' });
  assert.equal(r.recommendedPair.buy.code, 'C');
  assert.equal(r.blockedPairs[0].buy.code, 'B');
});

test('scoreRadar v2.1: 同类溢价不计分，权重 自身 60 / 份额 25 / 流动性 15', () => {
  const r = scoreRadar({ etfs: { A: etf('A', 15), B: etf('B', 10) }, date: 'd' });
  assert.deepEqual(r.weights.sell, { peer: 0, own: 60, quota: 25, liquidity: 15 });
  assert.equal(r.etfs.A.parts.sell.peer, 0);
  // 没有历史时自身分位取 0.5：两只同分，不因当日溢价高低拉开
  assert.equal(r.etfs.A.sellScore, r.etfs.B.sellScore);
});

test('scoreRadar v2.1: 平价换基——溢价差 ≤0.5pp、自身高位卖 / 自身低位买', () => {
  const hist = [];
  for (let i = 1; i <= 20; i += 1) {
    // A 平时 9~10%，B 平时 11~12%：今天两只都在 10.5% 附近，A 在自身高位、B 在自身低位
    hist.push({ date: `h${String(i).padStart(2, '0')}`, etfs: { A: { premium: 9 + i / 20 }, B: { premium: 11 + i / 20 }, C: { premium: 5 } } });
  }
  const etfs = { A: etf('A', 10.6), B: etf('B', 10.4), C: etf('C', 5) };
  const r = scoreRadar({ etfs, featureHistory: hist, date: 'd' });
  assert.equal(r.parityPair.sell.code, 'A');
  assert.equal(r.parityPair.buy.code, 'B');
  assert.ok(r.parityPair.edge >= 10);
  assert.ok(Math.abs(r.parityPair.spread) <= 0.5);
  assert.ok(r.parityPairs.every((p) => Math.abs(p.spread) <= 0.5 && p.edge >= 10));
});

test('scoreRadar v2.1: 分数差不够时没有平价换基', () => {
  const r = scoreRadar({ etfs: { A: etf('A', 10.2), B: etf('B', 10) }, date: 'd' });
  assert.equal(r.parityPair, null);
  assert.deepEqual(r.parityPairs, []);
});

test('scoreRadar: 成本扣除后净价差 ≤ 0 时提示', () => {
  const r = scoreRadar({ etfs: { A: etf('A', 10.05, { bidAskSpreadBps: 20 }), B: etf('B', 10, { bidAskSpreadBps: 20 }) }, date: 'd' });
  assert.ok(r.pairs[0].netSpread < 0);
  assert.ok(r.pairs[0].reasons.includes('价差不够覆盖交易成本'));
});

test('readLimitHistory: 无 KV 绑定返回空；有绑定按日期升序', async () => {
  assert.deepEqual(await readLimitHistory({}, ['159513'], ['2026-10-23']), { 159513: [] });
  const store = {
    'etf-pcf:159513:20261022': { totalSubscribeLimitKind: 'limited', totalSubscribeLimitShares: 1e6 },
    'etf-pcf:159513:20261023': { totalSubscribeLimitKind: 'unlimited' },
  };
  const env = { FUND_LIMIT_KV: { get: async (key) => store[key] || null } };
  const r = await readLimitHistory(env, ['159513'], ['2026-10-23', '2026-10-22', '2026-10-21']);
  assert.deepEqual(r['159513'], [{ date: '2026-10-22', limit: 1e6 }, { date: '2026-10-23', limit: Infinity }]);
});

test('buildRadarSeries: 不设限记为 -1，缺失为 null', () => {
  const s = buildRadarSeries(
    [{ date: 'd1', etfs: { 159513: { price: 1.7, latestNav: 1.6, premium: 6.25 } } }],
    { 159513: [{ date: 'd1', limit: Infinity }] }
  );
  assert.deepEqual(s.dates, ['d1']);
  assert.deepEqual(s.etfs['159513'], { sell: [null], buy: [null], price: [1.7], nav: [1.6], premium: [6.25], limit: [-1] });
  assert.deepEqual(s.etfs['159941'].limit, [null]);
});
