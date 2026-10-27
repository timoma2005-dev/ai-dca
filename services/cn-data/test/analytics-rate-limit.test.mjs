import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.js';
import { handleSyncRoute } from '../src/sync/routes.js';
import { enforceAnalyticsRateLimit } from '../src/sync/analyticsRateLimit.js';

const TRACK_URL = new URL('http://127.0.0.1:8081/api/sync/analytics/track');
const HOUR_MS = 60 * 60 * 1000;

function track(db, events, headers = { 'x-real-ip': '1.1.1.1' }, body = { events }) {
  return handleSyncRoute(db, 'POST', TRACK_URL, body, headers);
}

test('迁移 006 自动建表，正常流量写入成功', () => {
  const db = openDb(':memory:');
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_rate_counters'").get();
    assert.ok(table, 'analytics_rate_counters 必须由迁移自动创建');

    const res = track(db, [{ id: 'e1', type: 'page_view' }, { id: 'e2', type: 'page_engagement' }]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, accepted: 2 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n, 2);
    const counter = db.prepare('SELECT count FROM analytics_rate_counters').get();
    assert.equal(counter.count, 2);
  } finally { closeDb(db); }
});

test('超限时返回 429 与 Retry-After，本批事件不落库', () => {
  const previous = process.env.ANALYTICS_RATE_LIMIT_PER_HOUR;
  process.env.ANALYTICS_RATE_LIMIT_PER_HOUR = '5';
  const db = openDb(':memory:');
  try {
    assert.equal(track(db, [{ id: 'a', type: 'page_view' }]).status, 200);
    const limited = track(db, Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, type: 'page_view' })));
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'RATE_LIMITED');
    assert.equal(limited.body.used, 6);
    assert.ok(Number(limited.headers['Retry-After']) >= 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n, 1, '429 批次不得写入事件');
  } finally {
    closeDb(db);
    if (previous === undefined) delete process.env.ANALYTICS_RATE_LIMIT_PER_HOUR;
    else process.env.ANALYTICS_RATE_LIMIT_PER_HOUR = previous;
  }
});

test('环境变量 0 关闭限流；不同 IP 计数隔离', () => {
  const previous = process.env.ANALYTICS_RATE_LIMIT_PER_HOUR;
  process.env.ANALYTICS_RATE_LIMIT_PER_HOUR = '0';
  const db = openDb(':memory:');
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal(track(db, [{ id: `x${i}`, type: 'page_view' }]).status, 200);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_rate_counters').get().n, 0);
  } finally {
    closeDb(db);
    if (previous === undefined) delete process.env.ANALYTICS_RATE_LIMIT_PER_HOUR;
    else process.env.ANALYTICS_RATE_LIMIT_PER_HOUR = previous;
  }

  const db2 = openDb(':memory:');
  try {
    const lowLimit = { env: { ANALYTICS_RATE_LIMIT_PER_HOUR: '5' } };
    const req = (ip) => ({ headers: new Headers({ 'x-real-ip': ip }) });
    const now = Date.parse('2026-10-27T03:15:00.000Z');
    const r1 = enforceAnalyticsRateLimit(db2, req('1.1.1.1'), 5, { nowMs: now, ...lowLimit });
    const r2 = enforceAnalyticsRateLimit(db2, req('2.2.2.2'), 5, { nowMs: now, ...lowLimit });
    assert.equal(r1.limited, false);
    assert.equal(r2.limited, false, '不同 IP 不共享计数');
    const r3 = enforceAnalyticsRateLimit(db2, req('1.1.1.1'), 1, { nowMs: now, ...lowLimit });
    assert.equal(r3.limited, true);
    const r4 = enforceAnalyticsRateLimit(db2, req('1.1.1.1'), 1, { nowMs: now + HOUR_MS, ...lowLimit });
    assert.equal(r4.limited, false, '跨小时窗口额度重置');
  } finally { closeDb(db2); }
});

test('prune 选项清理过期窗口行', () => {
  const db = openDb(':memory:');
  try {
    const now = Date.parse('2026-10-27T03:15:00.000Z');
    const req = { headers: new Headers({ 'x-real-ip': '1.1.1.1' }) };
    enforceAnalyticsRateLimit(db, req, 1, { nowMs: now, prune: false });
    enforceAnalyticsRateLimit(db, req, 1, { nowMs: now + HOUR_MS, prune: false });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_rate_counters').get().n, 2);
    enforceAnalyticsRateLimit(db, req, 1, { nowMs: now + HOUR_MS, prune: true });
    // 第一行已过期（expires_at <= now+HOUR），被 prune 删除。
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_rate_counters').get().n, 1);
  } finally { closeDb(db); }
});

test('无有效事件返回 400 且不写限流计数', () => {
  const db = openDb(':memory:');
  try {
    const res = track(db, [], {}, { events: [null, {}] });
    assert.equal(res.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_rate_counters').get().n, 0);
  } finally { closeDb(db); }
});
