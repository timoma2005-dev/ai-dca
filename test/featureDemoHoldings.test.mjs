/* global Response */
// 持仓总览演示 mock：游客（本地模式，读 seed）与已登录无权限（远端模式，mock 交易行 / 资金配置）两条路径都只读演示数据；
// 真实本地存储 / 账号 runtime / pending journal 不被改动；演示中不推送、不自动拉取；写入仍 403、无 mock 的 GET 503；
// 演示中新增的自洽交易保留，带入时并入账号现有账本而不覆盖。
import { afterEach, test } from 'node:test';
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

// 浏览器环境：window === globalThis；必须在导入 app 模块前装好（authSession 导入时安装账号读取 guard）。
const listeners = new Map();
const realCalls = [];
Object.assign(globalThis, {
  Storage: FakeStorage,
  localStorage: new FakeStorage(),
  location: { origin: 'https://fast.example', hostname: 'fast.example', pathname: '/', search: '', hash: '', protocol: 'https:', href: 'https://fast.example/' },
  addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
  removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
  dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); return true; },
  fetch: async (input, init) => { realCalls.push(`${init?.method || 'GET'} ${String(input?.url || input)}`); return new Response('{"real":true}'); },
});
globalThis.window = globalThis;

const {
  DEMO_ACCESS_TOKEN, DEMO_READONLY_CODE, createDemoFetch, demoFeatureFor, importDemoSessions, installFeatureDemo, loadDemoModule, readDemoSession,
} = await import('../src/app/demo/featureDemo.js');
const {
  HOLDINGS_ALLOCATION_KEY, HOLDINGS_DEMO_TRANSACTIONS, HOLDINGS_JOURNAL_PREFIX, HOLDINGS_LEDGER_KEY, HOLDINGS_SYNC_STATE_KEY, buildHoldingsDemoLedger,
  selfContainedDemoTransactions,
} = await import('../src/app/demo/fixtures/holdings.js');
const { buildNotifyDemoHoldingsRule } = await import('../src/app/demo/fixtures/notify.js');
const { readAccountRuntimeStorageRaw, setAccountRuntimeStorageRaw, clearAccountRuntimeStore } = await import('../src/app/accountRuntimeStore.js');
const { createHoldingsRemoteSource } = await import('../src/app/holdingsRemoteSource.js');
const { pullHoldingTransactions, scheduleHoldingTransactionRetry } = await import('../src/app/holdingTransactionsSync.js');
const { persistHoldingTransactionMutation, persistDeletedHoldingTransaction } = await import('../src/app/holdingTransactionMutations.js');
const { putHoldingTransaction, deleteHoldingTransaction } = await import('../src/app/holdingTransactionsApi.js');
const { resetAccountLoadingState } = await import('../src/app/accountLoadingState.js');
const { readLedgerState } = await import('../src/app/holdingsLedger.js');
const { readAccountAllocationSettings } = await import('../src/app/accountManager.js');
const { readTradeLedger } = await import('../src/app/tradeLedger.js');
const { loadSwitchSnapshotFromWorker } = await import('../src/app/switchStrategySync.js');
const { loadHoldingsNotifyRule, loadNotifyStatus } = await import('../src/app/notifySync.js');
const { aggregateByCode, buildSoldLots, getTransactionErrors, getSwitchChainCodeList } = await import('../src/app/holdingsLedgerCore.js');
const { clearAllLocalDataAsync } = await import('../src/app/clearAllData.js');

const NDX_CODES = new Set(['513100', '159501', '159941', '159696', '159659', '159632', '513300', '513870', '513110', '159660', '513390', '159513']);
const MOCKED_GETS = [
  'GET /api/account/v1/holdings/allocation',
  'GET /api/account/v1/holdings/ledger/items',
  'GET /api/account/v1/holdings/ledger/items/*',
  'GET /api/account/v1/migrations/legacy',
  'GET /api/account/v1/trades/ledger',
  'GET /api/notify/holdings-rule',
  'GET /api/notify/status',
  'GET /api/notify/switch/snapshot',
];
const REAL_LEDGER = JSON.stringify({ transactions: [{ id: 'real-1', code: '510300', name: '沪深300ETF', kind: 'exchange', type: 'BUY', date: '2025-01-02', price: 3.9, shares: 1000 }] });

afterEach(() => {
  realCalls.length = 0;
  resetAccountLoadingState();
  clearAccountRuntimeStore();
});

function harness(entries) {
  const storage = new FakeStorage(entries);
  globalThis.localStorage = storage;
  const state = { ledger: { transactions: [] }, accountSettings: null, tradeLedger: null };
  const source = createHoldingsRemoteSource({
    setLedger: (next) => { state.ledger = typeof next === 'function' ? next(state.ledger) : next; },
    setAccountSettings: (next) => { state.accountSettings = next; },
    setTradeLedgerEntries: (next) => { state.tradeLedger = next; },
  });
  return { storage, state, source };
}

function userBuy(id, code, shares, extra = {}) {
  return { id, code, name: code, kind: 'exchange', type: 'BUY', date: '2026-10-23', price: 2.4, shares, ...extra };
}

test('holdings demo is ready, lazily loads its module and mocks exactly the holdings page GETs', async () => {
  const feature = demoFeatureFor('holdings');
  assert.ok(feature);
  assert.ok(feature.points.length >= 2);
  const mod = await loadDemoModule('holdings');
  assert.deepEqual(mod.keepKeys, [HOLDINGS_LEDGER_KEY]);
  const { routes, getState } = mod.createFixtures({ state: null });
  assert.deepEqual(Object.keys(routes).sort(), MOCKED_GETS);
  assert.equal(getState, undefined, 'writes stay blocked, no mock server state');
});

test('demo ledger is realistic: Nasdaq QDII ETFs + one OTC feeder, buys / sells / three switch pairs, no invalid rows', () => {
  const ledger = buildHoldingsDemoLedger();
  assert.equal(ledger.transactions.length, 14);
  assert.deepEqual(ledger.transactions.flatMap((tx) => Object.keys(getTransactionErrors(tx))), []);
  for (const tx of ledger.transactions) assert.ok(NDX_CODES.has(tx.code) || tx.code === '270042', tx.code);
  const byCode = new Map(aggregateByCode(ledger.transactions, ledger.snapshotsByCode).map((agg) => [agg.code, agg]));
  assert.equal(byCode.get('513100').totalShares, 20000, 'matches the fund-switch demo rule holdingQuantity');
  assert.equal(byCode.get('159941').totalShares, 16800);
  assert.equal(byCode.get('159513').totalShares, 9000);
  assert.equal(byCode.get('513110').totalShares, 0, 'round trip 513100 → 513110 → 513100 closed out');
  assert.equal(byCode.get('270042').kind, 'qdii');
  const switches = buildSoldLots(ledger.transactions).filter((lot) => lot.isSwitch).map((lot) => `${lot.code}→${lot.switchTargetCode}`).sort();
  assert.deepEqual(switches, ['513100→159513', '513100→513110', '513110→513100']);
  assert.deepEqual(getSwitchChainCodeList(ledger.transactions), ['159513', '513100', '513110']);
  // 与通知演示里的每日持仓摘要权重一致（±3%）。
  const total = [...byCode.values()].reduce((sum, agg) => sum + agg.marketValue, 0);
  const digest = buildNotifyDemoHoldingsRule(Date.now()).digest;
  for (const { code, weight } of [...digest.exchange, ...digest.otc]) {
    assert.ok(Math.abs(byCode.get(code).marketValue / total - weight) < 0.03, `${code} weight`);
  }
});

test('guest demo (local mode): page reads the seeded ledger, mocks the signal / push GETs, real storage untouched, nothing sent', async () => {
  const real = { [HOLDINGS_LEDGER_KEY]: REAL_LEDGER, [HOLDINGS_ALLOCATION_KEY]: '{"cashAmount":1}', aiDcaSellPlanStore: '{"plans":[1]}', aiDcaAnalyticsOptOut_v1: '1' };
  const { storage, state, source } = harness(real);
  const blocked = [];
  const env = installFeatureDemo('holdings', { win: globalThis, module: await loadDemoModule('holdings'), onBlocked: (key) => blocked.push(key) });
  assert.equal(readLedgerState().transactions.length, 14);
  assert.equal(await source.refresh(), 'local');
  assert.equal(state.ledger.transactions.length, 14);
  assert.equal(state.accountSettings.cashAmount, 48000);
  assert.deepEqual(state.tradeLedger, []);
  assert.equal(readAccountAllocationSettings().cashYieldMode, 'manual');
  assert.equal(storage.getItem('aiDcaSellPlanStore'), null, 'real sell plans hidden during the demo');
  const signal = await loadSwitchSnapshotFromWorker();
  assert.equal(signal.snapshot.activeRuleId, 'demo-ndx-h2l');
  assert.equal((await loadHoldingsNotifyRule()).enabled, true);
  assert.ok(await loadNotifyStatus());

  const next = { ...state.ledger, transactions: [...state.ledger.transactions, userBuy('user-a', '159632', 1000)] };
  const result = await persistHoldingTransactionMutation(next, { kind: 'create', label: 't', upsertIds: ['user-a'], setLedger: () => {} });
  assert.equal(result.cloudAttempted, false);
  await clearAllLocalDataAsync();
  assert.equal(readLedgerState().transactions.length, 0, 'clear-all only clears the overlay');
  assert.deepEqual(blocked, []);
  assert.deepEqual(realCalls, [], 'no request leaves the browser');
  env.uninstall();
  for (const [key, value] of Object.entries(real)) assert.equal(storage.map.get(key), value, key);
  assert.equal(storage.map.has(HOLDINGS_SYNC_STATE_KEY), false);
  assert.equal(readDemoSession('holdings', { storage }), null, 'cleared afterwards → nothing self-contained to keep');
});

test('logged-in user without access (real token, remote mode): mock rows hydrate, runtime / journal untouched, no push, writes 403', async () => {
  const session = { accessToken: 'real-user-token', username: 'u1', userId: 'uid-1' };
  const journalKey = `${HOLDINGS_JOURNAL_PREFIX}uid-1`;
  const realJournal = JSON.stringify({ version: 1, userId: 'uid-1', entries: { 'real-1': { kind: 'upsert', row: JSON.parse(REAL_LEDGER).transactions[0], baseRevision: 1 } } });
  const realSync = JSON.stringify({ rows: { 'real-1': { revision: 1, localHash: 'x' } }, knownIds: ['real-1'] });
  const { storage, state, source } = harness({ aiDcaCloudSyncSession: JSON.stringify(session), [journalKey]: realJournal, [HOLDINGS_SYNC_STATE_KEY]: realSync });
  setAccountRuntimeStorageRaw(HOLDINGS_LEDGER_KEY, REAL_LEDGER);
  setAccountRuntimeStorageRaw(HOLDINGS_ALLOCATION_KEY, '{"cashAmount":7}');
  const blocked = [];
  const env = installFeatureDemo('holdings', { win: globalThis, module: await loadDemoModule('holdings'), onBlocked: (key) => blocked.push(key) });
  assert.equal(readLedgerState().transactions.length, 0, 'first paint waits for the (mock) remote rows instead of flashing real data');
  assert.equal(await source.refresh(), 'remote');
  assert.deepEqual(state.ledger.transactions.map((tx) => tx.id).sort(), HOLDINGS_DEMO_TRANSACTIONS.map((tx) => tx.id).sort());
  assert.equal(state.accountSettings.cashAmount, 48000);
  assert.equal(readTradeLedger().length, 0);
  const pulled = await pullHoldingTransactions({ session: { ...session } });
  assert.deepEqual(pulled.pendingLocalIds, [], 'mock rows count as confirmed, nothing queued to push');
  assert.equal(scheduleHoldingTransactionRetry(0), false, 'auto push is off during the demo');

  const added = { ...state.ledger, transactions: [...state.ledger.transactions, userBuy('user-b', '513390', 500)] };
  const result = await persistHoldingTransactionMutation(added, { kind: 'create', label: 't', upsertIds: ['user-b'], setLedger: () => {} });
  assert.equal(result.cloudAttempted, false, 'saved to the demo overlay only');
  const removed = await persistDeletedHoldingTransaction({ ledger: added, txId: 'demo-hold-159941-s1', setLedger: () => {} });
  assert.equal(removed.cloudAttempted, false);
  await assert.rejects(putHoldingTransaction('user-b', added.transactions.at(-1), { baseRevision: 0 }), (error) => error.status === 403 && error.data?.code === DEMO_READONLY_CODE);
  await assert.rejects(deleteHoldingTransaction('demo-hold-513100-b1', { baseRevision: 1 }), (error) => error.status === 403);
  assert.deepEqual(blocked, ['PUT /api/account/v1/holdings/ledger/items/user-b', 'DELETE /api/account/v1/holdings/ledger/items/demo-hold-513100-b1']);
  assert.deepEqual(realCalls, [], 'no request leaves the browser');
  env.uninstall();
  assert.equal(readAccountRuntimeStorageRaw(HOLDINGS_LEDGER_KEY), REAL_LEDGER, 'real account runtime ledger untouched');
  assert.equal(readAccountRuntimeStorageRaw(HOLDINGS_ALLOCATION_KEY), '{"cashAmount":7}');
  assert.equal(storage.map.get(journalKey), realJournal, 'real pending journal neither replayed nor rewritten');
  assert.equal(storage.map.get(HOLDINGS_SYNC_STATE_KEY), realSync);
  const kept = readDemoSession('holdings', { storage });
  assert.deepEqual(JSON.parse(kept.entries[0][1]).transactions.map((tx) => tx.id), ['user-b'], 'only the self-contained addition is kept');
});

test('keep / import: only self-contained additions survive, merged into the account ledger without dropping rows', async () => {
  const seedEdit = { ...HOLDINGS_DEMO_TRANSACTIONS[0], shares: 1 };
  const additions = selfContainedDemoTransactions([
    seedEdit,
    userBuy('u-buy', '159632', 1000),
    userBuy('u-buy2', '513390', 600),
    { ...userBuy('u-sell-switch', '159632', 400), type: 'SELL', switchPairId: 'u-buy2' },
    { ...userBuy('u-oversell', '513100', 500), type: 'SELL' },
    { ...userBuy('u-pair-seed', '159632', 100), type: 'SELL', switchPairId: 'demo-hold-159513-b1' },
  ]);
  assert.deepEqual(additions.map((tx) => tx.id), ['u-buy', 'u-buy2', 'u-sell-switch', 'u-pair-seed']);
  assert.equal(additions.find((tx) => tx.id === 'u-sell-switch').switchPairId, 'u-buy2');
  assert.equal(additions.find((tx) => tx.id === 'u-pair-seed').switchPairId, '', 'pair to a demo row is dropped');

  // 游客：仅页面重写账本（无新增）→ 不保留。
  let { storage } = harness({});
  let env = installFeatureDemo('holdings', { win: globalThis, module: await loadDemoModule('holdings') });
  storage.setItem(HOLDINGS_LEDGER_KEY, JSON.stringify({ ...readLedgerState(), lastNavMeta: { status: 'ok' } }));
  env.uninstall();
  assert.equal(readDemoSession('holdings', { storage }), null);

  // 游客新增一笔买入 → 注册后并入账号现有账本。
  ({ storage } = harness({}));
  env = installFeatureDemo('holdings', { win: globalThis, module: await loadDemoModule('holdings') });
  const ledger = readLedgerState();
  storage.setItem(HOLDINGS_LEDGER_KEY, JSON.stringify({ ...ledger, transactions: [...ledger.transactions, userBuy('u-new', '159632', 800)] }));
  env.uninstall();
  storage.setItem(HOLDINGS_LEDGER_KEY, REAL_LEDGER);
  assert.deepEqual(await importDemoSessions({ canAccess: (tab) => tab === 'holdings', storage }), ['holdings']);
  assert.deepEqual(JSON.parse(storage.getItem(HOLDINGS_LEDGER_KEY)).transactions.map((tx) => tx.id), ['real-1', 'u-new']);
  assert.equal(readDemoSession('holdings', { storage }), null);
  assert.deepEqual(realCalls, []);
});

test('no regression: demo-token GET without a mock → 503, writes → 403, holdings mocks win on both hosts', async () => {
  const mod = await loadDemoModule('holdings');
  let hits = 0;
  const f = createDemoFetch({ realFetch: async () => { hits += 1; return new Response('{}'); }, fixtures: mod.createFixtures({}).routes, origin: 'https://x.example' });
  const auth = { headers: { authorization: `Bearer ${DEMO_ACCESS_TOKEN}` } };
  for (const host of ['', 'https://api.freebacktrack.tech']) {
    const list = await (await f(`${host}/api/account/v1/holdings/ledger/items?limit=1000`, auth)).json();
    assert.equal(list.rows.length, 14, host);
    assert.equal(list.nextCursor, '');
    const one = await (await f(`${host}/api/account/v1/holdings/ledger/items/demo-hold-513100-s1`, auth)).json();
    assert.equal(one.data.switchPairId, 'demo-hold-513110-b1');
    assert.equal((await f(`${host}/api/account/v1/holdings/ledger/items/nope`, auth)).status, 404);
    assert.equal((await (await f(`${host}/api/account/v1/migrations/legacy`, auth)).json()).status, 'no-legacy');
  }
  const missing = await f('/api/account/v1/manifest', auth);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'DEMO_NO_FIXTURE');
  for (const [method, path] of [['PUT', '/api/account/v1/holdings/ledger/items/x'], ['DELETE', '/api/account/v1/holdings/ledger/items/x'], ['PUT', '/api/account/v1/holdings/allocation'], ['POST', '/api/account/v1/migrations/legacy'], ['POST', '/api/holdings/ocr']]) {
    for (const token of [DEMO_ACCESS_TOKEN, 'real']) {
      const write = await f(path, { method, headers: { authorization: `Bearer ${token}` } });
      assert.equal(write.status, 403, `${method} ${path}`);
      assert.equal((await write.json()).code, DEMO_READONLY_CODE);
    }
  }
  assert.equal(hits, 0);
});
