// 三方合并基线：多端删除不复活。用内存假服务端模拟两台设备，不触网、不写线上库。
import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
  get length() { return this.values.size; }
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

const { pullResources, pushResource } = await import('../src/app/resourceSync.js');
const { applyBaseDeletions, collectItemIds, readSyncBaseIds, writeSyncBase } = await import('../src/app/syncBase.js');
const { applyLoginSyncChoices, DEFAULT_LOGIN_SYNC_DEPS } = await import('../src/app/loginSyncActions.js');

const PLAN_KEY = 'aiDcaPlanStore';
const PLANS = 'plans/store';
const WATCH_KEY = 'markets:watchlist:v1';
const WATCH = 'markets/watchlist';

const plan = (id, extra = {}) => ({ id, name: `计划${id}`, updatedAt: '2026-10-01T00:00:00.000Z', ...extra });
const planStore = (...ids) => JSON.stringify({ plans: ids.map((id) => (typeof id === 'string' ? plan(id) : id)), activePlanId: '' });

// ---- 内存假服务端：按 token 隔离账号，PUT 带 if-match 时校验 revision，不匹配返回 409 + 云端副本 ----
const server = new Map();
function account(token) {
  if (!server.has(token)) server.set(token, new Map());
  return server.get(token);
}
function jsonResponse(data, status = 200) {
  return new globalThis.Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
const RESOURCES = [PLANS, WATCH];
function resourceOf(pathname) {
  return RESOURCES.find((name) => pathname.endsWith(`/${name}`)) || '';
}
globalThis.fetch = async (url, init = {}) => {
  const parsed = new globalThis.URL(String(url), 'http://localhost');
  const token = String(init.headers?.authorization || '').replace(/^Bearer /, '');
  const store = account(token);
  const method = String(init.method || 'GET').toUpperCase();
  if (parsed.pathname.endsWith('/migrations/legacy')) return jsonResponse({ status: 'imported', legacy: { exists: true } });
  if (parsed.pathname.endsWith('/manifest')) {
    return jsonResponse({ resources: Array.from(store.entries()).map(([resource, item]) => ({ resource, ...item, data: undefined })) });
  }
  if (parsed.pathname.endsWith('/bundle')) {
    const wanted = String(parsed.searchParams.get('resources') || '').split(',').filter(Boolean);
    return jsonResponse({ resources: Object.fromEntries(wanted.filter((name) => store.has(name)).map((name) => [name, store.get(name)])) });
  }
  const resource = resourceOf(parsed.pathname);
  if (resource && method === 'PUT') {
    const body = JSON.parse(init.body || '{}');
    const current = store.get(resource);
    const ifMatch = init.headers?.['if-match'];
    if (current && ifMatch && ifMatch !== `"${current.revision}"`) {
      return jsonResponse({ error: 'revision_conflict', currentRevision: current.revision, data: current.data }, 409);
    }
    const revision = (current?.revision || 0) + 1;
    const next = { revision, contentHash: `h${revision}:${JSON.stringify(body.data)}`, updatedAt: new Date().toISOString(), deleted: false, data: body.data };
    store.set(resource, next);
    return jsonResponse({ revision, contentHash: next.contentHash, updatedAt: next.updatedAt });
  }
  throw new Error(`未模拟的请求：${method} ${url}`);
};

// ---- 设备：各自一份 localStorage（基线、同步状态、业务数据都在里面）----
function device() { return new MemoryStorage(); }
function useDevice(storage) { globalThis.window.localStorage = storage; }
function session(userId) { return { userId, username: `u-${userId}`, accessToken: `tok-${userId}` }; }
function seedServer(userId, resource, data) {
  account(`tok-${userId}`).set(resource, { revision: 1, contentHash: `h1:${JSON.stringify(data)}`, updatedAt: '2026-10-01T00:00:00.000Z', deleted: false, data });
}
function serverData(userId, resource) { return account(`tok-${userId}`).get(resource)?.data; }
function planIds(raw) { return (JSON.parse(raw)?.plans || []).map((item) => item.id).sort(); }
function serverPlanIds(userId) { return (serverData(userId, PLANS)?.plans || []).map((item) => item.id).sort(); }

test('applyBaseDeletions：没有基线时原样返回（退化为并集）', () => {
  const merged = planStore('a', 'b');
  assert.equal(applyBaseDeletions(merged, { key: PLAN_KEY, baseIds: null, localRaw: planStore('a'), remoteRaw: planStore('b') }), merged);
  assert.equal(applyBaseDeletions(merged, { key: PLAN_KEY, baseIds: new Set(), localRaw: planStore('a'), remoteRaw: planStore('b') }), merged);
});

test('applyBaseDeletions：基线里有、任一边已没有 → 删除优先；基线里没有的新增两边都保留', () => {
  const base = collectItemIds(planStore('a', 'b'), PLAN_KEY);
  const local = planStore('a', 'b', 'l');
  const remote = planStore('a', 'r'); // 另一端删了 b、加了 r
  const merged = planStore('a', 'b', 'l', 'r');
  assert.deepEqual(planIds(applyBaseDeletions(merged, { key: PLAN_KEY, baseIds: base, localRaw: local, remoteRaw: remote })), ['a', 'l', 'r']);
});

test('别的设备删除后，本机下行同步不会把它加回来，也不回传复活', async () => {
  const u = 'del-remote';
  seedServer(u, PLANS, JSON.parse(planStore('p1', 'p2')));
  const A = device();
  const B = device();
  useDevice(A); await pullResources({ session: session(u) });
  useDevice(B); await pullResources({ session: session(u) });
  assert.deepEqual(planIds(B.getItem(PLAN_KEY)), ['p1', 'p2']);

  useDevice(A);
  A.setItem(PLAN_KEY, planStore('p1'));
  await pushResource(PLANS, { session: session(u) });
  assert.deepEqual(serverPlanIds(u), ['p1']);

  useDevice(B);
  await pullResources({ session: session(u) });
  assert.deepEqual(planIds(B.getItem(PLAN_KEY)), ['p1'], '本机副本里被删的 p2 也要去掉');
  assert.deepEqual(serverPlanIds(u), ['p1'], '云端不被回传复活');
  // 再来一轮同步（含 B 的推送），p2 依旧不回来。
  await pushResource(PLANS, { session: session(u), force: true });
  await pullResources({ session: session(u), force: true });
  assert.deepEqual(serverPlanIds(u), ['p1']);
  assert.deepEqual(planIds(B.getItem(PLAN_KEY)), ['p1']);
});

test('上传冲突：本机改了别的计划，合并时不把另一端已删除的计划加回去', async () => {
  const u = 'del-conflict';
  seedServer(u, PLANS, JSON.parse(planStore('p1', 'p2')));
  const A = device();
  const B = device();
  useDevice(A); await pullResources({ session: session(u) });
  useDevice(B); await pullResources({ session: session(u) });

  useDevice(A);
  A.setItem(PLAN_KEY, planStore('p1'));
  await pushResource(PLANS, { session: session(u) });

  useDevice(B); // B 还没拉到删除，就改了 p1 → 409 冲突后三方合并
  B.setItem(PLAN_KEY, planStore(plan('p1', { name: 'B改', updatedAt: '2026-10-02T00:00:00.000Z' }), 'p2'));
  const result = await pushResource(PLANS, { session: session(u) });
  assert.equal(result.merged, true);
  assert.deepEqual(serverPlanIds(u), ['p1']);
  assert.equal(serverData(u, PLANS).plans[0].name, 'B改');
  assert.deepEqual(planIds(B.getItem(PLAN_KEY)), ['p1']);
});

test('本机删除能传到云端（含冲突时另一端新增的计划保留）', async () => {
  const u = 'del-local';
  seedServer(u, PLANS, JSON.parse(planStore('p1', 'p2')));
  const A = device();
  const B = device();
  useDevice(A); await pullResources({ session: session(u) });
  useDevice(B); await pullResources({ session: session(u) });

  useDevice(A);
  A.setItem(PLAN_KEY, planStore('p1', 'p2', 'p3'));
  await pushResource(PLANS, { session: session(u) });

  useDevice(B);
  B.setItem(PLAN_KEY, planStore('p2'));
  await pushResource(PLANS, { session: session(u) });
  assert.deepEqual(serverPlanIds(u), ['p2', 'p3']);

  // 本机待上传的删除先遇到下行同步：同样不被云端副本加回来，并把删除回传。
  useDevice(A);
  A.setItem(PLAN_KEY, planStore('p3'));
  await pullResources({ session: session(u) });
  assert.deepEqual(planIds(A.getItem(PLAN_KEY)), ['p3']);
  assert.deepEqual(serverPlanIds(u), ['p3']);
});

test('没有基线时按原方式合并：保留本地独有并回传', async () => {
  const u = 'no-base';
  seedServer(u, PLANS, JSON.parse(planStore('p1')));
  const C = device();
  useDevice(C);
  C.setItem(PLAN_KEY, planStore('local-only'));
  assert.equal(readSyncBaseIds(u, PLANS), null);
  const result = await pullResources({ session: session(u) });
  assert.deepEqual(planIds(C.getItem(PLAN_KEY)), ['local-only', 'p1']);
  assert.deepEqual(result.reuploaded, [PLANS]);
  assert.deepEqual(serverPlanIds(u), ['local-only', 'p1']);
  assert.deepEqual(Array.from(readSyncBaseIds(u, PLANS)).sort(), ['plans:local-only', 'plans:p1']);
});

test('两台设备都新增的条目都保留', async () => {
  const u = 'both-add';
  seedServer(u, PLANS, JSON.parse(planStore('p1')));
  const A = device();
  const B = device();
  useDevice(A); await pullResources({ session: session(u) });
  useDevice(B); await pullResources({ session: session(u) });

  useDevice(A);
  A.setItem(PLAN_KEY, planStore('p1', 'pa'));
  await pushResource(PLANS, { session: session(u) });
  useDevice(B);
  B.setItem(PLAN_KEY, planStore('p1', 'pb'));
  await pushResource(PLANS, { session: session(u) });
  assert.deepEqual(serverPlanIds(u), ['p1', 'pa', 'pb']);
  useDevice(A);
  await pullResources({ session: session(u) });
  assert.deepEqual(planIds(A.getItem(PLAN_KEY)), ['p1', 'pa', 'pb']);
});

test('换账号时基线按 userId 隔离：A 账号的基线不会删掉 B 账号的数据', async () => {
  const D = device();
  useDevice(D);
  seedServer('acct-1', PLANS, JSON.parse(planStore('shared', 'x')));
  await pullResources({ session: session('acct-1') });
  assert.deepEqual(Array.from(readSyncBaseIds('acct-1', PLANS)).sort(), ['plans:shared', 'plans:x']);

  // 同一浏览器换成 acct-2：云端没有 x，本机残留 shared/x 不能因为 acct-1 的基线被当成「对方删除」。
  seedServer('acct-2', PLANS, JSON.parse(planStore('shared')));
  D.removeItem('aiDcaAccountSyncState');
  assert.equal(readSyncBaseIds('acct-2', PLANS), null);
  await pullResources({ session: session('acct-2') });
  assert.deepEqual(planIds(D.getItem(PLAN_KEY)), ['shared', 'x']);
  assert.deepEqual(Array.from(readSyncBaseIds('acct-1', PLANS)).sort(), ['plans:shared', 'plans:x'], 'acct-1 的基线不受影响');
});

test('登录时选择（本机覆盖 / 改用云端 / 合并）先重置该资源的基线', async () => {
  const D = device();
  useDevice(D);
  for (const choice of ['local', 'remote', 'merge']) {
    writeSyncBase('login-u', PLANS, planStore('old'));
    assert.ok(readSyncBaseIds('login-u', PLANS));
    let baseWhenWriting = 'unset';
    const deps = {
      ...DEFAULT_LOGIN_SYNC_DEPS,
      writeLocalResource: () => { baseWhenWriting = readSyncBaseIds('login-u', PLANS); },
      clearGuestResource: () => {},
      pushResource: async () => ({}),
      pullResources: async () => ({})
    };
    const item = { kind: 'resource', id: PLANS, resource: PLANS, label: '建仓计划' };
    const result = await applyLoginSyncChoices({
      sides: { localResources: { [PLANS]: planStore('guest') }, remoteResources: { [PLANS]: { data: JSON.parse(planStore('old')) } } },
      diff: { items: [item], autoItems: [] },
      choices: { [PLANS]: choice },
      session: session('login-u'),
      deps
    });
    assert.deepEqual(result.failed, []);
    assert.equal(baseWhenWriting, null, `${choice}: 写入本机前基线已清空`);
  }
});

test('自选清单：另一端从清单里删掉的标的不会被并集加回来，两端新增保留', async () => {
  const u = 'watch';
  const watch = (us) => ({ lists: [{ id: 'default', name: '默认', us, cn: [] }], activeListId: 'default', us, cn: [] });
  seedServer(u, WATCH, watch(['AAPL', 'MSFT']));
  const A = device();
  const B = device();
  useDevice(A); await pullResources({ session: session(u) });
  useDevice(B); await pullResources({ session: session(u) });

  useDevice(A);
  A.setItem(WATCH_KEY, JSON.stringify(watch(['AAPL'])));
  await pushResource(WATCH, { session: session(u) });

  useDevice(B);
  B.setItem(WATCH_KEY, JSON.stringify(watch(['AAPL', 'MSFT', 'NVDA'])));
  await pullResources({ session: session(u) });
  const listUs = JSON.parse(B.getItem(WATCH_KEY)).lists.find((item) => item.id === 'default').us;
  assert.deepEqual([...listUs].sort(), ['AAPL', 'NVDA']);
  assert.deepEqual([...serverData(u, WATCH).lists[0].us].sort(), ['AAPL', 'NVDA']);
});
