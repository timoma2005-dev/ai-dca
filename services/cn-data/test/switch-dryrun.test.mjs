import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { sha256Hex } from '../src/account/store.js';
import { fetchSwitchCollectorSnapshot, runSwitchConfigDryRun } from '../src/notify/switchDryRun.js';
import { buildRuleSnapshot } from '../src/notify/switchMonitor.js';
import { evaluateSwitchTriggers, normalizeSwitchConfig } from '../src/notify/switchStrategyPort.js';

const USER = 'testuser';
const AUTH_TOKEN = 'phase2-valid-token';

function setupAuth(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cn-data-notify-auth-'));
  const path = join(directory, 'auth.sqlite');
  const auth = new DatabaseSync(path);
  try {
    auth.exec(readFileSync(new URL('../../auth/migrations/001-init.sql', import.meta.url), 'utf8'));
    const now = new Date().toISOString();
    auth.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(USER, USER, 'hash', 'salt', now, now);
    const insert = auth.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
    insert.run(sha256Hex(AUTH_TOKEN), USER, now, new Date(Date.now() + 3600000).toISOString());
    insert.run(sha256Hex('expired-token'), USER, now, new Date(Date.now() - 3600000).toISOString());
  } finally { auth.close(); }
  const previousPath = process.env.AUTH_DB_PATH;
  process.env.AUTH_DB_PATH = path;
  t.after(() => {
    if (previousPath === undefined) delete process.env.AUTH_DB_PATH;
    else process.env.AUTH_DB_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  });
}

async function app(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const server = createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const headers = (token) => token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
  return {
    db,
    async request(path, method = 'GET', body, token = AUTH_TOKEN) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: headers(token),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: res.status, body: await res.json() };
    }
  };
}

const config = {
  enabled: true,
  rules: [{ id: 'rule-1', name: '默认规则', enabled: true,
    benchmarkCodes: ['513100'], enabledCodes: ['159632'],
    premiumClass: { '513100': 'H', '159632': 'L' },
    intraSellLowerPct: 1, intraBuyOtherPct: 3 }]
};

function mockCollector(t, { status = 200, items } = {}) {
  const originalFetch = globalThis.fetch;
  const previousUrl = process.env.MARKET_COLLECTOR_URL;
  delete process.env.MARKET_COLLECTOR_URL;
  const calls = [];
  globalThis.fetch = (url, options) => {
    if (String(url).includes('127.0.0.1:18080') || String(url).includes('/fund-metrics')) {
      calls.push(String(url));
      return Promise.resolve(Response.json({
        generatedAt: '2026-10-13T02:00:00.000Z',
        items: items || [
          { code: '513100', name: '纳指ETF', price: 1.50, iopv: 1.30, premiumPercent: 15.38, quality: { status: 'ok' } },
          { code: '159632', name: '纳指ETF2', price: 1.10, iopv: 1.08, premiumPercent: 1.85, quality: { status: 'ok' } }
        ], successCount: 2, failureCount: 0
      }, { status }));
    }
    return originalFetch(url, options);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.MARKET_COLLECTOR_URL;
    else process.env.MARKET_COLLECTOR_URL = previousUrl;
  });
  return calls;
}

test('switch dry-run previews rule B without writing config or notifications', async (t) => {
  setupAuth(t);
  const calls = mockCollector(t);
  const { request, db } = await app(t);
  const res = await request('/api/notify/switch/test', 'POST', { config });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.snapshot.rules[0].triggerCount >= 1);
  assert.ok(res.body.summary.triggered >= 1);
  assert.equal(res.body.snapshot.triggers[0].rule, 'B');
  assert.equal(res.body.snapshot.triggers[0].gapPct, 13.53);
  assert.deepEqual(calls, ['http://127.0.0.1:18080/fund-metrics?codes=513100,159632']);
  for (const table of ['notify_user_records', 'notify_configs', 'sync_outbox']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
});

test('empty rules return SWITCH_TEST_RULE_REQUIRED without fetching', async (t) => {
  setupAuth(t);
  const calls = mockCollector(t);
  const { request } = await app(t);
  const res = await request('/api/notify/switch/test', 'POST', { config: { enabled: true, rules: [] } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SWITCH_TEST_RULE_REQUIRED');
  assert.deepEqual(calls, []);
});

test('single-code rule empirically returns SWITCH_TEST_RULE_REQUIRED before code-count validation', async (t) => {
  setupAuth(t);
  const calls = mockCollector(t);
  const { request } = await app(t);
  const res = await request('/api/notify/switch/test', 'POST', { config: {
    enabled: true, rules: [{ id: 'r1', benchmarkCodes: ['513100'], enabledCodes: [], premiumClass: { '513100': 'H' } }]
  } });
  assert.equal(res.status, 400);
  // Observed from the worker-identical logic: a single-code rule is not runnable.
  assert.equal(res.body.code, 'SWITCH_TEST_RULE_REQUIRED');
  assert.deepEqual(calls, []);
});

test('switch dry-run requires Bearer auth and accepts POST only', async (t) => {
  setupAuth(t);
  const calls = mockCollector(t);
  const { request } = await app(t);
  assert.equal((await request('/api/notify/switch/test', 'POST', { config }, null)).status, 401);
  assert.equal((await request('/api/notify/switch/test')).status, 405);
  assert.deepEqual(calls, []);
});

test('collector HTTP failure returns 502 with collector error code', async (t) => {
  setupAuth(t);
  mockCollector(t, { status: 503 });
  const { request } = await app(t);
  const res = await request('/api/notify/switch/test', 'POST', config);
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'SWITCH_TEST_COLLECTOR_FAILED');
});

for (const premiumPercent of [null, undefined]) {
  test(`collector preserves ${premiumPercent} premiums and skips switch/OTC without consuming quota`, async (t) => {
    mockCollector(t, { items: ['513100', '159632'].map((code) => ({
      code, price: 1.5, iopv: 1.5, premiumPercent, quality: { status: 'ok' }
    })) });
    const collector = await fetchSwitchCollectorSnapshot(['513100', '159632']);
    for (const code of ['513100', '159632']) assert.equal(collector.funds[code].premiumPct, null);
    const snapshot = buildRuleSnapshot(normalizeSwitchConfig(config).rules[0], collector.funds, collector.generatedAt);
    assert.equal(snapshot.byBenchmark[0].benchmarkPremiumPct, null);
    assert.equal(snapshot.byBenchmark[0].candidates[0].premiumPct, null);
    assert.equal(snapshot.byBenchmark[0].candidates[0].spreadVsBenchmarkPct, null);
    assert.equal(snapshot.otcSignal.ready, false);
    assert.equal(snapshot.ready, false);
    const previous = {
      '513100:159632': { dailyTriggerCount: 2 },
      'otc:513100:159632': { dailyTriggerCount: 1 }
    };
    for (const states of [{}, previous]) {
      const result = evaluateSwitchTriggers(snapshot, states);
      assert.deepEqual(result.triggers, []);
      assert.deepEqual(result.nextTriggerStates, states);
    }
    const preview = await runSwitchConfigDryRun(config);
    assert.equal(preview.snapshot.ready, false);
    assert.deepEqual(preview.snapshot.triggers, []);
    assert.equal(preview.snapshot.rules[0].snapshot.byBenchmark[0].candidates[0].spreadVsBenchmarkPct, null);
  });
}

test('collector keeps numeric zero and finite numeric strings, rejects non-finite premiums', async (t) => {
  const values = [0, '0', '3.5', 'invalid', Infinity];
  const codes = values.map((_, index) => String(513100 + index));
  mockCollector(t, { items: codes.map((code, index) => ({ code, premiumPercent: values[index] })) });
  const collector = await fetchSwitchCollectorSnapshot(codes);
  assert.deepEqual(codes.map((code) => collector.funds[code].premiumPct), [0, 0, 3.5, null, null]);
});
