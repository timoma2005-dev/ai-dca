/* global CustomEvent, Event, Response, URL, dispatchEvent, fetch, localStorage */
// 数据修复演示 mock：游客（无会话，本地修复）与已登录无权限（真实令牌，读 mock 云端交易行）都只读演示账本；
// 基金字典走 mock、不注入外部脚本、不请求行情；云端 PUT / DELETE 403（页面不更新同步基线）；本地修复只进覆盖层，退出即丢弃；
// 不保留、不带入；真实存储 / 账号 runtime / journal 不变；无同步写回、无真实外发；无 mock 503、写入 403 不回归。
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

const listeners = new Map();
const realCalls = [];
Object.assign(globalThis, {
  Storage: FakeStorage,
  localStorage: new FakeStorage(),
  location: { origin: 'https://fast.example', hostname: 'fast.example', pathname: '/', search: '', hash: '', protocol: 'https:', href: 'https://fast.example/' },
  addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
  removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
  dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); return true; },
  fetch: async (input, init) => { realCalls.push(`${init?.method || 'GET'} ${new URL(String(input?.url || input), 'https://fast.example').href}`); return new Response('{"ok":true,"rowRevision":9}'); },
});
globalThis.window = globalThis;

const {
  DEMO_ACCESS_TOKEN, DEMO_READONLY_CODE, createDemoFetch, demoFeatureFor, importDemoSessions, installFeatureDemo, loadDemoModule, readDemoSession, saveDemoSession,
} = await import('../src/app/demo/featureDemo.js');
const { DEMO_FUND_DICTIONARY_PATH, fillExchangeNames, loadFundDictionary, scanLedgerHealth, writeLedgerRow } = await import('../src/app/dataRepairSources.js');
const { buildDataRepairDemoLedger, buildDemoFundDictionary } = await import('../src/app/demo/fixtures/dataRepair.js');
const { HOLDINGS_DEMO_TRANSACTIONS, HOLDINGS_JOURNAL_PREFIX, HOLDINGS_LEDGER_KEY, HOLDINGS_SYNC_STATE_KEY } = await import('../src/app/demo/fixtures/holdings.js');
const { readAccountRuntimeStorageRaw, setAccountRuntimeStorageRaw, clearAccountRuntimeStore } = await import('../src/app/accountRuntimeStore.js');
const { resetAccountLoadingState } = await import('../src/app/accountLoadingState.js');
const { scheduleHoldingTransactionRetry } = await import('../src/app/holdingTransactionsSync.js');
const { detectFundKind, isGhostTransaction } = await import('../src/app/holdingsLedgerBasics.js');

const BASE = '/api/account/v1';
const MOCKED_GETS = [`GET ${BASE}/holdings/ledger/items`, `GET ${DEMO_FUND_DICTIONARY_PATH}`];
const REAL_LEDGER = JSON.stringify({ transactions: [{ id: 'real-1', code: '202691', name: '买入', kind: 'otc', type: 'BUY', date: '', price: 1, shares: 100 }] });
const REAL_SYNC = JSON.stringify({ rows: { 'real-1': { revision: 3, localHash: 'x' } }, knownIds: ['real-1'] });

afterEach(() => {
  realCalls.length = 0;
  resetAccountLoadingState();
  clearAccountRuntimeStore();
});

/** 按页面 runRepair 的顺序走一遍（字典 → 云端读取 → 云端清洗 → 本地底账），返回日志要点。 */
async function runRepairLikePage(token) {
  const { fundMap, demo } = await loadFundDictionary();
  const out = { demo, dictSize: fundMap.size, readonly: 0, cloudWrites: 0, syncRows: 0, deleted: 0, fixed: 0 };
  const syncState = JSON.parse(localStorage.getItem(HOLDINGS_SYNC_STATE_KEY) || '{"rows":{}}');
  if (token) {
    const remote = await (await fetch(`${BASE}/holdings/ledger/items?limit=1000`, { headers: { Authorization: `Bearer ${token}` } })).json();
    out.remoteRows = remote.rows.length;
    for (const row of remote.rows) {
      const name = fundMap.get(row.data.code)?.name || row.data.name;
      const kind = detectFundKind(row.data.code, name);
      const ghost = isGhostTransaction(row.data);
      if (!ghost && name === row.data.name && kind === row.data.kind) continue;
      out.cloudWrites += 1;
      const { demoReadonly, json } = await writeLedgerRow({ base: BASE, token, row, data: ghost ? null : { ...row.data, name, kind } });
      if (demoReadonly) out.readonly += 1;
      else syncState.rows[row.id] = { revision: Number(json?.rowRevision) };
    }
  }
  const missing = [...new Set(JSON.parse(localStorage.getItem(HOLDINGS_LEDGER_KEY)).transactions.map((tx) => tx.code))].filter((c) => !fundMap.has(c) && !isGhostTransaction({ code: c }));
  out.quoteFetched = missing.length ? await fillExchangeNames(missing, fundMap) : false;
  const ledger = JSON.parse(localStorage.getItem(HOLDINGS_LEDGER_KEY));
  ledger.transactions = ledger.transactions.filter((tx) => !(isGhostTransaction(tx) && ++out.deleted)).map((tx) => {
    const name = fundMap.get(tx.code)?.name || tx.name;
    const kind = detectFundKind(tx.code, name);
    if (name !== tx.name || kind !== tx.kind) out.fixed += 1;
    return { ...tx, name, kind };
  });
  out.syncRows = Object.keys(syncState.rows).length;
  localStorage.setItem(HOLDINGS_SYNC_STATE_KEY, JSON.stringify(syncState));
  localStorage.setItem(HOLDINGS_LEDGER_KEY, JSON.stringify(ledger));
  dispatchEvent(new CustomEvent('holdings:ledger-updated', { detail: { state: ledger } }));
  dispatchEvent(new Event('storage'));
  out.after = scanLedgerHealth(ledger.transactions);
  return out;
}

test('dataRepair demo is ready, lazily loads its module, mocks exactly the page GETs and keeps nothing', async () => {
  const feature = demoFeatureFor('dataRepair');
  assert.ok(feature?.points.length >= 2);
  const mod = await loadDemoModule('dataRepair');
  assert.equal(mod.keepKeys, undefined, 'repairs on the sample ledger are never kept or imported');
  assert.equal(mod.importState, undefined);
  const { routes, getState } = mod.createFixtures({ state: null });
  assert.deepEqual(Object.keys(routes).sort(), MOCKED_GETS);
  assert.equal(getState, undefined);
});

test('demo ledger = holdings demo + realistic issues (2 ghosts, placeholder names, kind mismatches), dictionary covers every real code', () => {
  const ledger = buildDataRepairDemoLedger();
  assert.equal(ledger.transactions.length, HOLDINGS_DEMO_TRANSACTIONS.length + 2);
  assert.deepEqual(scanLedgerHealth(ledger.transactions), {
    totalTxs: 16, ghostCount: 2, placeholderNameCount: 4, missingDateCount: 2, mismatchedKindCount: 2, healthy: false,
  });
  assert.deepEqual(scanLedgerHealth(HOLDINGS_DEMO_TRANSACTIONS).healthy, true, 'clean holdings demo stays healthy');
  const dict = new Map(buildDemoFundDictionary().map((item) => [item[0], item[2]]));
  for (const tx of HOLDINGS_DEMO_TRANSACTIONS) assert.equal(dict.get(tx.code), tx.name, `${tx.code} name matches the holdings demo`);
  assert.ok(ledger.snapshotsByCode['202691'], 'ghost snapshot to clean');
});

test('guest demo: local-only repair runs on the overlay, no script / quote / account request, real storage untouched, nothing kept', async () => {
  const real = { [HOLDINGS_LEDGER_KEY]: REAL_LEDGER, [HOLDINGS_SYNC_STATE_KEY]: REAL_SYNC, aiDcaAnalyticsOptOut_v1: '1' };
  const storage = new FakeStorage(real);
  globalThis.localStorage = storage;
  const blocked = [];
  const env = installFeatureDemo('dataRepair', { win: globalThis, module: await loadDemoModule('dataRepair'), onBlocked: (key) => blocked.push(key) });
  assert.equal(scanLedgerHealth(JSON.parse(localStorage.getItem(HOLDINGS_LEDGER_KEY)).transactions).ghostCount, 2);
  const result = await runRepairLikePage('');
  assert.equal(result.demo, true);
  assert.equal(result.dictSize, 16);
  assert.equal(result.quoteFetched, false);
  assert.equal(result.deleted, 2);
  assert.equal(result.fixed, 4, '2 placeholder names + 2 kind mismatches');
  assert.equal(result.after.healthy, true, 'repaired → healthy');
  assert.equal(await fillExchangeNames(['513999'], new Map()), false, 'quotes never fetched during the demo');
  assert.equal(scheduleHoldingTransactionRetry(0), false, 'no sync write-back during the demo');
  assert.equal(globalThis.r, undefined, 'eastmoney dictionary script not injected');
  assert.deepEqual(blocked, []);
  assert.deepEqual(realCalls, [], 'no request leaves the browser');
  assert.equal(env.dirty, true, 'page reloads on exit to drop in-memory state');
  env.uninstall();
  for (const [key, value] of Object.entries(real)) assert.equal(storage.map.get(key), value, key);
  assert.equal(readDemoSession('dataRepair', { storage }), null, 'repair results are discarded, not kept');
});

test('logged-in without access (real token): mock cloud rows, PUT / DELETE 403 and sync baseline not advanced, runtime / journal untouched', async () => {
  const session = { accessToken: 'real-user-token', username: 'u1', userId: 'uid-1' };
  const journalKey = `${HOLDINGS_JOURNAL_PREFIX}uid-1`;
  const storage = new FakeStorage({ aiDcaCloudSyncSession: JSON.stringify(session), [journalKey]: '{"entries":{"real-1":{}}}', [HOLDINGS_SYNC_STATE_KEY]: REAL_SYNC, aiDcaAnalyticsOptOut_v1: '1' });
  globalThis.localStorage = storage;
  setAccountRuntimeStorageRaw(HOLDINGS_LEDGER_KEY, REAL_LEDGER);
  const blocked = [];
  const env = installFeatureDemo('dataRepair', { win: globalThis, module: await loadDemoModule('dataRepair'), onBlocked: (key) => blocked.push(key) });
  assert.equal(storage.getItem(journalKey), null, 'real pending journal hidden during the demo');
  const result = await runRepairLikePage(session.accessToken);
  assert.equal(result.remoteRows, 16);
  assert.equal(result.cloudWrites, 6, '2 ghost deletes + 4 fixes');
  assert.equal(result.readonly, 6, 'every cloud write is DEMO_READONLY');
  assert.equal(result.syncRows, 0, 'sync baseline not advanced by blocked writes');
  assert.equal(result.after.healthy, true);
  assert.equal(blocked.filter((key) => key.startsWith('DELETE ')).length, 2);
  assert.equal(blocked.filter((key) => key.startsWith('PUT ')).length, 4);
  assert.ok(blocked.every((key) => key.includes(`${BASE}/holdings/ledger/items/`)));
  assert.equal(scheduleHoldingTransactionRetry(0), false);
  assert.deepEqual(realCalls, [], 'no request leaves the browser');
  env.uninstall();
  assert.equal(readAccountRuntimeStorageRaw(HOLDINGS_LEDGER_KEY), REAL_LEDGER, 'real account runtime ledger untouched');
  assert.equal(storage.map.get(HOLDINGS_SYNC_STATE_KEY), REAL_SYNC);
  assert.equal(storage.map.get(journalKey), '{"entries":{"real-1":{}}}');
  assert.equal(readDemoSession('dataRepair', { storage }), null);
});

test('nothing to import: a stale dataRepair session is dropped without touching the account ledger', async () => {
  const storage = new FakeStorage({ [HOLDINGS_LEDGER_KEY]: REAL_LEDGER });
  saveDemoSession('dataRepair', [[HOLDINGS_LEDGER_KEY, JSON.stringify(buildDataRepairDemoLedger())]], { storage });
  assert.deepEqual(await importDemoSessions({ canAccess: () => true, storage }), ['dataRepair']);
  assert.equal(storage.getItem(HOLDINGS_LEDGER_KEY), REAL_LEDGER, 'no keepKeys → demo ledger never written to the account');
  assert.deepEqual(realCalls, []);
});

test('outside the demo: real cloud writes are unchanged (not treated as readonly), dictionary does not hit the demo route', async () => {
  globalThis.localStorage = new FakeStorage();
  const row = { id: 'real-1', revision: 3 };
  const put = await writeLedgerRow({ base: BASE, token: 'real', row, data: { code: '513100' } });
  assert.equal(put.demoReadonly, false);
  assert.equal(put.json.rowRevision, 9);
  assert.equal((await writeLedgerRow({ base: BASE, token: 'real', row })).demoReadonly, false);
  assert.deepEqual(realCalls, [`PUT https://fast.example${BASE}/holdings/ledger/items/real-1`, `DELETE https://fast.example${BASE}/holdings/ledger/items/real-1`]);
  globalThis.r = Array.from({ length: 6000 }, (_, i) => [String(i).padStart(6, '0'), '', `F${i}`, 'x', '']);
  try {
    const { fundMap, demo } = await loadFundDictionary();
    assert.equal(demo, false);
    assert.equal(fundMap.size, 6000);
  } finally {
    delete globalThis.r;
  }
  assert.equal(realCalls.length, 2);
});

test('no regression: demo-token GET without a mock → 503, writes → 403 for both tokens', async () => {
  const mod = await loadDemoModule('dataRepair');
  let hits = 0;
  const f = createDemoFetch({ realFetch: async () => { hits += 1; return new Response('{}'); }, fixtures: mod.createFixtures({}).routes, origin: 'https://x.example' });
  const auth = { headers: { authorization: `Bearer ${DEMO_ACCESS_TOKEN}` } };
  for (const host of ['', 'https://api.freebacktrack.tech']) {
    assert.equal((await (await f(`${host}${BASE}/holdings/ledger/items?limit=1000`, auth)).json()).rows.length, 16, host);
    assert.equal((await (await f(`${host}${DEMO_FUND_DICTIONARY_PATH}`)).json()).items.length, 16, host);
  }
  const missing = await f(`${BASE}/holdings/ledger/items/x`, auth);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'DEMO_NO_FIXTURE');
  for (const method of ['PUT', 'DELETE']) {
    for (const token of [DEMO_ACCESS_TOKEN, 'real']) {
      const write = await f(`${BASE}/holdings/ledger/items/demo-hold-159513-b1`, { method, headers: { authorization: `Bearer ${token}` } });
      assert.equal(write.status, 403, `${method} ${token}`);
      assert.equal((await write.json()).code, DEMO_READONLY_CODE);
    }
  }
  assert.equal(hits, 0);
});
