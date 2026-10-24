/* global Response */
// 基金切换演示 mock：两个 GET 命中且结构可被看板消费、首屏不补发测试 POST、写入 403、无 mock 的 503 不回归、
// 换基偏好（keepKeys）保留并在升级后带入，示例配置不带入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_ACCESS_TOKEN, DEMO_READONLY_CODE, DEMO_SESSION_KEY, createDemoFetch, demoFeatureFor, importDemoSessions,
  installFeatureDemo, loadDemoModule, readDemoSession,
} from '../src/app/demo/featureDemo.js';
import {
  SWITCH_CONFIG_CACHE_KEY, SWITCH_DEMO_RULES, SWITCH_PREFS_KEY, buildSwitchDemoConfig, buildSwitchDemoSnapshot, switchDemoComputedAt,
} from '../src/app/demo/fixtures/fundSwitch.js';
import {
  loadSwitchConfigFromWorker, loadSwitchSnapshotFromWorker, normalizeSwitchConfigShape, readSwitchConfigCache, saveSwitchConfigToWorker,
} from '../src/app/switchStrategySync.js';
import { testSwitchConfig } from '../src/app/switchStrategyTestSync.js';
import { buildSwitchBoardRows, summarizeSwitchBoard } from '../src/pages/switch/switchBoardModel.js';

const SAT = Date.parse('2026-10-24T10:37:00+08:00'); // 周六
const TRADING = Date.parse('2026-10-22T14:07:30+08:00'); // 周四盘中
const NDX_CODES = new Set(['513100', '159501', '159941', '159696', '159659', '159632', '513300', '513870', '513110', '159660', '513390', '159513']);

class FakeStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

function boardRows(now) {
  const config = normalizeSwitchConfigShape(buildSwitchDemoConfig(now));
  const snapshot = { snapshot: buildSwitchDemoSnapshot(now) };
  return { config, snapshot, rows: buildSwitchBoardRows(config, snapshot) };
}

/** 模拟浏览器：window === globalThis，fetch 记录真实外发。 */
function installBrowser(storage) {
  const realCalls = [];
  const events = [];
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, location: globalThis.location, fetch: globalThis.fetch, dispatchEvent: globalThis.dispatchEvent };
  globalThis.dispatchEvent = (event) => { events.push(event); return true; };
  globalThis.localStorage = storage;
  globalThis.location = { origin: 'https://fast.example' };
  globalThis.fetch = async (input, init) => { realCalls.push(`${init?.method || 'GET'} ${String(input)}`); return new Response('{"real":true}'); };
  globalThis.window = globalThis;
  return {
    realCalls,
    events,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

test('fundSwitch demo is ready, lazily loads its module, mocks only the two switch GETs', async () => {
  const feature = demoFeatureFor('fundSwitch');
  assert.ok(feature);
  assert.ok(feature.pitch.length > 10);
  const mod = await loadDemoModule('fundSwitch');
  assert.deepEqual(mod.keepKeys, [SWITCH_PREFS_KEY]);
  assert.deepEqual(mod.seed().map(([key]) => key).sort(), [SWITCH_CONFIG_CACHE_KEY, 'aiDcaSwitchRuleChannels'].sort());
  const { routes, getState } = mod.createFixtures({ state: null });
  assert.deepEqual(Object.keys(routes).sort(), ['GET /api/notify/switch/config', 'GET /api/notify/switch/snapshot']);
  assert.equal(getState, undefined, 'writes stay blocked, no mock server state');
});

test('demo config / snapshot follow the worker shapes and drive the board (Nasdaq QDII ETFs, H/L rules)', () => {
  const { config, snapshot, rows } = boardRows(SAT);
  assert.equal(config.rules.length, 3);
  assert.equal(config.activeRuleId, 'demo-ndx-h2l');
  assert.deepEqual(config.rules.map((r) => r.id), SWITCH_DEMO_RULES.map((r) => r.id), 'normalize keeps every demo rule');
  for (const rule of config.rules) for (const code of [...rule.benchmarkCodes, ...rule.enabledCodes]) assert.ok(NDX_CODES.has(code), code);
  const root = snapshot.snapshot;
  assert.equal(root.source, 'market-collector');
  assert.match(root.snapshotId, /^switch-\d{14}-[0-9a-f]{8}$/);
  assert.equal(root.computedAt, '2026-10-23T07:00:00.000Z', 'weekend → last trading day close 15:00 CST');
  assert.equal(root.rules.length, 3);
  for (const entry of root.rules) {
    assert.equal(entry.snapshot.ruleId, entry.ruleId);
    for (const group of entry.snapshot.byBenchmark) {
      assert.ok(Number.isFinite(group.benchmarkPremiumPct) && group.benchmarkPremiumPct > 5 && group.benchmarkPremiumPct < 20);
      assert.ok(Math.abs(group.benchmarkPremiumPct - ((group.benchmarkPrice - group.benchmarkNav) / group.benchmarkNav) * 100) < 1e-3, 'premium = (price − iopv) / iopv');
      for (const cand of group.candidates) {
        assert.ok(Math.abs(cand.spreadVsBenchmarkPct - (group.benchmarkPremiumPct - cand.premiumPct)) < 1e-6);
        assert.match(cand.name, /纳/);
      }
    }
  }
  const [h2l, l2h, paused] = rows;
  assert.ok(rows.every((row) => row.hasQuote), 'every rule has a spread, so the board never posts /switch/test on mount');
  assert.equal(h2l.holdingSide, 'H');
  assert.equal(h2l.gauge.triggered, true, 'high-premium leg crossed the upper threshold');
  assert.equal(h2l.gauge.directionLabel, 'H→L');
  assert.equal(l2h.holdingSide, 'L');
  assert.equal(l2h.gauge.triggered, false);
  assert.ok(l2h.gauge.distancePct > 0);
  assert.equal(paused.enabled, false);
  assert.equal(summarizeSwitchBoard(rows).triggeredToday, 0, 'no pushes on a weekend');
  assert.deepEqual(buildSwitchDemoSnapshot(SAT), root, 'deterministic for the same moment');
});

test('trading session: snapshot time follows the current minute and today hits are counted', () => {
  assert.equal(switchDemoComputedAt(TRADING), '2026-10-22T06:07:00.000Z');
  assert.equal(switchDemoComputedAt(Date.parse('2026-10-22T12:10:00+08:00')), '2026-10-22T03:30:00.000Z', 'lunch break → 11:30');
  assert.equal(switchDemoComputedAt(Date.parse('2026-10-22T08:50:00+08:00')), '2026-10-21T07:00:00.000Z', 'pre-open → previous close');
  assert.equal(switchDemoComputedAt(Date.parse('2026-10-08T09:00:00+08:00')), '2026-09-30T07:00:00.000Z', 'skips the National Day holiday');
  const { rows } = boardRows(TRADING);
  assert.ok(rows[0].hitCount >= 1 && rows[0].hitCount <= 3);
  assert.equal(rows[1].hitCount, 0);
  assert.equal(rows[2].hitCount, 0, 'paused rules do not push');
  assert.equal(rows[0].computedAt, '2026-10-22T06:07:00.000Z');
});

for (const [label, session] of [['guest (demo placeholder token)', null], ['logged-in user without VIP (real token)', { accessToken: 'real-user-token', username: 'u1' }]]) {
  test(`installed demo, ${label}: board requests hit the mock, writes are 403, nothing reaches the network`, async () => {
    const storage = new FakeStorage(session ? { aiDcaCloudSyncSession: JSON.stringify(session) } : {});
    const browser = installBrowser(storage);
    const blocked = [];
    try {
      const mod = await loadDemoModule('fundSwitch');
      const env = installFeatureDemo('fundSwitch', { win: globalThis, module: mod, onBlocked: (key) => blocked.push(key) });
      assert.equal(readSwitchConfigCache().rules[0].id, 'demo-ndx-h2l', 'seeded cache shows demo rules on first paint');
      const config = await loadSwitchConfigFromWorker();
      const { snapshot } = await loadSwitchSnapshotFromWorker();
      assert.equal(config.rules.length, 3);
      assert.equal(snapshot.demo, true);
      assert.ok(buildSwitchBoardRows(config, { snapshot }).every((row) => row.hasQuote));
      await assert.rejects(saveSwitchConfigToWorker(config), (error) => error.status === 403 && error.code === DEMO_READONLY_CODE);
      await assert.rejects(testSwitchConfig({ ...config, enabled: false }), (error) => error.status === 403);
      assert.deepEqual(blocked, ['POST /api/notify/switch/config', 'POST /api/notify/switch/test']);
      assert.deepEqual(browser.events.map((event) => event.detail?.status), ['loading', 'error'], 'test feedback modal shows the read-only error');
      assert.deepEqual(browser.realCalls, [], 'no request leaves the browser');
      env.uninstall();
      assert.equal(storage.map.get(SWITCH_CONFIG_CACHE_KEY), undefined, 'demo config never touches the real store');
      assert.equal(readDemoSession('fundSwitch', { storage }), null, 'nothing kept when prefs were not changed');
    } finally {
      browser.restore();
    }
  });
}

test('switch prefs created in the demo are kept 15 min and imported after upgrade; demo config is not', async () => {
  const storage = new FakeStorage();
  const browser = installBrowser(storage);
  try {
    const mod = await loadDemoModule('fundSwitch');
    const env = installFeatureDemo('fundSwitch', { win: globalThis, module: mod });
    await loadSwitchConfigFromWorker(); // 写入配置缓存（演示内容，不应带入）
    storage.setItem(SWITCH_PREFS_KEY, '{"rules":[{"id":"bt-1","name":"513100/159513 回测规则"}]}');
    env.uninstall();
    assert.equal(storage.map.get(SWITCH_PREFS_KEY), undefined);
    const kept = readDemoSession('fundSwitch', { storage });
    assert.deepEqual(kept.entries.map(([key]) => key), [SWITCH_PREFS_KEY]);
    const imported = await importDemoSessions({ canAccess: (tab) => tab === 'fundSwitch', storage });
    assert.deepEqual(imported, ['fundSwitch']);
    assert.match(storage.map.get(SWITCH_PREFS_KEY), /回测规则/);
    assert.equal(storage.map.get(SWITCH_CONFIG_CACHE_KEY), undefined);
    assert.equal(storage.map.get(DEMO_SESSION_KEY), undefined);
    assert.deepEqual(browser.realCalls, []);
  } finally {
    browser.restore();
  }
});

test('no regression: demo-token GET without a mock → 503, writes → 403; switch mocks win on both hosts', async () => {
  const mod = await loadDemoModule('fundSwitch');
  let hits = 0;
  const f = createDemoFetch({ realFetch: async () => { hits += 1; return new Response('{}'); }, fixtures: mod.createFixtures({}).routes, origin: 'https://x.example' });
  const auth = { headers: { authorization: `Bearer ${DEMO_ACCESS_TOKEN}` } };
  assert.equal((await f('/api/notify/switch/config', auth)).status, 200);
  assert.equal((await (await f('https://api.freebacktrack.tech/api/notify/switch/snapshot', auth)).json()).ok, true);
  const missing = await f('/api/notify/switch/test-nav', auth);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'DEMO_NO_FIXTURE');
  for (const path of ['/api/notify/switch/config', '/api/notify/switch/test', '/api/notify/switch/recommend', '/api/notify/switch/run']) {
    const write = await f(path, { method: 'POST', ...auth });
    assert.equal(write.status, 403, path);
    assert.equal((await write.json()).code, DEMO_READONLY_CODE);
  }
  assert.equal((await f('/api/notify/switch/config', { method: 'POST', headers: { authorization: 'Bearer real' } })).status, 403, 'blocked with a real token too');
  assert.equal(hits, 0);
});
