import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  enforceAnalyticsRateLimit,
  pruneExpiredRateCounters,
  clientIpFromRequest,
  DEFAULT_ANALYTICS_LIMIT_PER_HOUR,
} from '../src/analyticsRateLimit.js';

const BASE = 'https://api.freebacktrack.tech';
const HOUR_MS = 60 * 60 * 1000;

// 最小 D1 替身：只实现限流与 track 链路实际用到的语句。
function makeEnv({ limit, now = Date.parse('2026-10-27T03:15:00.000Z') } = {}) {
  const counters = new Map();
  const analyticsEvents = [];
  const DB = {
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      const exec = (args = []) => ({
        async run() {
          if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/.test(q)) return { meta: { changes: 0 } };
          if (/^INSERT INTO analytics_rate_counters/.test(q)) {
            const [key, count, windowStart, expiresAt] = args;
            const existing = counters.get(key);
            if (existing) existing.count += Number(count);
            else counters.set(key, { count: Number(count), windowStart, expiresAt });
            return { meta: { changes: 1 } };
          }
          if (/^DELETE FROM analytics_rate_counters/.test(q)) {
            let n = 0;
            for (const [key, row] of [...counters]) {
              if (row.expiresAt <= args[0]) { counters.delete(key); n += 1; }
            }
            return { meta: { changes: n } };
          }
          if (/^INSERT OR IGNORE INTO analytics_events/.test(q)) {
            analyticsEvents.push(args[0]);
            return { meta: { changes: 1 } };
          }
          // 日聚合等其它语句：静默成功。
          return { meta: { changes: 0 } };
        },
        async first() {
          if (/FROM analytics_rate_counters WHERE key/.test(q)) {
            const row = counters.get(args[0]);
            return row ? { count: row.count } : null;
          }
          return null;
        },
      });
      const api = exec([]);
      api.bind = (...args) => exec(args);
      return api;
    },
  };
  const env = { DB };
  if (limit !== undefined) env.ANALYTICS_RATE_LIMIT_PER_HOUR = String(limit);
  return { env, counters, analyticsEvents, now };
}

function trackRequest(ip, events, headers = {}) {
  return new Request(`${BASE}/api/sync/analytics/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
    body: JSON.stringify({ events }),
  });
}

const twoEvents = () => ([
  { id: 'e1', type: 'page_view' },
  { id: 'e2', type: 'page_engagement' },
]);

test('限流默认值与 IP 提取优先级', () => {
  assert.equal(DEFAULT_ANALYTICS_LIMIT_PER_HOUR, 600);
  const cf = new Request(BASE, { headers: { 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2' } });
  assert.equal(clientIpFromRequest(cf), '1.1.1.1');
  const real = new Request(BASE, { headers: { 'x-real-ip': '2.2.2.2' } });
  assert.equal(clientIpFromRequest(real), '2.2.2.2');
  const none = new Request(BASE);
  assert.equal(clientIpFromRequest(none), 'unknown');
});

test('限额内请求正常写入，超限返回 429 且本批事件不落库', async () => {
  const { env, analyticsEvents, now } = makeEnv({ limit: 5 });
  const first = await worker.fetch(trackRequest('1.1.1.1', twoEvents()), env);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, accepted: 2 });

  const second = await worker.fetch(
    trackRequest('1.1.1.1', Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, type: 'page_view' }))),
    env,
  );
  assert.equal(second.status, 429);
  const body = await second.json();
  assert.equal(body.error, 'RATE_LIMITED');
  assert.equal(body.used, 6);
  assert.equal(body.limit, 5);
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
  assert.equal(analyticsEvents.length, 2, '429 请求的事件不得写入');
});

test('ANALYTICS_RATE_LIMIT_PER_HOUR=0 关闭限流', async () => {
  const { env, analyticsEvents } = makeEnv({ limit: 0 });
  for (let i = 0; i < 5; i++) {
    const res = await worker.fetch(trackRequest('9.9.9.9', twoEvents()), env);
    assert.equal(res.status, 200);
  }
  assert.equal(analyticsEvents.length, 10);
});

test('不同 IP 与不同小时窗口各自独立计数', async () => {
  const { env, counters, now } = makeEnv({ limit: 5 });
  const req = (ip) => new Request(BASE, { headers: { 'cf-connecting-ip': ip } });
  const r1 = await enforceAnalyticsRateLimit(env, req('1.1.1.1'), 5, now);
  assert.equal(r1.limited, false);
  const r2 = await enforceAnalyticsRateLimit(env, req('2.2.2.2'), 5, now);
  assert.equal(r2.limited, false, '不同 IP 不共享计数');
  const r3 = await enforceAnalyticsRateLimit(env, req('1.1.1.1'), 1, now);
  assert.equal(r3.limited, true);
  // 进入下一个 UTC 小时：新 key、新额度。
  const r4 = await enforceAnalyticsRateLimit(env, req('1.1.1.1'), 1, now + HOUR_MS);
  assert.equal(r4.limited, false);
  assert.equal(counters.size, 3);
});

test('pruneExpiredRateCounters 只清理过期窗口', async () => {
  const { env, counters, now } = makeEnv({});
  const req = new Request(BASE, { headers: { 'cf-connecting-ip': '1.1.1.1' } });
  await enforceAnalyticsRateLimit(env, req, 1, now);
  await enforceAnalyticsRateLimit(env, req, 1, now + HOUR_MS);
  assert.equal(counters.size, 2);
  const result = await pruneExpiredRateCounters(env, now + HOUR_MS);
  assert.equal(result.deleted, 1);
  assert.equal(counters.size, 1);
});

test('无有效事件时仍走原有 400，不消耗限流计数', async () => {
  const { env, counters } = makeEnv({ limit: 1 });
  const res = await worker.fetch(trackRequest('1.1.1.1', [null, {}]), env);
  assert.equal(res.status, 400);
  assert.equal(counters.size, 0);
});
