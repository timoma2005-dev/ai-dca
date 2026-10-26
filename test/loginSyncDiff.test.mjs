import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

const events = [];
globalThis.window = {
  localStorage: new MemoryStorage(),
  location: { origin: 'http://localhost', hostname: 'localhost', pathname: '/', search: '', hash: '' },
  navigator: {},
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout() {},
  dispatchEvent(event) { events.push(event); return true; }
};
if (typeof globalThis.document === 'undefined') globalThis.document = { referrer: '' };

const {
  computeLoginSyncDiff,
  defaultLoginSyncChoices,
  diffResource,
  diffTransactionRows,
  hasLocalAccountData,
  hasRemoteAccountData,
  LOGIN_SYNC_CHOICES,
  uniformLoginSyncChoices
} = await import('../src/app/loginSyncDiff.js');
const { applyLoginSyncChoices } = await import('../src/app/loginSyncActions.js');
const { confirmLoginSync, getPendingLoginSyncDiff, resetLoginSyncFlowForTest, runLoginAccountSync } = await import('../src/app/loginSyncFlow.js');
const { clearLoginSyncPending, isLoginSyncPending, LOGIN_SYNC_DIFF_EVENT, markLoginSyncPending } = await import('../src/app/loginSyncGate.js');

const SESSION_KEY = 'aiDcaCloudSyncSession';
function login(userId) {
  globalThis.window.localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, username: `u-${userId}`, accessToken: `tok-${userId}` }));
  return JSON.parse(globalThis.window.localStorage.getItem(SESSION_KEY));
}

const tx = (id, extra = {}) => ({ id, code: '161725', date: '2026-01-02', type: 'BUY', shares: 100, amount: 0, ...extra });

// ---------------------------------------------------------------------------
// 差异计算
// ---------------------------------------------------------------------------

test('资源 diff：内容一致（仅时间戳不同）视为无差异', () => {
  const remote = { data: { plans: [{ id: 'p1', name: 'A', updatedAt: '2026-01-01' }], savedAt: '2026-01-01' }, updatedAt: '2026-01-01' };
  const localRaw = JSON.stringify({ savedAt: '2026-02-02', plans: [{ name: 'A', id: 'p1', updatedAt: '2026-02-02' }] });
  assert.equal(diffResource({ resource: 'plans/store', localRaw, remote }), null);
  assert.equal(diffResource({ resource: 'plans/store', localRaw: null, remote: null }), null);
  assert.equal(diffResource({ resource: 'plans/store', localRaw: '[]', remote: { data: [] } }), null);
});

test('资源 diff：数组资源按条目 id 给出仅本地 / 仅云端 / 内容不同', () => {
  const localRaw = JSON.stringify([{ id: 't1', name: '甲', qty: 1 }, { id: 't2', name: '乙', qty: 2 }]);
  const remote = { data: [{ id: 't2', name: '乙', qty: 3 }, { id: 't3', name: '丙', qty: 1 }], updatedAt: '2026-03-01T00:00:00Z' };
  const item = diffResource({ resource: 'trades/ledger', localRaw, remote });
  assert.equal(item.label, '交易流水');
  assert.equal(item.kind, 'resource');
  assert.deepEqual(item.entries.localOnly.map((entry) => entry.key), ['t1']);
  assert.deepEqual(item.entries.remoteOnly.map((entry) => entry.key), ['t3']);
  assert.deepEqual(item.entries.changed.map((entry) => entry.label), ['乙']);
  assert.equal(item.local.count, 2);
  assert.equal(item.remote.count, 2);
  assert.equal(item.remote.updatedAt, '2026-03-01T00:00:00Z');
});

test('资源 diff：对象内的主列表字段按条目比较；一侧缺失也算差异', () => {
  const localRaw = JSON.stringify({ lists: [{ id: 'w1', name: '自选一', symbols: ['a'] }], activeListId: 'w1' });
  const item = diffResource({ resource: 'markets/watchlist', localRaw, remote: null });
  assert.equal(item.local.field, 'lists');
  assert.equal(item.remote.exists, false);
  assert.deepEqual(item.entries.localOnly.map((entry) => entry.label), ['自选一']);
  const settings = diffResource({ resource: 'prefs/workspace', localRaw: JSON.stringify({ theme: 'dark' }), remote: { data: { theme: 'light', dense: true } } });
  assert.deepEqual(settings.entries.changed.map((entry) => entry.key), ['theme']);
  assert.deepEqual(settings.entries.remoteOnly.map((entry) => entry.key), ['dense']);
});

test('按行 diff：持仓交易按 id 比较并给出展示摘要', () => {
  const item = diffTransactionRows(
    [tx('a'), tx('b', { shares: 200 }), tx('c', { type: 'SELL' })],
    [tx('b', { shares: 300 }), tx('c', { type: 'SELL', updatedAt: 'x' }), tx('d', { amount: 1000, shares: 0 })]
  );
  assert.equal(item.kind, 'transactions');
  assert.equal(item.id, 'holdings/ledger');
  assert.deepEqual(item.rows.localOnly.map((row) => row.id), ['a']);
  assert.deepEqual(item.rows.remoteOnly.map((row) => row.id), ['d']);
  assert.deepEqual(item.rows.changed.map((row) => row.id), ['b']);
  assert.equal(item.rows.changed[0].local.shares, 200);
  assert.equal(item.rows.changed[0].remote.shares, 300);
  assert.deepEqual(item.rows.remoteOnly[0], { id: 'd', code: '161725', name: '', date: '2026-01-02', type: 'BUY', shares: 0, amount: 1000 });
  assert.deepEqual(item.remoteOnlyIds, ['d']);
  assert.equal(diffTransactionRows([tx('a')], [tx('a')]), null);
});

test('整体 diff：交易行排在最前，无差异时 hasDiff=false；有无数据判定', () => {
  const sides = {
    resources: ['trades/ledger', 'plans/store'],
    localResources: { 'trades/ledger': '[{"id":"t1"}]' },
    remoteResources: { 'trades/ledger': { data: [{ id: 't1' }] }, 'plans/store': { data: { plans: [{ id: 'p' }] } } },
    localTransactions: [tx('a')],
    remoteTransactions: []
  };
  const diff = computeLoginSyncDiff(sides);
  assert.equal(diff.hasDiff, true);
  assert.deepEqual(diff.items.map((item) => item.id), ['holdings/ledger', 'plans/store']);
  assert.deepEqual(defaultLoginSyncChoices(diff.items), { 'holdings/ledger': 'merge', 'plans/store': 'merge' });
  assert.deepEqual(uniformLoginSyncChoices(diff.items, 'local'), { 'holdings/ledger': 'local', 'plans/store': 'local' });
  assert.deepEqual(uniformLoginSyncChoices(diff.items, 'bogus'), { 'holdings/ledger': 'merge', 'plans/store': 'merge' });
  assert.equal(computeLoginSyncDiff({ ...sides, localTransactions: [], remoteResources: { 'trades/ledger': { data: [{ id: 't1' }] } } }).hasDiff, false);
  assert.equal(hasLocalAccountData({ localResources: { a: '[]' }, localTransactions: [] }), false);
  assert.equal(hasLocalAccountData({ localResources: {}, localTransactions: [tx('a')] }), true);
  assert.equal(hasRemoteAccountData({ remoteResources: { a: { data: {} } }, remoteTransactions: [] }), false);
  assert.equal(hasRemoteAccountData({ remoteResources: { a: { data: [1] } }, remoteTransactions: [] }), true);
});

// ---------------------------------------------------------------------------
// 执行：注入 deps，不触网、不写线上库
// ---------------------------------------------------------------------------

function fakeDeps(overrides = {}) {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); return {}; };
  const deps = {
    listResourceNames: () => ['trades/ledger', 'plans/store', 'dca/store'],
    fetchAccountManifest: async () => ({ resources: [] }),
    fetchAccountBundle: async () => ({ resources: {} }),
    fetchHoldingTransactionRows: async () => ({ rows: [], nextCursor: '' }),
    readLocalResourceRaw: () => null,
    readLocalTransactions: () => [],
    deleteAccountResource: record('deleteAccountResource'),
    pushResource: record('pushResource'),
    pullResources: record('pullResources'),
    pushHoldingTransactions: async (options) => { calls.push(['pushHoldingTransactions', options]); return { pushed: [], deleted: [], failed: [] }; },
    pullHoldingTransactions: record('pullHoldingTransactions'),
    writeLocalResource: (...args) => { calls.push(['writeLocalResource', ...args]); return true; },
    writeLocalTransactions: (...args) => { calls.push(['writeLocalTransactions', ...args]); return true; },
    resetHoldingSyncState: () => { calls.push(['resetHoldingSyncState']); return true; },
    ...overrides
  };
  return { deps, calls };
}

const SIDES = {
  resources: ['trades/ledger', 'plans/store', 'dca/store', 'sell-plans/store'],
  localResources: { 'trades/ledger': '[{"id":"t1"}]', 'dca/store': '{"plans":[{"id":"d1"}]}' },
  remoteResources: {
    'trades/ledger': { data: [{ id: 't2' }] },
    'plans/store': { data: { plans: [{ id: 'p1' }] } },
    'sell-plans/store': { data: [{ id: 's1' }] }
  },
  localTransactions: [tx('a'), tx('b')],
  remoteTransactions: [tx('b', { shares: 9 }), tx('c')]
};
const DIFF = computeLoginSyncDiff(SIDES);

test('执行：逐项三种选择各自走正确写入路径', async () => {
  const { deps, calls } = fakeDeps();
  const choices = {
    'trades/ledger': 'local',
    'plans/store': 'local', // 本地没有 → 删除云端
    'dca/store': 'remote', // 云端没有 → 删除本地
    'sell-plans/store': 'merge', // 本地没有 → 走拉取合并
    'holdings/ledger': 'merge'
  };
  const result = await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices, session: { userId: 'u' }, deps });
  assert.deepEqual(result.failed, []);
  const names = calls.map((call) => call[0]);
  assert.deepEqual(calls.find((call) => call[0] === 'pushResource').slice(1, 2), ['trades/ledger']);
  assert.equal(calls.find((call) => call[0] === 'pushResource')[2].force, true);
  assert.deepEqual(calls.find((call) => call[0] === 'deleteAccountResource').slice(1, 2), ['plans/store']);
  assert.deepEqual(calls.find((call) => call[0] === 'writeLocalResource').slice(1), ['dca/store', null]);
  assert.deepEqual(calls.find((call) => call[0] === 'pullResources')[1].resources, ['sell-plans/store']);
  // 交易行合并：先清基线 → 强制拉取（同 id 云端优先）→ 回传本地独有
  const txCalls = names.slice(names.indexOf('resetHoldingSyncState'));
  assert.deepEqual(txCalls, ['resetHoldingSyncState', 'pullHoldingTransactions', 'pushHoldingTransactions']);
  assert.equal(calls.find((call) => call[0] === 'pullHoldingTransactions')[1].force, true);
  assert.notEqual(calls.find((call) => call[0] === 'pushHoldingTransactions')[1].force, true);
});

test('执行：保留云端 → 云端整体替换本地后拉取登记；交易行只保留云端行', async () => {
  const { deps, calls } = fakeDeps();
  await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices: { 'trades/ledger': 'remote', 'holdings/ledger': 'remote' }, session: {}, deps });
  const write = calls.find((call) => call[0] === 'writeLocalResource' && call[1] === 'trades/ledger');
  assert.deepEqual(JSON.parse(write[2]), [{ id: 't2' }]);
  const pull = calls.find((call) => call[0] === 'pullResources');
  assert.ok(pull[1].resources.includes('trades/ledger'));
  assert.equal(pull[1].force, true);
  const txWrite = calls.find((call) => call[0] === 'writeLocalTransactions');
  assert.deepEqual(txWrite[1].map((row) => row.id), ['b', 'c']);
  assert.ok(!calls.some((call) => call[0] === 'pushHoldingTransactions'), '云端覆盖本地不推送交易行');
});

test('全局：全部本地覆盖云端 → 只写云端（PUT/删除/逐行强推并删云端多余行），不写本地', async () => {
  const { deps, calls } = fakeDeps();
  await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices: uniformLoginSyncChoices(DIFF.items, LOGIN_SYNC_CHOICES.LOCAL), session: {}, deps });
  const names = calls.map((call) => call[0]);
  assert.ok(!names.includes('writeLocalResource'));
  assert.ok(!names.includes('writeLocalTransactions'));
  assert.ok(!names.includes('pullResources'));
  assert.ok(!names.includes('pullHoldingTransactions'));
  assert.deepEqual(calls.filter((call) => call[0] === 'pushResource').map((call) => call[1]).sort(), ['dca/store', 'trades/ledger']);
  assert.deepEqual(calls.filter((call) => call[0] === 'deleteAccountResource').map((call) => call[1]).sort(), ['plans/store', 'sell-plans/store']);
  const push = calls.find((call) => call[0] === 'pushHoldingTransactions')[1];
  assert.equal(push.force, true);
  assert.deepEqual(push.deletedIds, ['c']);
});

test('全局：全部云端覆盖本地 → 只写本地，本地独有删除，不向云端写', async () => {
  const { deps, calls } = fakeDeps();
  await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices: uniformLoginSyncChoices(DIFF.items, LOGIN_SYNC_CHOICES.REMOTE), session: {}, deps });
  const names = calls.map((call) => call[0]);
  assert.ok(!names.includes('pushResource'));
  assert.ok(!names.includes('deleteAccountResource'));
  assert.ok(!names.includes('pushHoldingTransactions'));
  assert.deepEqual(calls.find((call) => call[0] === 'writeLocalResource' && call[1] === 'dca/store').slice(1), ['dca/store', null]);
  assert.deepEqual(calls.find((call) => call[0] === 'pullResources')[1].resources.sort(), ['plans/store', 'sell-plans/store', 'trades/ledger']);
});

test('执行：单项失败被收集，不中断其它项', async () => {
  const { deps } = fakeDeps({ pushResource: async () => { throw new Error('boom'); } });
  const result = await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices: { 'trades/ledger': 'local' }, session: {}, deps });
  assert.equal(result.failed[0].id, 'trades/ledger');
  assert.ok(result.pulled.length > 0);
});

// ---------------------------------------------------------------------------
// 登录编排
// ---------------------------------------------------------------------------

function fakeCloudSync({ remoteVersion = 0 } = {}) {
  const calls = [];
  return {
    calls,
    refreshRemoteCloudMeta: async () => { calls.push('refreshRemoteCloudMeta'); return { version: remoteVersion }; },
    ensureLocalChangeBaseline: () => { calls.push('ensureLocalChangeBaseline'); },
    restoreEncryptedCloudBackup: async () => { calls.push('restore'); return {}; },
    uploadEncryptedCloudBackup: async (options) => { calls.push(['upload', options]); return { skipped: false }; },
    startCloudAutoSync: () => { calls.push('start'); return true; }
  };
}

function sidesDeps({ remoteResources = {}, remoteRows = [], localResources = {}, localTransactions = [] } = {}) {
  const names = ['trades/ledger', 'plans/store'];
  return fakeDeps({
    listResourceNames: () => names,
    fetchAccountManifest: async () => ({ resources: Object.keys(remoteResources).map((resource) => ({ resource, revision: 1 })) }),
    fetchAccountBundle: async () => ({ resources: Object.fromEntries(Object.entries(remoteResources).map(([key, data]) => [key, { data, revision: 1 }])) }),
    fetchHoldingTransactionRows: async () => ({ rows: remoteRows.map((row) => ({ id: row.id, revision: 1, data: row })), nextCursor: '' }),
    readLocalResourceRaw: (name) => (name in localResources ? localResources[name] : null),
    readLocalTransactions: () => localTransactions
  });
}

function diffEvents() {
  return events.filter((event) => event.type === LOGIN_SYNC_DIFF_EVENT);
}

test('登录云端为空的账号：强制上传本机数据，不弹窗，解除门禁并启动自动同步', async () => {
  resetLoginSyncFlowForTest();
  const session = login('u-empty');
  const before = diffEvents().length;
  const cloudSync = fakeCloudSync();
  const { deps } = sidesDeps({ localResources: { 'trades/ledger': '[{"id":"t1"}]' } });
  const status = await runLoginAccountSync(cloudSync, { action: 'login', session, deps, demoActive: false });
  assert.equal(status, 'uploaded');
  assert.deepEqual(cloudSync.calls.find((call) => Array.isArray(call) && call[0] === 'upload')[1], { force: true });
  assert.ok(cloudSync.calls.includes('start'));
  assert.equal(diffEvents().length, before);
  assert.equal(isLoginSyncPending(session), false);
});

test('登录云端为空且本机无数据：跳过上传', async () => {
  resetLoginSyncFlowForTest();
  const session = login('u-empty2');
  const cloudSync = fakeCloudSync();
  const { deps } = sidesDeps();
  const status = await runLoginAccountSync(cloudSync, { action: 'login', session, deps, demoActive: false });
  assert.equal(status, 'no-remote');
  assert.ok(!cloudSync.calls.some((call) => Array.isArray(call) && call[0] === 'upload'));
});

test('注册：不弹窗，保持原逻辑（云端空强制上传）', async () => {
  resetLoginSyncFlowForTest();
  const session = login('u-reg');
  const before = diffEvents().length;
  const cloudSync = fakeCloudSync();
  const { deps, calls } = sidesDeps({ localResources: { 'trades/ledger': '[{"id":"t1"}]' } });
  const status = await runLoginAccountSync(cloudSync, { action: 'register', session, deps, demoActive: false });
  assert.equal(status, 'uploaded');
  assert.equal(diffEvents().length, before);
  assert.equal(calls.length, 0, '注册不读取 diff');
  assert.equal(isLoginSyncPending(session), false);
});

test('登录云端有数据且无差异：直接走原拉取', async () => {
  resetLoginSyncFlowForTest();
  const session = login('u-same');
  const cloudSync = fakeCloudSync({ remoteVersion: 1 });
  const { deps } = sidesDeps({ remoteResources: { 'trades/ledger': [{ id: 't1' }] }, localResources: { 'trades/ledger': '[{"id":"t1"}]' } });
  const status = await runLoginAccountSync(cloudSync, { action: 'login', session, deps, demoActive: false });
  assert.equal(status, 'pulled');
  assert.ok(cloudSync.calls.includes('restore'));
  assert.equal(isLoginSyncPending(session), false);
});

test('登录云端有数据且有差异：弹窗、保持门禁、不启动自动同步；确认后执行并启动', async () => {
  resetLoginSyncFlowForTest();
  const session = login('u-diff');
  const before = diffEvents().length;
  const cloudSync = fakeCloudSync({ remoteVersion: 1 });
  const { deps, calls } = sidesDeps({
    remoteResources: { 'trades/ledger': [{ id: 't2' }] },
    remoteRows: [tx('r1')],
    localResources: { 'trades/ledger': '[{"id":"t1"}]' },
    localTransactions: [tx('l1')]
  });
  const status = await runLoginAccountSync(cloudSync, { action: 'login', session, deps, demoActive: false });
  assert.equal(status, 'diff-pending');
  assert.equal(diffEvents().length, before + 1);
  assert.ok(!cloudSync.calls.includes('restore'));
  assert.ok(!cloudSync.calls.includes('start'));
  assert.equal(isLoginSyncPending(session), true);
  const pending = getPendingLoginSyncDiff(session);
  assert.deepEqual(pending.diff.items.map((item) => item.id), ['holdings/ledger', 'trades/ledger']);

  const result = await confirmLoginSync({ 'trades/ledger': 'local', 'holdings/ledger': 'remote' }, { session, deps, cloudSync });
  assert.deepEqual(result.failed, []);
  assert.ok(calls.some((call) => call[0] === 'pushResource' && call[1] === 'trades/ledger'));
  assert.ok(calls.some((call) => call[0] === 'writeLocalTransactions'));
  assert.ok(cloudSync.calls.includes('start'));
  assert.equal(isLoginSyncPending(session), false);
  assert.equal(getPendingLoginSyncDiff(session), null);
});

test('切换账号：A 的门禁不影响 B；B 登录同样弹窗，A 的待确认差异对 B 不可见', async () => {
  resetLoginSyncFlowForTest();
  const sessionA = login('u-a');
  const cloudSync = fakeCloudSync({ remoteVersion: 1 });
  const { deps } = sidesDeps({ remoteResources: { 'trades/ledger': [{ id: 'b-only' }] }, localResources: { 'trades/ledger': '[{"id":"a-data"}]' } });
  assert.equal(await runLoginAccountSync(cloudSync, { action: 'login', session: sessionA, deps, demoActive: false }), 'diff-pending');
  const sessionB = login('u-b');
  assert.equal(isLoginSyncPending(sessionB), false);
  assert.equal(getPendingLoginSyncDiff(sessionB), null);
  await assert.rejects(() => confirmLoginSync({}, { session: sessionB, deps, cloudSync }));
  markLoginSyncPending('u-b');
  assert.equal(isLoginSyncPending(sessionB), true);
  assert.equal(await runLoginAccountSync(cloudSync, { action: 'login', session: sessionB, deps, demoActive: false }), 'diff-pending');
  assert.equal(getPendingLoginSyncDiff(sessionB).userId, 'u-b');
  assert.ok(!cloudSync.calls.includes('restore'), 'A 的本机数据不会被静默并入 B');
  clearLoginSyncPending();
});

test('确认时部分失败：保持门禁，不启动自动同步', async () => {
  resetLoginSyncFlowForTest();
  const session = login('u-fail');
  const cloudSync = fakeCloudSync({ remoteVersion: 1 });
  const { deps } = sidesDeps({ remoteResources: { 'trades/ledger': [{ id: 't2' }] }, localResources: { 'trades/ledger': '[{"id":"t1"}]' } });
  await runLoginAccountSync(cloudSync, { action: 'login', session, deps, demoActive: false });
  const failing = { ...deps, pushResource: async () => { throw new Error('网络错误'); } };
  await assert.rejects(() => confirmLoginSync({ 'trades/ledger': 'local' }, { session, deps: failing, cloudSync }), /同步失败/);
  assert.equal(isLoginSyncPending(session), true);
  assert.ok(!cloudSync.calls.includes('start'));
  clearLoginSyncPending();
});
