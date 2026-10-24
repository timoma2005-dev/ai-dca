/* global Response */
// 通知管理演示 mock：页面发出的带登录 GET（status summary / details、events、holdings-rule、switch/config）全部命中，
// 结构可被页面的规范化函数消费；写入 403、无 mock 的 503 不回归、备用域名同样命中、没有任何真实请求外发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_ACCESS_TOKEN, DEMO_READONLY_CODE, createDemoFetch, demoFeatureFor, installFeatureDemo, loadDemoModule, readDemoSession,
} from '../src/app/demo/featureDemo.js';
import {
  NOTIFY_CLIENT_CONFIG_KEY, NOTIFY_DEMO_BARK_KEY, NOTIFY_DEMO_EMAIL, NOTIFY_MARKET_ALERTS_KEY, NOTIFY_PRESETS_KEY,
  buildNotifyDemoEvents, buildNotifyDemoHoldingsRule,
} from '../src/app/demo/fixtures/notify.js';
import { SWITCH_CONFIG_CACHE_KEY } from '../src/app/demo/fixtures/fundSwitch.js';
import {
  enableNotifyBark, loadHoldingsNotifyRule, loadNotifyEvents, loadNotifyStatus, mergeNotifyStatusIntoClientConfig, readNotifyClientConfig,
  saveHoldingsNotifyRule, sendNotifyTest, syncTradePlanRules,
} from '../src/app/notifySync.js';
import { loadSwitchConfigFromWorker, readSwitchConfigCache } from '../src/app/switchStrategySync.js';
import { readMarketAlerts } from '../src/app/alertRules.js';
import { readNotifyPresets } from '../src/pages/notify/notifyPresets.js';
import { getVisibleNotifyEvents } from '../src/pages/notifyHistoryHelpers.js';
import { hasNotifySession } from '../src/pages/notifySurfaceHelpers.js';

const SAT = Date.parse('2026-10-24T10:37:00+08:00'); // 周六
const TRADING = Date.parse('2026-10-22T10:00:00+08:00'); // 周四盘中，10:41 之后的当日事件尚未发生
const NDX_CODES = new Set(['513100', '159501', '159941', '159696', '159659', '159632', '513300', '513870', '513110', '159660', '513390', '159513']);
const MOCKED_GETS = ['GET /api/notify/events', 'GET /api/notify/holdings-rule', 'GET /api/notify/status', 'GET /api/notify/switch/config'];

class FakeStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

function installBrowser(storage) {
  const realCalls = [];
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, location: globalThis.location, fetch: globalThis.fetch };
  globalThis.localStorage = storage;
  globalThis.location = { origin: 'https://fast.example', hostname: 'fast.example' };
  globalThis.fetch = async (input, init) => { realCalls.push(`${init?.method || 'GET'} ${String(input)}`); return new Response('{"real":true}'); };
  globalThis.window = globalThis;
  return {
    realCalls,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

test('notify demo is ready, lazily loads its module, mocks exactly the page GETs, keeps nothing', async () => {
  const feature = demoFeatureFor('notify');
  assert.ok(feature);
  assert.ok(feature.points.length >= 2);
  const mod = await loadDemoModule('notify');
  assert.deepEqual(mod.keepKeys, []);
  assert.deepEqual(mod.seed().map(([key]) => key).sort(), [
    NOTIFY_CLIENT_CONFIG_KEY, NOTIFY_MARKET_ALERTS_KEY, 'aiDcaHoldingAlerts', NOTIFY_PRESETS_KEY, SWITCH_CONFIG_CACHE_KEY,
    // 规则卡 / 预设计数 / 送达测试读的交易与定投计划：用交易计划演示的同一份，不显示账号真实计划。
    'aiDcaPlanStore', 'aiDcaPlanState', 'aiDcaDcaStore', 'aiDcaDcaState', 'aiDcaSellPlanStore', 'aiDcaSellPlanDraft',
  ].sort());
  const { routes, getState } = mod.createFixtures({ state: null });
  assert.deepEqual(Object.keys(routes).sort(), MOCKED_GETS);
  assert.equal(getState, undefined, 'writes stay blocked, no mock server state');
});

test('demo push history follows the stored event shape, Nasdaq QDII codes, never in the future', () => {
  const events = buildNotifyDemoEvents(SAT);
  assert.equal(events.length, 9);
  assert.equal(events[0].createdAt, '2026-10-23T07:35:00.000Z', 'Fri 15:35 CST holdings digest is the newest');
  for (let i = 1; i < events.length; i += 1) assert.ok(Date.parse(events[i - 1].createdAt) >= Date.parse(events[i].createdAt), 'newest first');
  for (const event of events) {
    assert.equal(event.id, event.eventId);
    assert.ok(['switch-strategy-trigger', 'market-alert', 'holdings-daily-return'].includes(event.eventType), event.eventType);
    assert.ok(event.title && event.body && event.summary);
    assert.equal(event.status, 'delivered');
    assert.deepEqual(event.channels.map((item) => item.channel), ['bark', 'serverchan3', 'email', 'pc']);
    if (/^\d{6}$/.test(event.symbol)) assert.ok(NDX_CODES.has(event.symbol), event.symbol);
  }
  const switches = events.filter((event) => event.eventType === 'switch-strategy-trigger');
  assert.equal(switches.length, 2);
  for (const event of switches) {
    const gap = Number(/H−L \+([\d.]+)%/.exec(event.body)?.[1]);
    assert.ok(gap > 4 && gap < 7, `rule B gap ${gap} crosses the 4% demo threshold`);
    assert.match(event.strategyName, /国泰纳指 高溢价切出/);
  }
  assert.ok(events.some((event) => event.channels.some((item) => item.status === 'failed')), 'one partial failure for realism');
  assert.equal(getVisibleNotifyEvents(events, 0).length, events.length, 'no test events, nothing hidden by the 30-min TTL');
  assert.deepEqual(buildNotifyDemoEvents(SAT), events, 'deterministic');
  const intraday = buildNotifyDemoEvents(TRADING);
  assert.ok(intraday.every((event) => Date.parse(event.createdAt) <= TRADING));
  assert.ok(!intraday.some((event) => event.createdAt.startsWith('2026-10-22')), 'today\'s 10:41+ events have not happened yet');
  const rule = buildNotifyDemoHoldingsRule(SAT);
  assert.equal(rule.enabled, true);
  assert.ok([...rule.digest.exchange, ...rule.digest.otc].every((entry) => /^\d{6}$/.test(entry.code) && entry.weight > 0 && entry.weight <= 1));
});

for (const [label, session] of [['guest (demo placeholder token)', null], ['logged-in user without VIP (real token)', { accessToken: 'real-user-token', username: 'u1' }]]) {
  test(`installed demo, ${label}: page GETs hit the mock, writes are 403, nothing reaches the network`, async () => {
    const real = {
      aiDcaAnalyticsOptOut_v1: '1',
      [NOTIFY_CLIENT_CONFIG_KEY]: JSON.stringify({ barkDeviceKey: 'RealUserBarkKey123', notifyClientId: 'web:real' }),
      ...(session ? { aiDcaCloudSyncSession: JSON.stringify(session) } : {}),
    };
    const storage = new FakeStorage(real);
    const browser = installBrowser(storage);
    const blocked = [];
    try {
      assert.equal(hasNotifySession(session), Boolean(session), 'outside the demo a guest is not treated as logged in');
      const mod = await loadDemoModule('notify');
      const env = installFeatureDemo('notify', { win: globalThis, module: mod, onBlocked: (key) => blocked.push(key) });
      assert.equal(hasNotifySession(session), true, 'the page loads its data during the demo, guests included');
      // 首屏：本地缓存即为演示内容，不闪出账号原数据。
      assert.equal(readNotifyClientConfig().barkDeviceKey, NOTIFY_DEMO_BARK_KEY);
      assert.equal(readMarketAlerts().length, 3);
      assert.equal(readNotifyPresets().premium.enabled, true);
      assert.equal(readSwitchConfigCache().rules[0].id, 'demo-ndx-h2l');

      const status = await loadNotifyStatus();
      assert.deepEqual(status.configured, { bark: true, serverChan3: true, email: true, webWs: false });
      assert.equal(status.setup.barkDeviceKey, NOTIFY_DEMO_BARK_KEY);
      assert.equal(status.setup.email.maskedAddress, NOTIFY_DEMO_EMAIL);
      assert.equal(status.setup.serverChan3.configured, true);
      assert.equal(status.setup.accountUsername, 'demo');
      assert.ok(status.eventCount > 0);
      assert.equal(status.lastEvent?.eventType, 'holdings-daily-return');
      assert.deepEqual(status.setup.webWsCurrentClientRegistrations, []);
      assert.equal(mergeNotifyStatusIntoClientConfig(status).serverChan3Uid, '20261');

      const { events } = await loadNotifyEvents();
      assert.ok(events.length >= 5);
      const again = await loadNotifyEvents();
      assert.deepEqual(again.events, events, 'history is frozen for the session (PC poller never sees "new" demo events)');
      const holdings = await loadHoldingsNotifyRule();
      assert.equal(holdings.enabled, true);
      const switchConfig = await loadSwitchConfigFromWorker();
      assert.equal(switchConfig.rules.length, 3);

      await assert.rejects(saveHoldingsNotifyRule({ enabled: false }), (error) => error.status === 403 && error.code === DEMO_READONLY_CODE);
      await assert.rejects(syncTradePlanRules({ marketAlerts: [] }), (error) => error.status === 403);
      await assert.rejects(sendNotifyTest({ targetChannel: 'bark' }), (error) => error.status === 403);
      await assert.rejects(enableNotifyBark(), (error) => error.status === 403);
      assert.deepEqual(blocked, ['POST /api/notify/holdings-rule', 'POST /api/notify/sync', 'POST /api/notify/test', 'POST /api/notify/channels/bark/enable']);
      assert.deepEqual(browser.realCalls, [], 'no request leaves the browser');
      env.uninstall();
      assert.equal(storage.map.get(NOTIFY_CLIENT_CONFIG_KEY), real[NOTIFY_CLIENT_CONFIG_KEY], 'real notify config untouched');
      assert.equal(storage.map.get(NOTIFY_MARKET_ALERTS_KEY), undefined);
      assert.equal(storage.map.get(SWITCH_CONFIG_CACHE_KEY), undefined);
      assert.equal(readDemoSession('notify', { storage }), null, 'nothing kept');
      assert.equal(hasNotifySession(session), Boolean(session));
    } finally {
      browser.restore();
    }
  });
}

test('no regression: demo-token GET without a mock → 503, writes → 403; notify mocks win on both hosts', async () => {
  const mod = await loadDemoModule('notify');
  let hits = 0;
  const f = createDemoFetch({ realFetch: async () => { hits += 1; return new Response('{}'); }, fixtures: mod.createFixtures({}).routes, origin: 'https://x.example' });
  const auth = { headers: { authorization: `Bearer ${DEMO_ACCESS_TOKEN}` } };
  for (const host of ['', 'https://api.freebacktrack.tech', 'https://ai-dca-notify.example.workers.dev']) {
    const summary = await (await f(`${host}/api/notify/status?view=summary`, auth)).json();
    assert.equal(summary.data.account.username, 'demo', host);
    const details = await (await f(`${host}/api/notify/status?view=details`, auth)).json();
    assert.ok(Array.isArray(details.data.delivery.failures), host);
    assert.ok((await (await f(`${host}/api/notify/events`, auth)).json()).events.length > 0, host);
    assert.equal((await f(`${host}/api/notify/holdings-rule`, auth)).status, 200, host);
    assert.equal((await f(`${host}/api/notify/switch/config`, auth)).status, 200, host);
  }
  const missing = await f('/api/notify/email/status', auth);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'DEMO_NO_FIXTURE');
  for (const path of ['/api/notify/settings', '/api/notify/sync', '/api/notify/test', '/api/notify/holdings-rule', '/api/notify/email/send-code', '/api/notify/channels/serverchan3/disable']) {
    const write = await f(path, { method: 'POST', ...auth });
    assert.equal(write.status, 403, path);
    assert.equal((await write.json()).code, DEMO_READONLY_CODE);
  }
  assert.equal((await f('/api/notify/holdings-rule', { method: 'POST', headers: { authorization: 'Bearer real' } })).status, 403, 'blocked with a real token too');
  assert.equal(hits, 0);
});
