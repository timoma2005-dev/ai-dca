/* global Response */
// 付费功能演示沙箱：存储覆盖层、fetch 拦截、每日次数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_FEATURES, DEMO_READONLY_CODE, consumeDemoQuota, createDemoFetch, createStorageSandbox,
  demoFeatureFor, demoQuotaFor, installFeatureDemo, isDemoBlockedWrite,
} from '../src/app/demo/featureDemo.js';

class FakeStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

test('storage sandbox keeps writes in memory and restores the real storage on uninstall', () => {
  const real = new FakeStorage({ a: '1', b: '2' });
  const other = new FakeStorage({ a: 'x' });
  const sandbox = createStorageSandbox(real);
  sandbox.install();
  real.setItem('a', 'demo');
  real.removeItem('b');
  real.setItem('c', '3');
  other.setItem('a', 'y'); // 其他 Storage 实例不受影响
  assert.equal(real.getItem('a'), 'demo');
  assert.equal(real.getItem('b'), null);
  assert.equal(real.getItem('c'), '3');
  assert.equal(sandbox.writes, 3);
  assert.equal(real.map.get('a'), '1', 'nothing reaches the real store');
  sandbox.uninstall();
  assert.equal(real.getItem('a'), '1');
  assert.equal(real.getItem('b'), '2');
  assert.equal(real.getItem('c'), null);
  assert.equal(other.getItem('a'), 'y');
});

test('demo fetch: fixtures by pathname (any host), user-data writes blocked, public data passes through', async () => {
  const calls = [];
  const realFetch = async (input, init) => { calls.push([String(input), init?.method || 'GET']); return new Response('{"real":true}'); };
  const blocked = [];
  const fetchDemo = createDemoFetch({
    realFetch,
    origin: 'https://fast.example',
    onBlocked: (key) => blocked.push(key),
    fixtures: {
      'GET /api/notify/switch/config': { ok: true, config: { rules: [] } },
      'POST /api/notify/switch/recommend': ({ init }) => ({ ok: true, rule: { echo: JSON.parse(init.body).holdingCode } }),
    },
  });
  assert.deepEqual(await (await fetchDemo('https://api.other.example/api/notify/switch/config?clientId=1')).json(), { ok: true, config: { rules: [] } });
  assert.deepEqual(await (await fetchDemo('/api/notify/switch/recommend', { method: 'POST', body: '{"holdingCode":"513100"}' })).json(), { ok: true, rule: { echo: '513100' } });
  const write = await fetchDemo('/api/sync', { method: 'POST', body: '{}' });
  assert.equal(write.status, 403);
  assert.equal((await write.json()).code, DEMO_READONLY_CODE);
  assert.deepEqual(blocked, ['POST /api/sync']);
  await fetchDemo('/api/markets/fund-metrics', { method: 'POST', body: '{}' });
  await fetchDemo('/api/sync/analytics/track', { method: 'POST', body: '{}' });
  await fetchDemo('/api/notify/events');
  assert.deepEqual(calls.map((c) => c[0]), ['/api/markets/fund-metrics', '/api/sync/analytics/track', '/api/notify/events']);
});

test('blocked write list covers sync, account and notify, but not auth or analytics', () => {
  assert.equal(isDemoBlockedWrite('POST', '/api/account/v1/transactions'), true);
  assert.equal(isDemoBlockedWrite('PUT', '/api/notify/rules'), true);
  assert.equal(isDemoBlockedWrite('DELETE', '/sync/backup'), true);
  assert.equal(isDemoBlockedWrite('GET', '/api/notify/rules'), false);
  assert.equal(isDemoBlockedWrite('POST', '/api/sync/auth/logout'), false);
  assert.equal(isDemoBlockedWrite('POST', '/api/market-collector/backtest'), false);
});

test('daily quota: 3 runs per feature per Beijing day', () => {
  const storage = new FakeStorage();
  const now = Date.parse('2026-10-24T02:00:00Z');
  assert.equal(demoQuotaFor('markets', { storage, now }).remaining, 3);
  assert.equal(consumeDemoQuota('markets', { storage, now }), true);
  assert.equal(consumeDemoQuota('markets', { storage, now }), true);
  assert.equal(consumeDemoQuota('markets', { storage, now }), true);
  assert.equal(consumeDemoQuota('markets', { storage, now }), false);
  assert.equal(demoQuotaFor('markets', { storage, now }).remaining, 0);
  assert.equal(demoQuotaFor('notify', { storage, now }).remaining, 3, 'per feature');
  assert.equal(demoQuotaFor('markets', { storage, now: Date.parse('2026-10-24T16:30:00Z') }).remaining, 3, 'resets at Beijing midnight');
});

test('only ready features offer a demo; install/uninstall swaps fetch and storage back', async () => {
  assert.ok(demoFeatureFor('markets'));
  for (const tab of Object.keys(DEMO_FEATURES)) assert.equal(Boolean(demoFeatureFor(tab)), DEMO_FEATURES[tab].ready, tab);
  assert.equal(demoFeatureFor('holdings'), null);
  const storage = new FakeStorage({ k: 'real' });
  const realFetch = async () => new Response('{}');
  const win = { fetch: realFetch, localStorage: storage, location: { origin: 'https://fast.example' } };
  const env = installFeatureDemo('markets', { win });
  assert.notEqual(win.fetch, realFetch);
  storage.setItem('k', 'demo');
  assert.equal(env.dirty, true);
  env.uninstall();
  assert.equal(win.fetch, realFetch);
  assert.equal(storage.getItem('k'), 'real');
});
