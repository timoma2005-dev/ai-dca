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
  applyLoginSyncBaseline,
  buildLoginSyncBaseline,
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

test('整体 diff：只问本机有、云端也有且本机有云端没有的内容；交易行排在最前', () => {
  const sides = {
    resources: ['trades/ledger', 'plans/store', 'dca/store', 'plans/state'],
    localResources: {
      'trades/ledger': '[{"id":"t1"},{"id":"t9"}]',
      'dca/store': '{"plans":[{"id":"d1"}]}',
      'plans/state': '{"view":"grid"}'
    },
    remoteResources: {
      'trades/ledger': { data: [{ id: 't1' }] },
      'plans/store': { data: { plans: [{ id: 'p' }] } },
      'plans/state': { data: { view: 'list' } }
    },
    localTransactions: [tx('a')],
    remoteTransactions: [tx('a', { shares: 5 })]
  };
  const diff = computeLoginSyncDiff(sides);
  assert.equal(diff.hasDiff, true);
  // plans/store 本机为空 → 以云端为准；plans/state 偏好 → 以云端为准；dca/store 云端为空 → 自动上传
  assert.deepEqual(diff.items.map((item) => item.id), ['holdings/ledger', 'trades/ledger']);
  assert.deepEqual(diff.autoItems.map((item) => item.id), ['dca/store']);
  assert.deepEqual(defaultLoginSyncChoices(diff.items), { 'holdings/ledger': 'merge', 'trades/ledger': 'merge' });
  assert.deepEqual(uniformLoginSyncChoices(diff.items, 'local'), { 'holdings/ledger': 'local', 'trades/ledger': 'local' });
  assert.deepEqual(uniformLoginSyncChoices(diff.items, 'bogus'), { 'holdings/ledger': 'merge', 'trades/ledger': 'merge' });
  // 本机是云端子集（只有仅云端条目）：不问
  const subset = computeLoginSyncDiff({ resources: ['trades/ledger'], localResources: { 'trades/ledger': '[{"id":"t1"}]' }, remoteResources: { 'trades/ledger': { data: [{ id: 't1' }, { id: 't2' }] } }, localTransactions: [tx('a')], remoteTransactions: [tx('a'), tx('b')] });
  assert.equal(subset.hasDiff, false);
  assert.deepEqual(subset.autoItems, []);
  assert.equal(hasLocalAccountData({ localResources: { a: '[]' }, localTransactions: [] }), false);
  assert.equal(hasLocalAccountData({ localResources: {}, localTransactions: [tx('a')] }), true);
  assert.equal(hasRemoteAccountData({ remoteResources: { a: { data: {} } }, remoteTransactions: [] }), false);
  assert.equal(hasRemoteAccountData({ remoteResources: { a: { data: [1] } }, remoteTransactions: [] }), true);
});

test('差异条目：只有内部键（数字 / #序号）的条目标为 opaque，界面只显示条数', () => {
  const item = diffResource({ resource: 'holdings/accumulation', localRaw: '{"20":{"done":true}}', remote: { data: { 20: { done: false }, 30: {}, 50: {} } } });
  assert.deepEqual(item.entries.remoteOnly.map((entry) => entry.opaque), [true, true]);
  assert.equal(item.entries.changed[0].opaque, true);
  const named = diffResource({ resource: 'plans/store', localRaw: '[{"id":"p1","name":"纳指建仓"}]', remote: { data: [] } });
  assert.equal(named.entries.localOnly[0].opaque, false);
  assert.equal(named.entries.localOnly[0].label, '纳指建仓');
});

test('登录基线：上次已合并且本机未改的数据不再参与比较；本机改过才重新比较', () => {
  const sides = {
    resources: ['trades/ledger'],
    localResources: { 'trades/ledger': '[{"id":"t1"},{"id":"t2"}]' },
    remoteResources: { 'trades/ledger': { data: [{ id: 't1' }] } }, // 登录期间在云端删了 t2
    localTransactions: [tx('a'), tx('b')],
    remoteTransactions: [tx('a')]
  };
  const baseline = buildLoginSyncBaseline(sides);
  assert.equal(computeLoginSyncDiff(sides).hasDiff, true);
  const filtered = applyLoginSyncBaseline(sides, baseline);
  assert.deepEqual(filtered.localResources, {});
  assert.deepEqual(filtered.localTransactions, []);
  assert.equal(computeLoginSyncDiff(filtered).hasDiff, false);
  // 退出后本机又改了：重新参与比较
  const edited = { ...sides, localResources: { 'trades/ledger': '[{"id":"t1"},{"id":"t3"}]' } };
  assert.ok(applyLoginSyncBaseline(edited, baseline).localResources['trades/ledger']);
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
  localResources: { 'trades/ledger': '[{"id":"t1"}]', 'dca/store': '{"plans":[{"id":"d1"}]}', 'plans/store': '{"plans":[{"id":"p0"}]}' },
  remoteResources: {
    'trades/ledger': { data: [{ id: 't2' }] },
    'plans/store': { data: { plans: [{ id: 'p1' }] } },
    'sell-plans/store': { data: [{ id: 's1' }] }
  },
  localTransactions: [tx('a'), tx('b')],
  remoteTransactions: [tx('b', { shares: 9 }), tx('c')]
};
const DIFF = computeLoginSyncDiff(SIDES);

test('执行：差异分组——两边都有才问，云端没有自动上传，本机没有不处理', () => {
  assert.deepEqual(DIFF.items.map((item) => item.id), ['holdings/ledger', 'trades/ledger', 'plans/store']);
  assert.deepEqual(DIFF.autoItems.map((item) => item.id), ['dca/store']);
});

test('执行：保留本地 / 合并都先把本机数据放进 runtime 再推送或拉取；自动项按合并上传', async () => {
  const { deps, calls } = fakeDeps();
  const choices = { 'trades/ledger': 'local', 'plans/store': 'merge', 'holdings/ledger': 'merge' };
  const result = await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices, session: { userId: 'u' }, deps });
  assert.deepEqual(result.failed, []);
  const names = calls.map((call) => call[0]);
  const writeTrades = names.indexOf('writeLocalResource');
  assert.deepEqual(calls[writeTrades].slice(1), ['trades/ledger', '[{"id":"t1"}]']);
  assert.equal(calls[writeTrades + 1][0], 'pushResource');
  assert.equal(calls[writeTrades + 1][2].force, true);
  assert.ok(calls.some((call) => call[0] === 'writeLocalResource' && call[1] === 'plans/store'));
  assert.deepEqual(calls.find((call) => call[0] === 'pullResources')[1].resources, ['plans/store']);
  // 自动项：dca/store 云端没有 → 写 runtime 后上传
  assert.ok(calls.some((call) => call[0] === 'writeLocalResource' && call[1] === 'dca/store'));
  assert.ok(calls.some((call) => call[0] === 'pushResource' && call[1] === 'dca/store'));
  // 交易行合并：清基线 → 本机行写 runtime → 强制拉取（同 id 云端优先）→ 回传本地独有
  const txCalls = names.slice(names.indexOf('resetHoldingSyncState'));
  assert.deepEqual(txCalls, ['resetHoldingSyncState', 'writeLocalTransactions', 'pullHoldingTransactions', 'pushHoldingTransactions']);
  assert.deepEqual(calls.find((call) => call[0] === 'writeLocalTransactions')[1].map((row) => row.id), ['a', 'b']);
  assert.notEqual(calls.find((call) => call[0] === 'pushHoldingTransactions')[1].force, true);
});

test('执行：保留云端 → 云端替换 runtime 并删掉本机落盘旧副本；交易行只保留云端行', async () => {
  const cleared = [];
  const { deps, calls } = fakeDeps({ clearGuestResource: (name) => { cleared.push(name); return true; }, clearGuestTransactions: () => { cleared.push('tx'); return true; } });
  await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices: { 'trades/ledger': 'remote', 'holdings/ledger': 'remote', 'plans/store': 'remote' }, session: {}, deps });
  const write = calls.find((call) => call[0] === 'writeLocalResource' && call[1] === 'trades/ledger');
  assert.deepEqual(JSON.parse(write[2]), [{ id: 't2' }]);
  assert.deepEqual(calls.find((call) => call[0] === 'pullResources')[1].resources.sort(), ['plans/store', 'trades/ledger']);
  const txWrite = calls.find((call) => call[0] === 'writeLocalTransactions');
  assert.deepEqual(txWrite[1].map((row) => row.id), ['b', 'c']);
  assert.ok(!calls.some((call) => call[0] === 'pushHoldingTransactions'), '云端覆盖本地不推送交易行');
  assert.deepEqual(cleared.sort(), ['plans/store', 'trades/ledger', 'tx']);
});

test('全局：全部本地覆盖云端 → 强推本机数据并删云端多余交易行，不拉取', async () => {
  const { deps, calls } = fakeDeps();
  await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices: uniformLoginSyncChoices(DIFF.items, LOGIN_SYNC_CHOICES.LOCAL), session: {}, deps });
  const names = calls.map((call) => call[0]);
  assert.ok(!names.includes('pullResources'));
  assert.ok(!names.includes('pullHoldingTransactions'));
  assert.deepEqual(calls.filter((call) => call[0] === 'pushResource').map((call) => call[1]).sort(), ['dca/store', 'plans/store', 'trades/ledger']);
  const push = calls.find((call) => call[0] === 'pushHoldingTransactions')[1];
  assert.equal(push.force, true);
  assert.deepEqual(push.deletedIds, ['c']);
});

test('全局：全部云端覆盖本地 → 不向云端写用户选择项（自动项除外）', async () => {
  const { deps, calls } = fakeDeps();
  await applyLoginSyncChoices({ sides: SIDES, diff: DIFF, choices: uniformLoginSyncChoices(DIFF.items, LOGIN_SYNC_CHOICES.REMOTE), session: {}, deps });
  assert.deepEqual(calls.filter((call) => call[0] === 'pushResource').map((call) => call[1]), ['dca/store']);
  assert.ok(!calls.some((call) => call[0] === 'deleteAccountResource'));
  assert.ok(!calls.some((call) => call[0] === 'pushHoldingTransactions'));
  assert.deepEqual(calls.find((call) => call[0] === 'pullResources')[1].resources.sort(), ['plans/store', 'trades/ledger']);
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

test('再次登录：上次已合并且本机未改 → 不再弹窗，直接以云端为准', async () => {
  resetLoginSyncFlowForTest();
  const session = login('u-baseline');
  const store = {};
  const baselineDeps = { saveLoginSyncBaseline: (id, value) => { store[id] = value; }, readLoginSyncBaseline: (id) => store[id] || null };
  const first = sidesDeps({ remoteResources: { 'trades/ledger': [{ id: 't2' }] }, localResources: { 'trades/ledger': '[{"id":"t1"}]' } });
  Object.assign(first.deps, baselineDeps);
  assert.equal(await runLoginAccountSync(fakeCloudSync({ remoteVersion: 1 }), { action: 'login', session, deps: first.deps, demoActive: false }), 'diff-pending');
  await confirmLoginSync({ 'trades/ledger': 'merge' }, { session, deps: first.deps, cloudSync: fakeCloudSync({ remoteVersion: 1 }) });
  assert.ok(store['u-baseline']);
  // 之后在云端删掉了 t1，只剩 t2；本机落盘数据没变
  const second = sidesDeps({ remoteResources: { 'trades/ledger': [{ id: 't2' }] }, localResources: { 'trades/ledger': '[{"id":"t1"}]' } });
  Object.assign(second.deps, baselineDeps);
  const cloudSync = fakeCloudSync({ remoteVersion: 1 });
  assert.equal(await runLoginAccountSync(cloudSync, { action: 'login', session, deps: second.deps, demoActive: false }), 'pulled');
  assert.ok(cloudSync.calls.includes('restore'));
  assert.equal(isLoginSyncPending(session), false);
});
