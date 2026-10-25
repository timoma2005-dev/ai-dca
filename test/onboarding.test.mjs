import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ONBOARDING_STORAGE_PREFIX,
  currentOnboardingAccount,
  markOnboardingTask,
  readOnboardingState,
  writeOnboardingState
} from '../src/app/onboarding/state.js';
import { hasHoldingRecords, hasNotifyChannel, hasSavedSwitchRule, readOnboardingSignals, SIGNAL_KEYS } from '../src/app/onboarding/signals.js';
import { ONBOARDING_FLOWS, USER_TASKS, buildOnboardingTasks, shouldShowGettingStarted } from '../src/app/onboarding/catalog.js';
import { computeHintPosition } from '../src/app/onboarding/hintPosition.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => Object.fromEntries(data)
  };
}

test('进度按账号分区：游客与各账号互不影响', () => {
  const ls = memoryStorage({ aiDcaCloudSyncSession: JSON.stringify({ accessToken: 't', username: 'Alice' }) });
  assert.equal(currentOnboardingAccount(ls), 'alice');
  writeOnboardingState({ dismissed: true }, 'alice', ls);
  assert.equal(readOnboardingState('alice', ls).dismissed, true);
  assert.equal(readOnboardingState('bob', ls).dismissed, false);
  assert.equal(readOnboardingState('guest', ls).dismissed, false);
  assert.equal(currentOnboardingAccount(memoryStorage()), 'guest');
  assert.ok(ls.dump()[`${ONBOARDING_STORAGE_PREFIX}alice`]);
});

test('markOnboardingTask 只记录首次完成时间，重复事件不改写', () => {
  const ls = memoryStorage();
  markOnboardingTask('switch', { now: 100, account: 'a', ls });
  markOnboardingTask('switch', { now: 200, account: 'a', ls });
  assert.equal(readOnboardingState('a', ls).done.switch, 100);
  assert.equal(markOnboardingTask('', { account: 'a', ls }), null);
});

test('损坏的进度数据回退为空状态', () => {
  const ls = memoryStorage({ [`${ONBOARDING_STORAGE_PREFIX}a`]: '{oops' });
  assert.deepEqual(readOnboardingState('a', ls), { dismissed: false, celebrated: false, seenDemo: false, seenNotifyDemo: false, done: {} });
});

test('信号：持仓、已保存切换方案、通知通道按真实本地数据判断', () => {
  assert.equal(hasHoldingRecords({ transactions: [{ code: '513100' }] }, null), true);
  assert.equal(hasHoldingRecords({ transactions: [] }, { rows: [{ code: '1', shares: 0 }] }), false);
  // 默认空规则不算已保存
  assert.equal(hasSavedSwitchRule({ rules: [{ id: 'rule-1', benchmarkCodes: [], enabledCodes: [] }] }), false);
  assert.equal(hasSavedSwitchRule({ rules: [{ benchmarkCodes: ['513100'], enabledCodes: ['159513'] }] }), true);
  assert.equal(hasNotifyChannel({ barkDeviceKey: 'abc' }), true);
  assert.equal(hasNotifyChannel({ serverChan3Uid: '1' }), false);
  assert.equal(hasNotifyChannel({ serverChan3Uid: '1', serverChan3SendKey: 'k' }), true);
});

test('信号：演示持仓不算真实录入；没有存储时全部未完成', () => {
  const ledger = JSON.stringify({ transactions: [{ code: '513100' }] });
  const real = memoryStorage({ [SIGNAL_KEYS.ledger]: ledger });
  assert.equal(readOnboardingSignals({ storage: real }).holdings, true);
  const demo = memoryStorage({ [SIGNAL_KEYS.ledger]: ledger, [SIGNAL_KEYS.demoMarker]: JSON.stringify({ at: 1 }) });
  assert.equal(readOnboardingSignals({ storage: demo }).holdings, false);
  assert.deepEqual(readOnboardingSignals({ storage: memoryStorage() }), { holdings: false, switch: false, notify: false });
});

test('任务卡：游客第一项是注册，登录用户按 切换方案 → 通知 → 持仓（可选）', () => {
  const guest = buildOnboardingTasks({ loggedIn: false });
  assert.equal(guest.mode, 'guest');
  assert.deepEqual(guest.items.map((item) => item.id), ['register', 'demo', 'demoNotify']);
  const user = buildOnboardingTasks({ loggedIn: true, signals: { holdings: true } });
  assert.deepEqual(user.items.map((item) => item.id), ['switch', 'notify', 'holdings']);
  assert.equal(user.items.find((item) => item.id === 'holdings').optional, true);
  assert.equal(user.total, 2, '可选的持仓不计入进度');
  assert.equal(user.doneCount, 0);
  assert.equal(user.activated, false);
  const half = buildOnboardingTasks({ loggedIn: true, signals: { switch: true } });
  assert.equal(half.doneCount, 1);
  assert.equal(half.activated, false, '切换方案和通知两步都完成才算用起来');
  const both = buildOnboardingTasks({ loggedIn: true, signals: { switch: true, notify: true } });
  assert.equal(both.activated, true);
  assert.equal(both.allDone, true);
});

test('任务卡：无权限的任务显示为锁定（打赏开通），可选任务不影响全部完成', () => {
  const accessOf = (tab) => ({ status: tab === 'fundSwitch' ? 'forbidden' : 'ok' });
  const tasks = buildOnboardingTasks({ loggedIn: true, signals: {}, accessOf });
  assert.equal(tasks.items.find((item) => item.id === 'switch').status, 'locked');
  const done = buildOnboardingTasks({ loggedIn: true, signals: { switch: true }, state: { done: { notify: 1 } } });
  assert.equal(done.allDone, true);
  assert.equal(shouldShowGettingStarted({ tasks: done, state: {} }), true, '全部完成先展示一次庆祝');
  assert.equal(shouldShowGettingStarted({ tasks: done, state: { celebrated: true } }), false);
  assert.equal(shouldShowGettingStarted({ tasks: done, state: { dismissed: true } }), false);
  assert.equal(shouldShowGettingStarted({ tasks: done, state: {}, demoActive: true }), false);
});

test('每条路径的步骤都有稳定 id 和页面里真实存在的 data-onboarding 目标', () => {
  const sources = [
    'src/pages/holdings/AggregateHoldingsTableSection.jsx',
    'src/pages/holdings/MobileHoldingsListSection.jsx',
    'src/pages/switch/SwitchStrategyMetricsBar.jsx',
    'src/pages/switch/SwitchStrategyRuleModal.jsx',
    'src/pages/NotifyConfigCard.jsx',
    'src/pages/markets/MarketsSidebar.jsx'
  ].map(read).join('\n');
  const ids = new Set();
  for (const task of USER_TASKS) assert.ok(ONBOARDING_FLOWS[task.flow], `${task.id} 缺少步骤`);
  for (const flow of Object.values(ONBOARDING_FLOWS)) {
    for (const step of flow.steps) {
      assert.ok(!ids.has(step.id), `重复 stepId ${step.id}`);
      ids.add(step.id);
      assert.ok(sources.includes(`data-onboarding="${step.target}"`), `找不到目标 ${step.target}`);
    }
  }
});

test('业务成功后才标记完成：切换方案保存、测试通知成功、加入自选', () => {
  assert.match(read('src/app/switchStrategySync.js'), /writeSwitchConfigCache\(stored\);\n\s+if \(hasSavedSwitchRule\(stored\)\) markOnboardingTask\('switch'\);/);
  assert.match(read('src/app/notifySync.js'), /\}\)\.then\(\(result\) => \{\n\s+markOnboardingTask\('notify'\);/);
  assert.match(read('src/app/marketsWatchlistStorage.js'), /saveWatchlist\(saved\);\n\s+markOnboardingTask\('watchlist'\);/);
  // 演示沙箱里的模拟保存不计入
  assert.match(read('src/app/onboarding/state.js'), /__AI_DCA_FEATURE_DEMO__\) return null;/);
});

test('步骤提示不加全屏遮罩、不替用户点保存；注册提示在提示进行中让路', () => {
  const host = read('src/components/onboarding/StepHintHost.jsx');
  assert.doesNotMatch(host, /\.click\(\)/);
  assert.doesNotMatch(host, /fixed inset-0/);
  assert.match(read('src/pages/WorkspacePage.jsx'), /if \(isOnboardingHintActive\(\)\) return;/);
});

test('computeHintPosition：默认在下方；下方被底部导航挡住时放上方；超高目标贴顶部内侧', () => {
  const viewport = { width: 390, height: 844 };
  const below = computeHintPosition({ top: 200, bottom: 240, left: 150, width: 90, height: 40 }, viewport);
  assert.equal(below.mode, 'below');
  assert.equal(below.top, 252);
  assert.ok(below.left >= 12 && below.left + below.width <= 378);
  const above = computeHintPosition({ top: 640, bottom: 680, left: 150, width: 90, height: 40 }, viewport);
  assert.equal(above.mode, 'above');
  assert.equal(above.bottom, 844 - 640 + 12);
  const tall = computeHintPosition({ top: 100, bottom: 800, left: 0, width: 390, height: 700 }, viewport);
  assert.equal(tall.mode, 'inside');
  const edge = computeHintPosition({ top: 100, bottom: 130, left: 360, width: 24, height: 30 }, viewport);
  assert.ok(edge.left + edge.width <= 378);
  assert.ok(edge.arrowLeft <= edge.width - 30);
});

test('VIP 到期提醒：到期前 7 天内提醒，永久或更高角色覆盖时不提醒', async () => {
  const { vipExpiryNotice, formatExpiryDate } = await import('../src/app/onboarding/vipExpiry.js');
  const now = Date.parse('2027-01-20T00:00:00Z');
  const vip = { code: 'vip', name: 'VIP', expiresAt: '2027-01-24T15:59:59Z' };
  const notice = vipExpiryNotice([{ code: 'user', expiresAt: null }, vip], now);
  assert.equal(notice.code, 'vip');
  assert.equal(notice.daysLeft, 5);
  assert.equal(formatExpiryDate(vip.expiresAt), '1月24日');
  assert.equal(vipExpiryNotice([vip], Date.parse('2027-01-10T00:00:00Z')), null, '超过 7 天不提醒');
  assert.equal(vipExpiryNotice([vip], Date.parse('2027-01-25T00:00:00Z')), null, '已过期不提醒');
  assert.equal(vipExpiryNotice([vip, { code: 'svip', expiresAt: null }], now), null);
  assert.equal(vipExpiryNotice([vip, { code: 'vip', expiresAt: '2027-04-24T15:59:59Z' }], now), null);
  assert.equal(vipExpiryNotice([{ code: 'user', expiresAt: null }], now), null);
});

test('游客「先看看」直接进演示并跑演示专用引导：新建方案 → 填阈值 → 保存', () => {
  const guest = buildOnboardingTasks({ loggedIn: false });
  const demoTask = guest.items.find((item) => item.id === 'demo');
  assert.equal(demoTask.flow, 'switchDemo');
  const flow = ONBOARDING_FLOWS.switchDemo;
  assert.equal(flow.inDemo, true);
  assert.deepEqual(flow.steps.map((step) => step.target), ['switch-create', 'switch-threshold', 'switch-save']);
  const slot = read('src/components/onboarding/GettingStartedSlot.jsx');
  assert.match(slot, /ONBOARDING_START_DEMO_EVENT/);
  const workspace = read('src/pages/WorkspacePage.jsx');
  assert.match(workspace, /handleStartDemo[\s\S]*setDemoTab\(tab\)/);
  assert.match(read('src/components/onboarding/StepHintHost.jsx'), /demoActive && !flow\?\.inDemo/);
});

test('新手入门未关闭时首页只显示任务卡', () => {
  assert.match(read('src/pages/CnHomeExperience.jsx'), /if \(takeover && topSlot\) return/);
  assert.match(read('src/pages/WorkspacePage.jsx'), /<OnboardingHomeGate[\s\S]*takeover=\{takeover\}/);
});

test('游客「看看怎么接通手机通知」进通知演示：选渠道 → 填 Key → 发送测试，渠道从空开始', async () => {
  const guest = buildOnboardingTasks({ loggedIn: false });
  const task = guest.items.find((item) => item.id === 'demoNotify');
  assert.equal(task.tab, 'notify');
  assert.equal(task.flow, 'notifyDemo');
  assert.equal(ONBOARDING_FLOWS.notifyDemo.inDemo, true);
  assert.deepEqual(ONBOARDING_FLOWS.notifyDemo.steps.map((step) => step.target), ['notify-channel-cards', 'notify-key', 'notify-test']);
  const card = read('src/pages/NotifyConfigCard.jsx');
  for (const target of ['notify-channel-cards', 'notify-key', 'notify-test']) assert.match(card, new RegExp(`data-onboarding="${target}"`));
  const mod = await import('../src/app/demo/fixtures/notify.js');
  const routes = mod.createNotifySetupFixtures([], Date.now());
  const url = (path) => new globalThis.URL(`https://x.test${path}`);
  assert.equal(routes['GET /api/notify/status']({ url: url('/api/notify/status?view=summary') }).data.channels.serverChan3.configured, false);
  routes['PUT /api/account/v1/notify/client-config/items/*']({ url: url('/api/account/v1/notify/client-config/items/channel%3Aserverchan3'), body: JSON.stringify({ item: { serverChan3Uid: '123', serverChan3SendKey: 'sctp123abc456' } }) });
  assert.equal(routes['GET /api/notify/status']({ url: url('/api/notify/status?view=summary') }).data.channels.serverChan3.configured, true);
  const test = routes['POST /api/notify/test']({ body: JSON.stringify({ targetChannel: 'serverchan3' }) });
  assert.equal(test.summary.deliveredCount, 1);
});

test('演示教程走完才记完成：sessionStorage 标记 → 回首页后写进度；两个都完成 = 游客 allDone（显示恭喜）', async () => {
  const { markOnboardingDemoCompleted, consumeOnboardingDemoCompleted } = await import('../src/app/onboarding/state.js');
  const ss = memoryStorage();
  const ls = memoryStorage();
  markOnboardingDemoCompleted('seenDemo', ss);
  assert.equal(consumeOnboardingDemoCompleted(ss, 'guest', ls), 'seenDemo');
  assert.equal(consumeOnboardingDemoCompleted(ss, 'guest', ls), '');
  let state = readOnboardingState('guest', ls);
  let tasks = buildOnboardingTasks({ loggedIn: false, state });
  assert.equal(tasks.items.find((item) => item.id === 'demo').status, 'done');
  assert.equal(tasks.allDone, false);
  markOnboardingDemoCompleted('seenNotifyDemo', ss);
  consumeOnboardingDemoCompleted(ss, 'guest', ls);
  state = readOnboardingState('guest', ls);
  tasks = buildOnboardingTasks({ loggedIn: false, state });
  assert.equal(tasks.allDone, true);
  assert.equal(ONBOARDING_FLOWS.switchDemo.seenKey, 'seenDemo');
  assert.equal(ONBOARDING_FLOWS.notifyDemo.seenKey, 'seenNotifyDemo');
});

test('填 Key 这一步要先填好输入框才能下一步；游客演示走完先提醒注册', () => {
  const keyStep = ONBOARDING_FLOWS.notifyDemo.steps.find((step) => step.target === 'notify-key');
  assert.equal(keyStep.requireInputs, true);
  const card = read('src/pages/NotifyConfigCard.jsx');
  assert.ok((card.match(/data-onboarding-required/g) || []).length >= 4);
  const host = read('src/components/onboarding/StepHintHost.jsx');
  assert.match(host, /disabled=\{Boolean\(step\.requireInputs\) && !inputsReady\}/);
  const page = read('src/pages/WorkspacePage.jsx');
  assert.match(page, /flow\.inDemo && demoAsGuest/);
  assert.match(read('src/components/onboarding/DemoDoneDialog.jsx'), /第二天就清空了/);
});
