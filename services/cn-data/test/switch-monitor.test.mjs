import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openDb } from '../src/db.js';
import { isInTradingSession, evaluateSwitchTriggers, normalizeSwitchConfig } from '../src/notify/switchStrategyPort.js';
import { buildRuleSnapshot, buildSwitchTriggerNotification, listMonitorClients, processClient, readMonitorState, runMonitorTick, fetchMarketFunds, hasConfirmedPushDelivery, deliverSwitchNotification, switchKeyOwner } from '../src/notify/switchMonitor.js';
import { deliverTestNotification } from '../src/notify/testDelivery.js';

const computedAt = '2026-10-12T02:00:00.000Z';
const rule = { id: 'r1', name: '测试规则', enabled: true, benchmarkCodes: ['513100'], enabledCodes: ['159632'], premiumClass: { '513100': 'H', '159632': 'L' }, intraSellLowerPct: 1, intraBuyOtherPct: 3 };
const config = { enabled: true, rules: [rule], activeRuleId: 'r1' };
const funds = { '513100': { name: '高基', premiumPct: 15, valid: false }, '159632': { name: '低基', premiumPct: 12, valid: false } };
function memory(t) { const db = openDb(':memory:'); t.after(() => db.close()); return db; }
function seed(db, clientId = 'clientA', value = config, owner = 'user') {
  db.prepare(`INSERT INTO notify_user_records(owner_user_id,record_type,record_id,payload,revision,created_at,updated_at) VALUES (?,'user-kv',?,?,1,?,?)`).run(owner, `switch:config:${clientId}`, typeof value === 'string' ? value : JSON.stringify(value), computedAt, computedAt);
}
function storedSnapshot(db, clientId = 'clientA') { return JSON.parse(db.prepare(`SELECT payload FROM notify_user_records WHERE record_type='user-kv' AND record_id=?`).get(`switch:snapshot:${clientId}`).payload); }
function minimalSnapshot(date = computedAt) {
  return { computedAt: date, intraSellLowerPct: 1, intraBuyOtherPct: 3, premiumClass: rule.premiumClass,
    byBenchmark: [{ benchmarkCode: '513100', benchmarkName: '高基', benchmarkPremiumPct: 15,
      candidates: [{ code: '159632', name: '低基', premiumPct: 12, spreadVsBenchmarkPct: 3 }] }] };
}

test('trading sessions use Shanghai weekdays and inclusive session boundaries', () => {
  for (const [date, expected] of [
    ['2026-10-12T02:00:00Z', true], ['2026-10-12T04:00:00Z', false],
    ['2026-10-12T01:29:00Z', false], ['2026-10-12T07:01:00Z', false],
    ['2026-10-17T02:00:00Z', false], ['2026-10-18T02:00:00Z', false],
    ['2026-10-12T01:30:00Z', true], ['2026-10-12T03:30:00Z', true],
    ['2026-10-12T05:00:00Z', true], ['2026-10-12T07:00:00Z', true]
  ]) assert.equal(isInTradingSession(new Date(date)), expected, date);
});

test('worker evaluator triggers B at equality, caps at three and resets next day', () => {
  let prev = {};
  for (let count = 1; count <= 4; count++) {
    const result = evaluateSwitchTriggers(minimalSnapshot(), prev);
    assert.equal(result.triggers.length, count <= 3 ? 1 : 0);
    assert.equal(result.nextTriggerStates['513100:159632'].dailyTriggerCount, Math.min(count, 3));
    if (count <= 3) assert.equal(result.triggers[0].rule, 'B');
    prev = result.nextTriggerStates;
  }
  const next = evaluateSwitchTriggers(minimalSnapshot('2026-10-13T02:00:00Z'), prev);
  assert.equal(next.triggers.length, 1);
  assert.equal(next.nextTriggerStates['513100:159632'].dailyTriggerCount, 1);
});

test('worker evaluator triggers A for L to H with a narrow gap and preserves missing-data counts', () => {
  const snapshot = minimalSnapshot();
  snapshot.premiumClass = { '513100': 'L', '159632': 'H' };
  snapshot.byBenchmark[0].candidates[0].spreadVsBenchmarkPct = -0.5;
  const result = evaluateSwitchTriggers(snapshot);
  assert.equal(result.triggers[0].rule, 'A');
  assert.equal(result.triggers[0].gapPct, 0.5);
  snapshot.byBenchmark[0].candidates[0].spreadVsBenchmarkPct = null;
  const missing = evaluateSwitchTriggers(snapshot, result.nextTriggerStates);
  assert.equal(missing.triggers.length, 0);
  assert.deepEqual(missing.nextTriggerStates, result.nextTriggerStates);
});

test('v4 notification keeps worker text, tagged event ID, premiums and cn links', () => {
  const snapshot = buildRuleSnapshot(normalizeSwitchConfig(config).rules[0], funds, computedAt);
  const trigger = { ...evaluateSwitchTriggers(snapshot).triggers[0], ruleId: 'r1', ruleName: '测试规则', pairKey: 'r1:513100:159632' };
  const notification = buildSwitchTriggerNotification(snapshot, trigger);
  assert.equal(notification.title, '切换 B 高→低 | 513100→159632');
  assert.equal(notification.body, 'H−L +3.00% > 3%\n卖 513100 高基 → 买 159632 低基\n下单前请以基金软件实时溢价为准。\n点此查看策略详情。');
  assert.equal(notification.body_md, '**H−L +3.00%** > 3%\n卖 **513100 高基** → 买 **159632 低基**\n*点此查看策略详情，下单前请以基金软件实时溢价为准。*');
  assert.equal(notification.eventId, 'switch:r1:513100:159632:RB:2026-10-12T02:00');
  assert.equal(notification.fromPremiumPct, 15);
  assert.equal(notification.toPremiumPct, 12);
  assert.equal(notification.ruleId, 'switch:r1:513100');
  assert.equal(notification.strategyName, '场内切换 · 测试规则');
  assert.equal(notification.url, 'https://fast.freebacktrack.tech/markets?code=513100&source=switch-strategy');
  assert.deepEqual(notification.links, { web: notification.url, app: '', miniProgram: '' });
  assert.deepEqual(notification.params, { code: '513100', targetCode: '159632', trigger: 'switch-threshold', rule: 'B' });
});

test('collector premiums remain usable when valid is false; classified pool includes benchmarks', () => {
  const snapshot = buildRuleSnapshot({ ...rule, benchmarkCodes: ['513100', '513101'], enabledCodes: ['159632', '159633'], premiumClass: { ...rule.premiumClass, '513101': 'H' } }, { ...funds, '513101': { premiumPct: 10 }, '159633': { premiumPct: '9' } }, computedAt);
  assert.deepEqual(snapshot.byBenchmark[0].candidates.map((entry) => entry.code), ['513101', '159632']);
  assert.equal(snapshot.byBenchmark[0].candidates[1].valid, false);
  assert.equal(evaluateSwitchTriggers(snapshot).triggers.length, 1);
  assert.equal(snapshot.otcSignal.lowestPremiumPct, 12);
  assert.equal(buildRuleSnapshot(rule, {}, computedAt).ready, false);
  const unclassified = buildRuleSnapshot({ ...rule, premiumClass: {} }, funds, computedAt);
  assert.equal(unclassified.byBenchmark[0].candidates.length, 1);
});

test('OTC strong and weak notifications use worker format and thresholds', () => {
  for (const [premiumPct, kind, level] of [[0.5, 'OTC_STRONG', '强信号'], [1.5, 'OTC_WEAK', '弱信号']]) {
    const snapshot = buildRuleSnapshot(rule, { ...funds, '159632': { name: '低基', premiumPct } }, computedAt);
    assert.equal(snapshot.otcSignal.rule, kind);
    const trigger = evaluateSwitchTriggers(snapshot).triggers.find((entry) => entry.kind === 'otc');
    const notification = buildSwitchTriggerNotification(snapshot, { ...trigger, ruleId: 'r1', pairKey: `r1:${trigger.pairKey}` });
    assert.equal(notification.title, `场外切换 ${level} | 513100→场外QDII`);
    assert.equal(notification.eventId, `switch:r1:otc:513100:159632:R${kind}:2026-10-12T02:00`);
    assert.match(notification.body, /参考低溢价 159632 低基\n点此查看策略详情/);
    assert.equal(notification.params.trigger, 'switch-otc');
  }
});

test('listMonitorClients filters disabled, invalid and non-runnable configurations', (t) => {
  const db = memory(t);
  seed(db);
  seed(db, 'disabled', { ...config, enabled: false });
  seed(db, 'broken', '{');
  seed(db, 'empty', { enabled: true });
  const clients = listMonitorClients(db);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].clientId, 'clientA');
  assert.equal(clients[0].ownerUserId, 'user');
  assert.equal(switchKeyOwner('account:user'), 'user');
  assert.equal(switchKeyOwner('clientA'), 'legacy:clientA');
});

test('processClient persists only delivered counts, caps at three and saves frontend snapshot', async (t) => {
  const db = memory(t), calls = [];
  const deliver = async (_db, account, notification) => { calls.push({ account, notification }); return { delivered: true }; };
  for (let count = 1; count <= 4; count++) {
    const result = await processClient(db, 'user', 'clientA', config, funds, { computedAt, deliver });
    assert.equal(result.pushed, count <= 3 ? 1 : 0);
    assert.equal(result.deliveryAttempts, count <= 3 ? 1 : 0);
    assert.equal(readMonitorState(db, 'user', 'clientA').triggerStatesByRule.r1['513100:159632'].dailyTriggerCount, Math.min(count, 3));
    assert.equal(storedSnapshot(db).todayTriggerCount, Math.min(count, 3));
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].account, { userId: 'user', clientId: 'clientA' });
  assert.equal(calls[0].notification.eventId, 'switch:r1:513100:159632:RB:2026-10-12T02:00');
});

test('unconfirmed and thrown deliveries preserve counters so later success retries', async (t) => {
  const db = memory(t);
  await processClient(db, 'user', 'clientA', config, funds, { computedAt, deliver: async () => ({ delivered: false }) });
  assert.equal(readMonitorState(db, 'user', 'clientA').triggerStatesByRule.r1['513100:159632'].dailyTriggerCount, 0);
  assert.equal(storedSnapshot(db).todayTriggerCount, 0);
  const result = await processClient(db, 'user', 'clientA', config, funds, { computedAt, deliver: async () => ({ delivered: true }) });
  assert.equal(result.pushed, 1);
  await processClient(db, 'user', 'clientA', config, funds, { computedAt, deliver: async () => { throw new Error('test delivery failure'); } });
  assert.equal(readMonitorState(db, 'user', 'clientA').triggerStatesByRule.r1['513100:159632'].dailyTriggerCount, 1);
});

test('multiple rules retain active snapshot and independent daily counts', async (t) => {
  const db = memory(t);
  const multi = { ...config, activeRuleId: 'r2', rules: [rule, { ...rule, id: 'r2', name: '第二规则' }] };
  const result = await processClient(db, 'user', 'clientA', multi, funds, { computedAt, deliver: async (_db, _account, notification) => ({ delivered: notification.ruleId.includes(':r2:') }) });
  assert.equal(result.triggered, 2);
  assert.equal(result.pushed, 1);
  const snapshot = storedSnapshot(db);
  assert.equal(snapshot.ruleId, 'r2');
  assert.equal(snapshot.triggers.length, 2);
  assert.deepEqual(snapshot.rules.map((entry) => entry.todayTriggerCount), [0, 1]);
  assert.equal(snapshot.rules[1].snapshot.todayTriggerCount, 1);
});

test('runMonitorTick skips outside session without fetching and processes configured clients', async (t) => {
  const db = memory(t);
  let fetched = 0;
  const fetchMarket = async (codes) => { fetched++; assert.deepEqual(codes, ['513100', '159632']); return { funds }; };
  const skipped = await runMonitorTick(db, { now: new Date('2026-10-12T04:00:00Z'), fetchMarket });
  assert.equal(skipped.skipped, 'outside-trading-session');
  assert.equal(fetched, 0);
  assert.equal((await runMonitorTick(db, { now: new Date(computedAt), fetchMarket })).skipped, 'no-switch-clients');
  seed(db);
  const result = await runMonitorTick(db, { now: new Date(computedAt), fetchMarket, deliver: async () => ({ delivered: true }) });
  assert.equal(fetched, 1);
  assert.equal(result.clientCount, 1);
  assert.equal(result.triggered, 1);
  assert.equal(result.pushed, 1);
  const failed = await runMonitorTick(db, { now: new Date(computedAt), fetchMarket: async () => { throw new Error('collector unavailable'); } });
  assert.deepEqual(failed, { skipped: 'market-fetch-failed', message: 'collector unavailable' });
});

test('fetchMarketFunds chunks over thirty codes and merges every batch', async (t) => {
  const original = globalThis.fetch, batches = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const codes = new URL(url).searchParams.get('codes').split(',');
    batches.push(codes);
    return Response.json({ generatedAt: computedAt, items: codes.map((code) => ({ code, premiumPercent: 3, quality: { status: 'ok' } })) });
  };
  const codes = Array.from({ length: 65 }, (_, index) => String(510000 + index));
  const result = await fetchMarketFunds([...codes, codes[0], 'invalid']);
  assert.deepEqual(batches.map((batch) => batch.length), [30, 30, 5]);
  assert.equal(Object.keys(result.funds).length, 65);
  assert.equal(result.generatedAt, computedAt);
});

test('confirmed delivery matches worker channel semantics', () => {
  for (const [channel, status, expected] of [['bark', 'delivered', true], ['email', 'delivered', true], ['ws', 'delivered', true], ['serverchan3', 'delivered', true], ['pc', 'queued', true], ['email', 'queued', false], ['pc', 'delivered', false], ['other', 'delivered', false], ['email', 'failed', false]]) {
    assert.equal(hasConfirmedPushDelivery({ summary: { events: [{ channels: [{ channel, status }] }] } }), expected);
  }
});

test('real monitor delivery adapts summary and stores reason; manual test stays unchanged', async (t) => {
  const db = memory(t);
  const notification = buildSwitchTriggerNotification(minimalSnapshot(), { ...evaluateSwitchTriggers(minimalSnapshot()).triggers[0], pairKey: 'r1:513100:159632' });
  const result = await deliverSwitchNotification(db, { userId: 'user', clientId: 'clientA' }, notification);
  assert.equal(result.delivered, true);
  assert.equal(result.result.events[0].reason, 'switch-strategy-trigger');
  assert.ok(result.result.events[0].channels.some((entry) => entry.channel === 'pc' && entry.status === 'queued'));
  const manual = await deliverTestNotification(db, { userId: 'user', clientId: 'clientA' }, notification, ['pc']);
  assert.equal(manual.events[0].reason, 'manual-test');
});

test('standalone cron logs JSON and exits nonzero on database open failure', () => {
  const normal = spawnSync(process.execPath, ['src/notify/switchMonitorCron.js'], { encoding: 'utf8', env: { ...process.env, CN_DATA_DB_PATH: ':memory:', SWITCH_MONITOR_FORCE: '1' } });
  assert.equal(normal.status, 0, normal.stderr);
  const summary = JSON.parse(normal.stdout.trim().replace('[switch-monitor] ', ''));
  assert.equal(summary.skipped, 'no-switch-clients');
  const failed = spawnSync(process.execPath, ['src/notify/switchMonitorCron.js'], { encoding: 'utf8', env: { ...process.env, CN_DATA_DB_PATH: '/dev/null/cn-data.db' } });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /\[switch-monitor\] fatal/);
});
