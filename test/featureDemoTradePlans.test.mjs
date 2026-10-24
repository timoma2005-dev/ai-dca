/* global Response, URL, setImmediate */
// 交易计划演示 mock：游客（占位令牌）与已登录无权限（真实令牌）都只读演示计划；真实本地存储 / 账号 runtime 不被改动；
// 演示中不云同步（resourceSync 不 push / pull）、无真实请求外发；写入仍 403、无 mock 的 GET 503；
// 新建的计划保留，带入时按 id 并入（服务端逐条 PUT items，本地已加载时追加），示例计划不带入；通知演示同样只显示演示计划。
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

class FakeStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
}

const listeners = new Map();
const realCalls = [];
Object.assign(globalThis, {
  Storage: FakeStorage,
  localStorage: new FakeStorage(),
  location: { origin: 'https://fast.example', hostname: 'fast.example', pathname: '/', search: '', hash: '', protocol: 'https:', href: 'https://fast.example/' },
  addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
  removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
  dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); return true; },
  fetch: async (input, init) => { realCalls.push(`${init?.method || 'GET'} ${new URL(String(input?.url || input), 'https://fast.example').pathname}`); return new Response('{"ok":true}'); },
});
globalThis.window = globalThis;

const {
  DEMO_ACCESS_TOKEN, DEMO_READONLY_CODE, createDemoFetch, demoFeatureFor, importDemoSessions, installFeatureDemo, loadDemoModule, readDemoSession,
} = await import('../src/app/demo/featureDemo.js');
const { TRADE_PLANS_DEMO_IDS, TRADE_PLANS_DEMO_PRICES, buildTradePlansDemoStores } = await import('../src/app/demo/fixtures/tradePlansData.js');
const { buildHoldingsDemoSnapshots } = await import('../src/app/demo/fixtures/holdings.js');
const { readAccountRuntimeStorageRaw, setAccountRuntimeStorageRaw, clearAccountRuntimeStore } = await import('../src/app/accountRuntimeStore.js');
const { resetAccountLoadingState } = await import('../src/app/accountLoadingState.js');
const { deleteAccountResourceItem, fetchAccountResource, putAccountResourceItem } = await import('../src/app/accountApi.js');
const { mergePayloadValueRemoteWins } = await import('../src/app/syncMerge.js');
const { buildTradePlanCenter } = await import('../src/app/tradePlans.js');
const { buildPlan, deletePlan, persistPlanState, readPlanList } = await import('../src/app/plan.js');
const { buildDcaProjection, persistDcaState, readDcaList } = await import('../src/app/dca.js');
const { readSellPlanList } = await import('../src/app/sellPlans.js');
const { loadNotifyStatus, sendNotifyTest, syncTradePlanRules } = await import('../src/app/notifySync.js');
const { markResourceDirty, scheduleAccountPull, scheduleAccountPush } = await import('../src/app/resourceSync.js');

const PLAN_KEY = 'aiDcaPlanStore';
const DCA_KEY = 'aiDcaDcaStore';
const SELL_KEY = 'aiDcaSellPlanStore';
const MOCKED_GETS = [
  'GET /api/account/v1/dca/store',
  'GET /api/account/v1/migrations/legacy',
  'GET /api/account/v1/plans/store',
  'GET /api/account/v1/sell-plans/store',
  'GET /api/notify/status',
];
const HOLDING_CODES = new Set(['513100', '159941', '159513', '513110', '270042']);
const REAL_PLANS = JSON.stringify({ source: 'react-plan-store', version: 1, activePlanId: 'real-plan', plans: [{ id: 'real-plan', name: '沪深300 · 均线分层', symbol: '510300', basePrice: 3.9, isConfigured: true, createdAt: '2025-01-02T00:00:00.000Z' }] });
const REAL_DCA = JSON.stringify({ source: 'react-dca-store', version: 1, activeDcaId: 'real-dca', plans: [{ id: 'real-dca', name: '沪深300 定投', symbol: '510300', recurringInvestment: 500, isConfigured: true }] });
const REAL_SELL = JSON.stringify([{ id: 'real-sell', symbol: 'NVDA', holdingCost: 100, holdingShares: 10 }]);

afterEach(() => {
  realCalls.length = 0;
  resetAccountLoadingState();
  clearAccountRuntimeStore();
});

function useStorage(entries = {}) {
  const storage = new FakeStorage({ aiDcaAnalyticsOptOut_v1: '1', ...entries }); // 不写埋点（无 document）
  globalThis.localStorage = storage;
  return storage;
}

function newPlan(symbol = '159632') {
  return { symbol, name: `${symbol} · 用户新建`, selectedStrategy: 'peak-drawdown', totalBudget: 8000, cashReservePct: 20, basePrice: 1.5, layerWeights: [50, 50], triggerDrops: [5, 10] };
}

const ids = (list) => list.map((item) => item.id);

test('tradePlans demo is ready, lazily loads its module and mocks exactly the page GETs', async () => {
  const feature = demoFeatureFor('tradePlans');
  assert.ok(feature);
  assert.ok(feature.pitch.length > 10);
  const mod = await loadDemoModule('tradePlans');
  assert.deepEqual(mod.keepKeys, [PLAN_KEY, DCA_KEY, SELL_KEY]);
  const { routes, getState } = mod.createFixtures({ state: null });
  assert.deepEqual(Object.keys(routes).sort(), MOCKED_GETS);
  assert.equal(typeof getState, 'function');
});

test('demo plans use the real store format and line up with the holdings demo (prices, codes, triggered tiers)', () => {
  const { planStore, dcaStore, sellPlans } = buildTradePlansDemoStores();
  assert.equal(planStore.source, 'react-plan-store');
  assert.equal(dcaStore.source, 'react-dca-store');
  assert.deepEqual(sellPlans, []);
  assert.equal(planStore.plans.length, 3);
  assert.equal(dcaStore.plans.length, 2);
  for (const plan of planStore.plans) {
    assert.equal(plan.source, 'react-plan');
    assert.equal(plan.version, 2);
    assert.ok(HOLDING_CODES.has(plan.symbol), plan.symbol);
  }
  for (const dca of dcaStore.plans) {
    assert.equal(dca.source, 'react-dca');
    assert.equal(dca.version, 6);
    assert.ok(HOLDING_CODES.has(dca.symbol), dca.symbol);
  }
  // 现价与持仓演示的收盘快照一致。
  const snapshots = buildHoldingsDemoSnapshots();
  for (const [code, price] of Object.entries(TRADE_PLANS_DEMO_PRICES)) {
    assert.equal(snapshots[code].currentPrice ?? snapshots[code].latestNav, price, code);
  }
  // 已触发 / 未触发：513100 第 1 档已触发、第 2 档未触发；159513、159941 均未触发。
  const triggered = (plan) => buildPlan(plan).layers.filter((layer) => TRADE_PLANS_DEMO_PRICES[plan.symbol] <= layer.price).length;
  const bySymbol = new Map(planStore.plans.map((plan) => [plan.symbol, plan]));
  assert.equal(triggered(bySymbol.get('513100')), 1);
  assert.equal(triggered(bySymbol.get('159513')), 0);
  assert.equal(triggered(bySymbol.get('159941')), 0);
  const smart = dcaStore.plans.find((dca) => dca.linkedPlanId);
  assert.ok(planStore.plans.some((plan) => plan.id === smart.linkedPlanId), 'smart DCA links to a demo plan');
  assert.equal(buildDcaProjection(smart, { planList: planStore.plans }).smartDcaMode, 'high-level');
});

test('guest demo: page reads demo plans, mocks hit with the placeholder token, writes 403, real storage untouched, nothing sent', async () => {
  const real = { [PLAN_KEY]: REAL_PLANS, [DCA_KEY]: REAL_DCA, [SELL_KEY]: REAL_SELL, aiDcaMarketActionDraft: '{"action":"plan-new","symbol":"QQQ"}' };
  const storage = useStorage(real);
  const blocked = [];
  const env = installFeatureDemo('tradePlans', { win: globalThis, module: await loadDemoModule('tradePlans'), onBlocked: (key) => blocked.push(key) });
  const center = buildTradePlanCenter(new Date('2026-10-24T03:00:00.000Z'));
  assert.equal(center.previewRows.filter((row) => row.sourceType === 'plan').length, 3);
  assert.equal(center.previewRows.filter((row) => row.sourceType === 'dca').length, 2);
  assert.equal(center.previewRows.filter((row) => row.sourceType === 'sell').length, 0, 'real sell plans hidden');
  assert.ok(center.previewRows.every((row) => TRADE_PLANS_DEMO_IDS.has(row.sourceId)));
  assert.equal(storage.getItem('aiDcaMarketActionDraft'), null, 'real market draft does not open a create view');

  // 列表页的「远端优先」合并：mock 与覆盖层一致，不改回演示中的修改。
  const created = persistPlanState({ ...newPlan(), isConfigured: true }, undefined, { mode: 'create' });
  for (const [resource, key] of [['plans/store', PLAN_KEY], ['dca/store', DCA_KEY], ['sell-plans/store', SELL_KEY]]) {
    const result = await fetchAccountResource(resource);
    const local = storage.getItem(key);
    const merged = mergePayloadValueRemoteWins(key, JSON.stringify(result.data), local);
    const byId = (raw) => { const v = JSON.parse(raw); return (Array.isArray(v) ? v : v.plans).slice().sort((a, b) => a.id.localeCompare(b.id)); };
    assert.deepEqual(byId(merged), byId(local), resource);
  }
  assert.ok(ids(readPlanList()).includes(created.id));
  assert.ok(await loadNotifyStatus());

  await assert.rejects(putAccountResourceItem('plans/store', created.id, created), (error) => error.status === 403 && error.data?.code === DEMO_READONLY_CODE);
  await assert.rejects(deleteAccountResourceItem('plans/store', 'demo-plan-513100-drawdown'), (error) => error.status === 403);
  await assert.rejects(syncTradePlanRules(), (error) => error.status === 403);
  await assert.rejects(sendNotifyTest({ eventType: 'plan-test' }), (error) => error.status === 403);
  assert.deepEqual(blocked, [
    `PUT /api/account/v1/plans/store/items/${created.id}`,
    'DELETE /api/account/v1/plans/store/items/demo-plan-513100-drawdown',
    'POST /api/notify/sync',
    'POST /api/notify/test',
  ]);
  assert.deepEqual(realCalls, [], 'no request leaves the browser');
  env.uninstall();
  for (const [key, value] of Object.entries(real)) assert.equal(storage.map.get(key), value, key);
  assert.equal(storage.map.has('aiDcaPlanState'), false);
  const kept = readDemoSession('tradePlans', { storage });
  assert.deepEqual(kept.state.plans.map((plan) => plan.id), [created.id]);
});

test('logged-in user without access (real token): demo plans over the real runtime, no cloud push / pull, runtime untouched', async (t) => {
  const session = { accessToken: 'real-user-token', username: 'u1', userId: 'uid-1' };
  const syncState = JSON.stringify({ resources: { 'plans/store': { revision: 7, localHash: 'h' } } });
  const storage = useStorage({ aiDcaCloudSyncSession: JSON.stringify(session), aiDcaAccountSyncState: syncState });
  setAccountRuntimeStorageRaw(PLAN_KEY, REAL_PLANS);
  setAccountRuntimeStorageRaw(DCA_KEY, REAL_DCA);
  setAccountRuntimeStorageRaw(SELL_KEY, REAL_SELL);
  const blocked = [];
  const env = installFeatureDemo('tradePlans', { win: globalThis, module: await loadDemoModule('tradePlans'), onBlocked: (key) => blocked.push(key) });
  assert.deepEqual(ids(readPlanList()).sort(), ['demo-plan-159513-drawdown', 'demo-plan-159941-ma120', 'demo-plan-513100-drawdown']);
  assert.deepEqual(ids(readDcaList()).sort(), ['demo-dca-159941-weekly', 'demo-dca-270042-monthly']);
  assert.deepEqual(readSellPlanList(), []);
  const remote = await fetchAccountResource('plans/store');
  assert.equal(remote.data.plans.length, 3, 'real token request answered by the mock');

  persistDcaState({ symbol: '513100', recurringInvestment: 1000, frequency: '每月', executionDay: 5, isConfigured: true }, undefined, { mode: 'create' });
  deletePlan('demo-plan-159513-drawdown');
  // 演示中自动同步不跑：dirty 资源不推送、定时拉取不发 manifest。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  markResourceDirty('plans/store');
  assert.equal(scheduleAccountPush({ delay: 0 }), true);
  assert.equal(scheduleAccountPull({ delay: 0 }), true);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.reset();
  assert.deepEqual(blocked, []);
  assert.deepEqual(realCalls, [], 'no manifest / bundle / PUT leaves the browser');
  env.uninstall();
  assert.equal(readAccountRuntimeStorageRaw(PLAN_KEY), REAL_PLANS, 'real account runtime untouched');
  assert.equal(readAccountRuntimeStorageRaw(DCA_KEY), REAL_DCA);
  assert.equal(readAccountRuntimeStorageRaw(SELL_KEY), REAL_SELL);
  assert.equal(storage.map.get('aiDcaAccountSyncState'), syncState, 'sync baseline untouched');
  assert.equal(readDemoSession('tradePlans', { storage }).state.dcaPlans.length, 1);
});

test('notify demo shows the same demo plans instead of the account plans', async () => {
  const storage = useStorage({ [PLAN_KEY]: REAL_PLANS, [DCA_KEY]: REAL_DCA, [SELL_KEY]: REAL_SELL });
  const env = installFeatureDemo('notify', { win: globalThis, module: await loadDemoModule('notify') });
  assert.ok(ids(readPlanList()).every((id) => TRADE_PLANS_DEMO_IDS.has(id)));
  assert.equal(readPlanList().length, 3);
  assert.equal(readDcaList().length, 2);
  assert.deepEqual(readSellPlanList(), []);
  env.uninstall();
  assert.equal(storage.map.get(PLAN_KEY), REAL_PLANS);
  assert.equal(storage.map.get(DCA_KEY), REAL_DCA);
});

test('keep / import: only user-created plans are kept and merged by id (server items + loaded local store); demo plans never imported', async () => {
  // 只改示例计划 → 不保留。
  let storage = useStorage({});
  let env = installFeatureDemo('tradePlans', { win: globalThis, module: await loadDemoModule('tradePlans') });
  const demo = readPlanList()[0];
  persistPlanState({ ...demo, totalBudget: 99999 }, undefined, { mode: 'replace' });
  env.uninstall();
  assert.equal(readDemoSession('tradePlans', { storage }), null);

  // 游客新建加仓 + 两个定投（一个挂示例计划、一个挂新建计划）→ 再次体验时示例与新建都在 → 登录后带入。
  storage = useStorage({});
  env = installFeatureDemo('tradePlans', { win: globalThis, module: await loadDemoModule('tradePlans') });
  const plan = persistPlanState({ ...newPlan(), isConfigured: true }, undefined, { mode: 'create' });
  const dcaOnDemo = persistDcaState({ symbol: '159941', linkedPlanId: 'demo-plan-159941-ma120', recurringInvestment: 600, isConfigured: true }, undefined, { mode: 'create' });
  const dcaOnNew = persistDcaState({ symbol: plan.symbol, linkedPlanId: plan.id, recurringInvestment: 800, isConfigured: true }, undefined, { mode: 'create' });
  env.uninstall();
  const kept = readDemoSession('tradePlans', { storage });
  assert.ok(kept);
  env = installFeatureDemo('tradePlans', { win: globalThis, module: await loadDemoModule('tradePlans') });
  assert.equal(readPlanList().length, 4, 'resumed demo keeps the demo plans and the new one');
  env.uninstall();

  storage.setItem('aiDcaCloudSyncSession', JSON.stringify({ accessToken: 'real-user-token', username: 'u1', userId: 'uid-1' }));
  setAccountRuntimeStorageRaw(PLAN_KEY, REAL_PLANS); // 本地已加载账号计划
  // 定投 runtime 未加载（null）：本地不写只含新增的 store，交给服务端逐条写入。
  assert.deepEqual(await importDemoSessions({ canAccess: (tab) => tab === 'tradePlans', storage }), ['tradePlans']);
  assert.deepEqual(ids(JSON.parse(readAccountRuntimeStorageRaw(PLAN_KEY)).plans), ['real-plan', plan.id]);
  assert.equal(readAccountRuntimeStorageRaw(DCA_KEY), null);
  const puts = realCalls.filter((call) => call.startsWith('PUT '));
  assert.deepEqual(puts.sort(), [
    `PUT /api/account/v1/dca/store/items/${dcaOnDemo.id}`,
    `PUT /api/account/v1/dca/store/items/${dcaOnNew.id}`,
    `PUT /api/account/v1/plans/store/items/${plan.id}`,
  ].sort());
  assert.ok(!realCalls.some((call) => /demo-(plan|dca)-/.test(call)), 'demo plans never reach the account');
  assert.equal(readDemoSession('tradePlans', { storage }), null);
  const state = kept.state;
  assert.equal(state.dcaPlans.find((item) => item.id === dcaOnDemo.id).linkedPlanId, '', 'link to a demo plan dropped');
  assert.equal(state.dcaPlans.find((item) => item.id === dcaOnNew.id).linkedPlanId, plan.id, 'link to a kept plan preserved');
});

test('no regression: demo-token GET without a mock → 503, writes → 403, trade plan mocks win on both hosts', async () => {
  useStorage({});
  const mod = await loadDemoModule('tradePlans');
  let hits = 0;
  const f = createDemoFetch({ realFetch: async () => { hits += 1; return new Response('{}'); }, fixtures: mod.createFixtures({}).routes, origin: 'https://x.example' });
  const auth = { headers: { authorization: `Bearer ${DEMO_ACCESS_TOKEN}` } };
  for (const host of ['', 'https://api.freebacktrack.tech']) {
    assert.equal((await (await f(`${host}/api/account/v1/migrations/legacy`, auth)).json()).status, 'no-legacy');
    const res = await (await f(`${host}/api/account/v1/plans/store`, auth)).json();
    assert.equal(res.resource, 'plans/store');
    assert.equal(res.merge, 'planStore');
  }
  const missing = await f('/api/account/v1/manifest', auth);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'DEMO_NO_FIXTURE');
  for (const [method, path] of [['PUT', '/api/account/v1/plans/store/items/x'], ['DELETE', '/api/account/v1/plans/store/items/x'], ['PUT', '/api/account/v1/dca/store'], ['POST', '/api/notify/sync']]) {
    for (const token of [DEMO_ACCESS_TOKEN, 'real']) {
      const write = await f(path, { method, headers: { authorization: `Bearer ${token}` } });
      assert.equal(write.status, 403, `${method} ${path}`);
      assert.equal((await write.json()).code, DEMO_READONLY_CODE);
    }
  }
  assert.equal(hits, 0);
  mock.reset();
});
