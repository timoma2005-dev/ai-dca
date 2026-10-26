import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeDemoQuota, demoQuotaFor, DEMO_RUNS_PER_DAY } from '../src/app/demo/featureDemo.js';
import { demoQuotaText } from '../src/app/demo/demoQuotaText.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('demo quota is counted per feature and the copy says so', () => {
  const storage = mem();
  const now = Date.parse('2026-10-26T03:00:00Z');
  assert.equal(consumeDemoQuota('markets', { storage, now }), true);
  const markets = demoQuotaFor('markets', { storage, now });
  const auction = demoQuotaFor('adminAuction', { storage, now });
  assert.equal(markets.remaining, DEMO_RUNS_PER_DAY - 1);
  assert.equal(auction.remaining, DEMO_RUNS_PER_DAY);
  assert.match(demoQuotaText(markets), /^本功能今日还可体验 2 次（每个功能每天 3 次）$/);
  assert.match(demoQuotaText(auction), /^本功能今日还可体验 3 次/);
});

test('demo quota copy: exhausted and unlimited', () => {
  assert.equal(demoQuotaText({ remaining: 0, perDay: 3 }), '本功能今日体验次数已用完（每个功能每天 3 次）');
  assert.equal(demoQuotaText({ unlimited: true, remaining: Infinity }), '');
  assert.equal(demoQuotaText(null), '');
});
