import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_DIRECT_MODE_EVENT,
  LOCAL_DIRECT_MODE_KEY,
  LOCAL_DIRECT_SCOPES,
  isLocalDirectMode,
  readLocalDirectModes,
  setLocalDirectMode,
  subscribeLocalDirectMode,
  toggleLocalDirectMode,
} from '../src/app/localDirectMode.js';

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

test('local direct mode defaults to off for both scopes', () => {
  assert.deepEqual(readLocalDirectModes(new FakeStorage()), {
    [LOCAL_DIRECT_SCOPES.MARKETS]: false,
    [LOCAL_DIRECT_SCOPES.FUND_SWITCH]: false,
  });
  assert.equal(isLocalDirectMode(LOCAL_DIRECT_SCOPES.MARKETS, new FakeStorage()), false);
  // 无存储环境（SSR）也安全回退。
  assert.equal(isLocalDirectMode(LOCAL_DIRECT_SCOPES.MARKETS, null), false);
});

test('corrupted or wrong-shaped storage falls back to defaults', () => {
  const store = new FakeStorage();
  store.setItem(LOCAL_DIRECT_MODE_KEY, '{not-json');
  assert.deepEqual(readLocalDirectModes(store)[LOCAL_DIRECT_SCOPES.MARKETS], false);
  store.setItem(LOCAL_DIRECT_MODE_KEY, JSON.stringify([1, 2, 3]));
  assert.deepEqual(readLocalDirectModes(store)[LOCAL_DIRECT_SCOPES.FUND_SWITCH], false);
  store.setItem(LOCAL_DIRECT_MODE_KEY, JSON.stringify({ markets: 'yes' }));
  assert.equal(readLocalDirectModes(store).markets, false);
});

test('set/toggle persist per scope without touching the other', () => {
  const store = new FakeStorage();
  const afterSet = setLocalDirectMode(LOCAL_DIRECT_SCOPES.MARKETS, true, store);
  assert.deepEqual(afterSet, { markets: true, fundSwitch: false });
  assert.equal(isLocalDirectMode(LOCAL_DIRECT_SCOPES.MARKETS, store), true);
  assert.equal(isLocalDirectMode(LOCAL_DIRECT_SCOPES.FUND_SWITCH, store), false);

  toggleLocalDirectMode(LOCAL_DIRECT_SCOPES.FUND_SWITCH, store);
  assert.equal(isLocalDirectMode(LOCAL_DIRECT_SCOPES.FUND_SWITCH, store), true);
  toggleLocalDirectMode(LOCAL_DIRECT_SCOPES.FUND_SWITCH, store);
  assert.equal(isLocalDirectMode(LOCAL_DIRECT_SCOPES.FUND_SWITCH, store), false);

  const persisted = JSON.parse(store.getItem(LOCAL_DIRECT_MODE_KEY));
  assert.equal(persisted.markets, true);
  assert.equal(persisted.fundSwitch, false);
  assert.ok(typeof persisted.updatedAt === 'string');
});

test('unknown scope is rejected instead of silently written', () => {
  assert.throws(() => setLocalDirectMode('nope', true, new FakeStorage()), /unknown local-direct scope/);
  assert.equal(isLocalDirectMode('nope', new FakeStorage()), false);
});

test('subscribe receives custom events and cross-tab storage events', () => {
  const listeners = new Map();
  const fakeWindow = {
    addEventListener: (type, fn) => { listeners.set(type, fn); },
    removeEventListener: (type) => { listeners.delete(type); },
    dispatchEvent() {},
  };
  const events = [];
  const unsubscribe = subscribeLocalDirectMode((detail) => events.push(detail), fakeWindow);
  listeners.get(LOCAL_DIRECT_MODE_EVENT)({ detail: { scope: 'markets', enabled: true } });
  listeners.get('storage')({ key: LOCAL_DIRECT_MODE_KEY });
  listeners.get('storage')({ key: 'other-key' });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { scope: 'markets', enabled: true });
  unsubscribe();
  assert.equal(listeners.size, 0);

  // 无 window 时退订函数仍是安全 no-op。
  assert.equal(typeof subscribeLocalDirectMode(() => {}, null), 'function');
});
