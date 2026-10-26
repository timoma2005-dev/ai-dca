// 登录合并门禁打开期间：所有云端写入在最底层统一拦截；确认流程显式 bypass 才能推送。
import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

globalThis.window = {
  localStorage: new MemoryStorage(),
  location: { origin: 'http://localhost', hostname: 'localhost', pathname: '/', search: '', hash: '' },
  navigator: {},
  addEventListener() {},
  removeEventListener() {},
  setTimeout: () => 0,
  clearTimeout() {},
  dispatchEvent() { return true; }
};
if (typeof globalThis.document === 'undefined') globalThis.document = { referrer: '' };

const { deleteAccountResource, putAccountResourceItem } = await import('../src/app/accountApi.js');
const { pushResource } = await import('../src/app/resourceSync.js');
const {
  HOLDING_TRANSACTION_SYNC_STATE_KEY,
  pendingHoldingTransactionJournalKey,
  pushHoldingTransactionRows,
  pushHoldingTransactions,
  readCurrentHoldingTransactions
} = await import('../src/app/holdingTransactionsSync.js');
const {
  describeHoldingTransactionSync,
  persistDeletedHoldingTransaction,
  persistHoldingTransactionMutation
} = await import('../src/app/holdingTransactionMutations.js');
const { applyLoginSyncChoices } = await import('../src/app/loginSyncActions.js');
const { computeLoginSyncDiff, uniformLoginSyncChoices } = await import('../src/app/loginSyncDiff.js');
const { clearLoginSyncPending, LOGIN_SYNC_BLOCKED_CODE, markLoginSyncPending } = await import('../src/app/loginSyncGate.js');

const ls = globalThis.window.localStorage;
const tx = (id, extra = {}) => ({ id, code: '161725', date: '2026-01-02', type: 'BUY', shares: 100, price: 1, amount: 100, ...extra });

function login(userId) {
  ls.setItem('aiDcaCloudSyncSession', JSON.stringify({ userId, username: `u-${userId}`, accessToken: `tok-${userId}` }));
  return JSON.parse(ls.getItem('aiDcaCloudSyncSession'));
}

function jsonResponse(data, status = 200) {
  return new globalThis.Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method || 'GET').toUpperCase() });
    return handler(String(url), init);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const noRequest = (url) => { throw new Error(`门禁打开期间不应发出请求：${url}`); };
const isBlocked = (error) => error?.code === LOGIN_SYNC_BLOCKED_CODE && /数据未同步/.test(error.message);

test('门禁打开：手动保存交易不发请求，本地保留且行保持 pending，提示不是「同步失败」', async () => {
  const session = login('gate-u1');
  markLoginSyncPending('gate-u1');
  await withMockFetch(noRequest, async (calls) => {
    const result = await persistHoldingTransactionMutation({ transactions: [tx('a')] }, { kind: 'save', label: '保存', upsertIds: ['a'] });
    assert.equal(calls.length, 0);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(readCurrentHoldingTransactions().map((row) => row.id), ['a'], '本地保存不回滚');
    const state = JSON.parse(ls.getItem(HOLDING_TRANSACTION_SYNC_STATE_KEY));
    assert.equal(state.rows.a.pending, true);
    assert.ok(state.pendingLocalIds.includes('a'));
    assert.ok(JSON.parse(ls.getItem(pendingHoldingTransactionJournalKey(session.userId))).entries.a, 'journal 保留待上传改动');
    const text = describeHoldingTransactionSync(result, '161725 BUY');
    assert.doesNotMatch(text, /同步失败/);
    assert.match(text, /数据未同步，处理数据同步后会上传/);

    const removed = await persistDeletedHoldingTransaction({ ledger: { transactions: [tx('a'), tx('b')] }, txId: 'b' });
    assert.equal(removed.blocked, true);
    const direct = await pushHoldingTransactionRows({ session, upsertIds: ['a'] });
    assert.equal(direct.blocked, true);
    const all = await pushHoldingTransactions({ session, force: true });
    assert.equal(all.blocked, true);
    assert.equal(calls.length, 0);
  });
  clearLoginSyncPending();
});

test('门禁打开：资源 PUT / 单项 PUT / 删除在底层被拦，不发请求', async () => {
  const session = login('gate-u2');
  markLoginSyncPending('gate-u2');
  ls.setItem('aiDcaPlanStore', JSON.stringify({ plans: [{ id: 'p1' }] }));
  await withMockFetch(noRequest, async (calls) => {
    await assert.rejects(pushResource('plans/store', { force: true, session }), isBlocked);
    await assert.rejects(putAccountResourceItem('plans/store', 'p1', { id: 'p1' }, session), isBlocked);
    await assert.rejects(deleteAccountResource('plans/store', session), isBlocked);
    assert.equal(calls.length, 0);
  });
  assert.ok(ls.getItem('aiDcaPlanStore'), '本地资源保留');
  clearLoginSyncPending();
});

test('门禁只挡当前账号：其它账号的门禁不影响写入判断', async () => {
  const session = login('gate-u3');
  markLoginSyncPending('someone-else');
  await withMockFetch(noRequest, async () => {
    await assert.rejects(putAccountResourceItem('plans/store', 'p1', {}, session), (error) => !isBlocked(error));
  });
  clearLoginSyncPending();
});

function confirmFetchHandler(url, init) {
  if (url.endsWith('/migrations/legacy')) return jsonResponse({ status: 'imported', legacy: { exists: true } });
  const method = String(init.method || 'GET').toUpperCase();
  const row = url.match(/\/holdings\/ledger\/items\/([^/?]+)$/);
  if (row && method === 'PUT') return jsonResponse({ transaction: { id: decodeURIComponent(row[1]), revision: 1, contentHash: 'h1' }, rowRevision: 1 });
  if (url.endsWith('/plans/store') && method === 'PUT') return jsonResponse({ revision: 2, contentHash: 'c2', updatedAt: 'now' });
  throw new Error(`unexpected request: ${method} ${url}`);
}

test('确认执行时显式 bypass：门禁仍打开也能推送交易行与资源', async () => {
  const session = login('gate-u4');
  markLoginSyncPending('gate-u4');
  ls.setItem('aiDcaFundHoldingsLedger', JSON.stringify({ transactions: [tx('c')] }));
  ls.setItem('aiDcaPlanStore', JSON.stringify({ plans: [{ id: 'p1' }] }));
  await withMockFetch(confirmFetchHandler, async (calls) => {
    const rows = await pushHoldingTransactionRows({ session, upsertIds: ['c'], bypassLoginSyncGate: true });
    assert.deepEqual(rows.pushed, ['c']);
    const resource = await pushResource('plans/store', { force: true, session, bypassLoginSyncGate: true });
    assert.equal(resource.revision, 2);
    assert.ok(calls.some((call) => call.method === 'PUT' && /\/holdings\/ledger\/items\/c$/.test(call.url)));
    assert.ok(calls.some((call) => call.method === 'PUT' && /\/plans\/store$/.test(call.url)));
  });
  clearLoginSyncPending();
});

test('确认流程：每个写云端调用都带 bypassLoginSyncGate，且清空被拦截改动的 journal', async () => {
  const session = login('gate-u5');
  ls.setItem(pendingHoldingTransactionJournalKey('gate-u5'), JSON.stringify({ version: 1, userId: 'gate-u5', entries: { z: { kind: 'delete' } } }));
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); return { pushed: [], deleted: [], failed: [] }; };
  const deps = {
    deleteAccountResource: record('deleteAccountResource'),
    pushResource: record('pushResource'),
    pullResources: record('pullResources'),
    pushHoldingTransactions: record('pushHoldingTransactions'),
    pullHoldingTransactions: record('pullHoldingTransactions'),
    writeLocalResource: () => true,
    writeLocalTransactions: () => true,
    resetHoldingSyncState: (await import('../src/app/loginSyncActions.js')).resetHoldingSyncStateForLogin
  };
  const sides = {
    resources: ['trades/ledger', 'plans/store'],
    localResources: { 'trades/ledger': '[{"id":"t1"}]' },
    remoteResources: { 'plans/store': { data: { plans: [{ id: 'p1' }] } } },
    localTransactions: [tx('a')],
    remoteTransactions: [tx('b')]
  };
  const diff = computeLoginSyncDiff(sides);
  await applyLoginSyncChoices({ sides, diff, choices: uniformLoginSyncChoices(diff.items, 'local'), session, deps });
  await applyLoginSyncChoices({ sides, diff, choices: uniformLoginSyncChoices(diff.items, 'merge'), session, deps });
  const writes = calls.filter(([name]) => name !== 'deleteAccountResource');
  assert.ok(writes.length >= 4);
  for (const [name, ...args] of writes) {
    const options = name === 'pushResource' ? args[1] : args[0];
    assert.equal(options?.bypassLoginSyncGate, true, `${name} 必须显式 bypass`);
  }
  for (const deletion of calls.filter(([name]) => name === 'deleteAccountResource')) {
    assert.equal(deletion[3]?.bypassLoginSyncGate, true);
  }
  assert.equal(ls.getItem(pendingHoldingTransactionJournalKey('gate-u5')), null);
});
