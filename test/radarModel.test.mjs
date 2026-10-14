import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RADAR_SESSION,
  countdownSeconds,
  countdownView,
  computedAtEpoch,
  computedAtRiskNote,
  expectedPipelineStage,
  expectedSnapshotDate,
  formatCountdown,
  nextScheduledCompute,
  percentileView,
  radarSession,
  rankRadarEtfs,
  rotationAdvice,
  recentOpportunities,
  maturityView,
  shanghaiDateParts,
  shanghaiTimeStr,
  snapshotFreshness,
  validBestPair,
  validRadarEtfs,
  validateRadarSnapshot,
  candidatePair,
  lowestPremiumEtf,
  RADAR_FRESHNESS,
  RADAR_PIPELINE_STAGES
} from '../src/app/radarModel.js';

/** 北京时间 y-mo-d h:mi:s（含毫秒）→ epoch ms；全部用 UTC 构造，进程时区无关。 */
const at = (y, mo, d, h, mi = 0, s = 0, ms = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s, ms);

function snapshot(overrides = {}) {
  return {
    date: '2026-10-13',
    computedAt: '2026-10-13T13:36:05.000Z',
    premiumSource: 'eastmoney-fundmobapi-nav',
    etfs: [
      { code: '159659', name: '招商纳斯达克100ETF', premium: 8.42 },
      { code: '159941', name: '广发纳斯达克100ETF', premium: 6.88 },
      { code: '513100', name: '国泰纳斯达克100ETF', premium: 3.11 },
      { code: '159696', name: '易方达纳斯达克100ETF', premium: -0.5 }
    ],
    bestPair: {
      sell: { code: '159659', name: '招商纳斯达克100ETF', premium: 8.42 },
      buy: { code: '159696', name: '易方达纳斯达克100ETF', premium: -0.5 },
      spread: 8.92,
      percentile: 92,
      historyDays: 20
    },
    recentOpportunities: [
      { date: '2026-10-13', pair: '159659 → 159696', spread: 8.92 },
      { date: '2026-10-12', pair: '159659 → 159941', spread: 6.4 }
    ],
    maturity: {
      days: 23,
      level: 4,
      label: '较稳定',
      dots: '●●●●○',
      enabledWeights: {
        base: ['规模', '当前流动性'],
        premiumStats20: ['PremiumStd20'],
        liquidityStats30: []
      }
    },
    ...overrides
  };
}

test('shanghai date parts only shift by UTC+8 and never read local timezone', () => {
  const t = at(2026, 10, 14, 10, 30, 5);
  assert.deepEqual(shanghaiDateParts(t).dateStr, '2026-10-14');
  assert.equal(shanghaiTimeStr(t), '10:30:05');
  // 午夜边界：上海 00:00:00 对应 UTC 前一天 16:00。
  const midnight = at(2026, 10, 14, 0, 0, 0);
  assert.equal(new Date(midnight).toISOString(), '2026-10-13T16:00:00.000Z');
  assert.deepEqual(shanghaiDateParts(midnight).dateStr, '2026-10-14');
});

test('session boundaries: 09:30/15:00/21:35 with second precision, lunch stays risk window', () => {
  const day = (h, m, s) => radarSession(at(2026, 10, 14, h, m, s)); // 周三，交易日
  assert.equal(day(0, 0, 0).key, RADAR_SESSION.PRE_MARKET);
  assert.equal(day(9, 29, 59).key, RADAR_SESSION.PRE_MARKET);
  assert.equal(day(9, 30, 0).key, RADAR_SESSION.INTRADAY_RISK);
  assert.equal(day(11, 30, 0).key, RADAR_SESSION.INTRADAY_RISK); // 午休仍属风险窗口
  assert.equal(day(13, 0, 0).key, RADAR_SESSION.INTRADAY_RISK);
  assert.equal(day(14, 59, 59).key, RADAR_SESSION.INTRADAY_RISK);
  assert.equal(day(15, 0, 0).key, RADAR_SESSION.WAIT_NAV);
  assert.equal(day(21, 34, 59).key, RADAR_SESSION.WAIT_NAV);
  assert.equal(day(21, 35, 0).key, RADAR_SESSION.POST_CLOSE);
  assert.equal(day(23, 59, 59).key, RADAR_SESSION.POST_CLOSE);
  const intraday = day(10, 30, 0);
  assert.equal(intraday.tradingDay, true);
  assert.equal(intraday.computeLevel, 'risk');
  assert.equal(day(16, 0, 0).computeLevel, 'wait');
  assert.equal(day(22, 0, 0).computeLevel, 'regular');
  assert.equal(day(8, 0, 0).computeLevel, 'risk');
});

test('non-trading day grading: weekend, statutory holiday, unknown calendar year', () => {
  const saturday = radarSession(at(2026, 10, 17, 10, 30, 0));
  assert.equal(saturday.key, RADAR_SESSION.MARKET_CLOSED);
  assert.equal(saturday.tradingDay, false);
  assert.equal(saturday.computeLevel, 'risk');
  const holiday = radarSession(at(2026, 10, 1, 10, 30, 0)); // 国庆
  assert.equal(holiday.key, RADAR_SESSION.MARKET_CLOSED);
  assert.equal(holiday.calendarConfirmed, true);
  // 2027 假期表缺失：工作日不得视为已确认交易日。
  const unconfirmed = radarSession(at(2027, 1, 4, 10, 30, 0)); // 周一
  assert.equal(unconfirmed.key, RADAR_SESSION.CALENDAR_UNCONFIRMED);
  assert.equal(unconfirmed.calendarConfirmed, false);
  assert.equal(unconfirmed.tradingDay, false);
  assert.equal(unconfirmed.computeLevel, 'risk');
  const unconfirmedSunday = radarSession(at(2027, 1, 3, 10, 30, 0));
  assert.equal(unconfirmedSunday.key, RADAR_SESSION.MARKET_CLOSED);
});

test('countdown targets natural-day 21:35 with exact rollover display', () => {
  // 精确到达 21:35:00.000 → 滚动到次日并显示 24:00:00；前一秒为 00:00:01。
  assert.equal(formatCountdown(countdownSeconds(at(2026, 10, 14, 21, 35, 0, 0))), '24:00:00');
  assert.equal(formatCountdown(countdownSeconds(at(2026, 10, 14, 21, 34, 59, 0))), '00:00:01');
  const before = countdownView(at(2026, 10, 14, 10, 0, 0));
  assert.equal(before.isToday, true);
  assert.equal(before.dateStr, '2026-10-14');
  assert.equal(before.maySkip, false);
  assert.equal(before.label, '距今日 21:35 计划触发');
  const after = countdownView(at(2026, 10, 14, 22, 0, 0));
  assert.equal(after.isToday, false);
  assert.equal(after.dateStr, '2026-10-15');
  assert.equal(after.label, '距明日 21:35 计划触发');
});

test('countdown rollover covers month end, year end and leap day via UTC calendar math', () => {
  assert.equal(nextScheduledCompute(at(2026, 10, 31, 22, 0, 0)).dateStr, '2026-11-01');
  const newYear = nextScheduledCompute(at(2026, 12, 31, 23, 0, 0));
  assert.equal(newYear.dateStr, '2027-01-01');
  assert.equal(newYear.maySkip, true); // 自然日目标，且 2027 日历未确认
  assert.equal(nextScheduledCompute(at(2028, 2, 28, 23, 0, 0)).dateStr, '2028-02-29'); // 闰日进位
  // 周五夜间 → 周六（自然日），不是下周一的交易日；附“可能不执行”提示。
  const fridayNight = nextScheduledCompute(at(2026, 10, 16, 22, 0, 0));
  assert.equal(fridayNight.dateStr, '2026-10-17');
  assert.equal(fridayNight.maySkip, true);
  assert.equal(formatCountdown(countdownSeconds(at(2026, 10, 16, 22, 0, 0))), '23:35:00');
});

test('expected snapshot date follows the local trading calendar, not browser today', () => {
  // 交易日 21:35 前预期上一交易日；之后预期当天。
  assert.equal(expectedSnapshotDate(at(2026, 10, 14, 10, 0, 0)), '2026-10-13');
  assert.equal(expectedSnapshotDate(at(2026, 10, 14, 21, 34, 59)), '2026-10-13');
  assert.equal(expectedSnapshotDate(at(2026, 10, 14, 21, 35, 0)), '2026-10-14');
  // 休市日预期最近交易日。
  assert.equal(expectedSnapshotDate(at(2026, 10, 17, 10, 0, 0)), '2026-10-16'); // 周六 → 周五
  assert.equal(expectedSnapshotDate(at(2026, 10, 8, 10, 0, 0)), '2026-09-30'); // 国庆后首个交易日
  assert.equal(expectedSnapshotDate(at(2026, 10, 9, 10, 0, 0)), '2026-10-08');
});

test('freshness uses data.date only: missing, malformed, future, stale and on-expected', () => {
  const evening = at(2026, 10, 14, 22, 0, 0);
  assert.deepEqual(
    { status: snapshotFreshness({ date: '2026-10-14' }, evening).status },
    { status: RADAR_FRESHNESS.OK }
  );
  const stale = snapshotFreshness({ date: '2026-10-09' }, evening);
  assert.equal(stale.status, RADAR_FRESHNESS.STALE);
  assert.equal(stale.label, '待更新');
  assert.equal(stale.expectedDate, '2026-10-14');
  const future = snapshotFreshness({ date: '2026-10-15' }, evening);
  assert.equal(future.status, RADAR_FRESHNESS.ANOMALY);
  assert.equal(future.label, '日期异常');
  const malformed = snapshotFreshness({ date: '2026/10/14' }, evening);
  assert.equal(malformed.status, RADAR_FRESHNESS.ANOMALY);
  const missing = snapshotFreshness({}, evening);
  assert.equal(missing.status, RADAR_FRESHNESS.UNKNOWN);
  assert.equal(missing.label, '基准日期未知');
  // 旧数据不会因读取成功而变“新鲜”：10-14 盘中，10-13 快照仍是预期基准（ok），
  // 更早的快照才是待更新；到了 10-14 计划窗口之后，10-13 变为待更新。
  const morning = at(2026, 10, 14, 10, 0, 0);
  assert.equal(snapshotFreshness({ date: '2026-10-13' }, morning).status, RADAR_FRESHNESS.OK);
  assert.equal(snapshotFreshness({ date: '2026-10-09' }, morning).status, RADAR_FRESHNESS.STALE);
  assert.equal(snapshotFreshness({ date: '2026-10-13' }, evening).status, RADAR_FRESHNESS.STALE);
});

test('computedAt parses safely and flags pre-market / intraday computations without certifying data', () => {
  assert.equal(computedAtEpoch({ computedAt: '2026-10-13T13:36:05.000Z' }), Date.parse('2026-10-13T13:36:05.000Z'));
  assert.equal(computedAtEpoch({ computedAt: 'not-a-date' }), null);
  assert.equal(computedAtEpoch({}), null);
  // 2026-10-14 10:30 北京时间 = 02:30 UTC，处于盘中。
  assert.match(computedAtRiskNote({ computedAt: '2026-10-14T02:30:00.000Z' }), /盘中/);
  assert.match(computedAtRiskNote({ computedAt: '2026-10-14T00:30:00.000Z' }), /盘前/);
  assert.equal(computedAtRiskNote({ computedAt: '2026-10-14T13:36:00.000Z' }), '');
  assert.equal(computedAtRiskNote({ computedAt: '2026-10-17T02:30:00.000Z' }), ''); // 周六不算盘中
});

test('snapshot validation: source gate, collection shape, lenient optional fields', () => {
  assert.equal(validateRadarSnapshot(snapshot()), true);
  assert.equal(validateRadarSnapshot(snapshot({ premiumSource: 'other' })), false);
  assert.equal(validateRadarSnapshot(snapshot({ premiumSource: undefined })), false);
  assert.equal(validateRadarSnapshot(snapshot({ date: undefined })), true); // 缺日期局部降级
  assert.equal(validateRadarSnapshot(snapshot({ etfs: undefined })), false);
  assert.equal(validateRadarSnapshot(snapshot({ etfs: [] })), false);
  assert.equal(validateRadarSnapshot(null), false);
  assert.equal(validateRadarSnapshot([snapshot()]), false);
  // 单行缺失字段被过滤而不是补 0：负溢价、非有限值。
  const mixed = snapshot({
    etfs: [
      { code: '159659', name: '招商纳斯达克100ETF', premium: 8.42 },
      { code: '159941', name: '广发纳斯达克100ETF', premium: 'NaN' },
      { code: '', premium: 1 },
      { code: '159696', name: '易方达纳斯达克100ETF', premium: -0.5 }
    ]
  });
  assert.deepEqual(
    validRadarEtfs(mixed).map((e) => e.code),
    ['159659', '159696']
  );
});

test('ranking keeps actual N with stable code tiebreak and valid-set-only candidates', () => {
  const data = snapshot({
    etfs: [
      { code: '513100', name: '国泰纳斯达克100ETF', premium: 3.2 },
      { code: '159659', name: '招商纳斯达克100ETF', premium: 8.4 },
      { code: '159941', name: '广发纳斯达克100ETF', premium: 3.2 },
      { code: '159696', name: '易方达纳斯达克100ETF', premium: -0.5 }
    ]
  });
  const ranked = rankRadarEtfs(data);
  assert.deepEqual(
    ranked.map((e) => e.code),
    ['159659', '159941', '513100', '159696']
  ); // 并列 3.2 按代码升序
  const pair = candidatePair(data);
  assert.equal(pair.sell.code, '159659');
  assert.equal(pair.buy.code, '159696');
  assert.equal(lowestPremiumEtf(data).code, '159696');
  // 单标的不产生套利对。
  assert.equal(candidatePair({ ...data, etfs: [data.etfs[0]] }), null);
  // 全部相同溢价可正常显示：按代码稳定排序取两端。
  const same = snapshot({
    etfs: [
      { code: 'B', premium: 1 },
      { code: 'A', premium: 1 },
      { code: 'C', premium: 1 }
    ]
  });
  const samePair = candidatePair(same);
  assert.equal(samePair.sell.code, 'A');
  assert.equal(samePair.buy.code, 'C');
});

test('best pair degrades to null on invalid shape; percentile keeps 5-day gate and 85 attention', () => {
  assert.equal(validBestPair({}), null);
  assert.equal(validBestPair(null), null);
  assert.equal(validBestPair(snapshot({ bestPair: { sell: { code: 'a' }, buy: { code: 'b' } } })), null);
  assert.equal(
    validBestPair(snapshot({ bestPair: { sell: { code: 'a', premium: 1 }, buy: { code: 'b', premium: 'x' }, spread: 1 } })),
    null
  );
  const pair = validBestPair(snapshot());
  assert.equal(pair.spread, 8.92);
  assert.equal(pair.historyDays, 20);
  // 分位门槛：4 天不显示，5 天显示；84 不提示，85 提示；缺失不是 0 分位。
  assert.equal(percentileView(snapshot({ bestPair: { ...snapshot().bestPair, historyDays: 4 } })).visible, false);
  const five = percentileView(snapshot({ bestPair: { ...snapshot().bestPair, historyDays: 5, percentile: 84 } }));
  assert.equal(five.visible, true);
  assert.equal(five.attention, false);
  const hot = percentileView(snapshot({ bestPair: { ...snapshot().bestPair, historyDays: 5, percentile: 85 } }));
  assert.equal(hot.attention, true);
  const missingPct = percentileView(
    snapshot({ bestPair: { ...snapshot().bestPair, percentile: null } })
  );
  assert.equal(missingPct.visible, true);
  assert.equal(missingPct.percentile, null);
  assert.equal(missingPct.attention, false);
  assert.equal(percentileView({}).visible, false);
});

test('rotation advice derives from current snapshot premium with cost caveat, lowest needs no switch', () => {
  const data = snapshot();
  const advice = rotationAdvice(data, '159659');
  assert.equal(advice.isLowest, false);
  assert.equal(advice.selected.code, '159659');
  assert.equal(advice.lowest.code, '159696');
  assert.equal(advice.spreadPoints, 8.92);
  assert.match(advice.note, /未计交易成本/);
  const lowest = rotationAdvice(data, '159696');
  assert.equal(lowest.isLowest, true);
  assert.match(lowest.note, /已是当前有效标的中最低溢价/);
  assert.equal(rotationAdvice(data, '999999'), null);
  assert.equal(rotationAdvice(data, null), null);
});

test('maturity and recent opportunities degrade safely without extra requests', () => {
  const view = maturityView(snapshot());
  assert.equal(view.days, 23);
  assert.equal(view.label, '较稳定');
  assert.equal(view.enabledCount, 2); // base 与 premiumStats20 有条目，liquidityStats30 空
  assert.deepEqual(view.groups[2].items, []);
  assert.equal(maturityView({}), null);
  assert.equal(maturityView({ maturity: { enabledWeights: null } }).enabledCount, 0);
  const recent = recentOpportunities(snapshot());
  assert.equal(recent.length, 2);
  assert.equal(recent[0].pair, '159659 → 159696');
  assert.deepEqual(recentOpportunities({}), []);
  assert.deepEqual(
    recentOpportunities({ recentOpportunities: [{ date: 'bad' }, { date: '2026-10-12', pair: 5, spread: 'x' }, null] }),
    [{ date: '2026-10-12', pair: '—', spread: null }]
  );
});

test('expected pipeline stage only marks time-based expectations', () => {
  const day = (h, m, s = 0) => expectedPipelineStage(at(2026, 10, 14, h, m, s));
  assert.equal(day(14, 59, 59), 0);
  assert.equal(day(15, 0, 0), 1);
  assert.equal(day(20, 59, 59), 1);
  assert.equal(day(21, 0, 0), 2);
  assert.equal(day(21, 34, 59), 2);
  assert.equal(day(21, 35, 0), 3);
  assert.equal(day(21, 35, 59), 3);
  assert.equal(day(21, 36, 0), 4);
  assert.equal(RADAR_PIPELINE_STAGES.length, 4);
  assert.equal(RADAR_PIPELINE_STAGES[2].time, '21:35');
});
