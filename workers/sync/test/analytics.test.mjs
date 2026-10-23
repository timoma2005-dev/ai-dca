import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import worker, { pruneOldAnalyticsEvents } from '../src/index.js';

function createCleanupFixture(changes) {
  const calls = [];
  const remaining = [...changes];
  const env = {
    DB: {
      prepare(sql) {
        const call = { sql, args: [] };
        calls.push(call);
        return {
          bind(...args) {
            call.args = args;
            return {
              async run() {
                return { meta: { changes: remaining.shift() ?? 0 } };
              },
            };
          },
        };
      },
    },
  };
  return { env, calls };
}

test('analytics cleanup drains multiple full batches in one run', async () => {
  const fixture = createCleanupFixture([5000, 5000, 123]);
  const result = await pruneOldAnalyticsEvents(
    fixture.env,
    Date.parse('2026-08-03T00:00:00.000Z'),
  );

  assert.deepEqual(result, {
    cutoff: '2026-07-04',
    deleted: 10123,
    batches: 3,
    hitBatchLimit: false,
  });
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls[0].args[1], 5000);
});

test('analytics cleanup reports when the per-run batch limit is reached', async () => {
  const fixture = createCleanupFixture([5000, 5000, 5000]);
  const result = await pruneOldAnalyticsEvents(
    fixture.env,
    Date.parse('2026-08-03T00:00:00.000Z'),
    { maxBatches: 2 },
  );

  assert.deepEqual(result, {
    cutoff: '2026-07-04',
    deleted: 10000,
    batches: 2,
    hitBatchLimit: true,
  });
  assert.equal(fixture.calls.length, 2);
});

test('analytics cleanup does not flag a partial final batch as a limit hit', async () => {
  const fixture = createCleanupFixture([123]);
  const result = await pruneOldAnalyticsEvents(
    fixture.env,
    Date.parse('2026-08-03T00:00:00.000Z'),
    { maxBatches: 1 },
  );

  assert.equal(result.deleted, 123);
  assert.equal(result.batches, 1);
  assert.equal(result.hitBatchLimit, false);
});

function createAggregateFixture() {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            const statement = { sql, args };
            statements.push(statement);
            return statement;
          },
        };
      },
      async batch() {},
    },
  };
  return { env, statements };
}

test('daily analytics aggregate counts pv and switch runs per date', async () => {
  const { updateDailyAnalyticsAggregate } = await import('../src/index.js');
  const { env, statements } = createAggregateFixture();
  await updateDailyAnalyticsAggregate(env, [
    { type: 'page_view', date: '2026-09-25', userId: 'u1', visitorId: '' },
    { type: 'page_view', date: '2026-09-25', userId: '', visitorId: 'v1' },
    { type: 'page_engagement', date: '2026-09-25', userId: 'u1', visitorId: '' },
    { type: 'switch_worker_run', date: '2026-09-25', userId: '', visitorId: '' },
    { type: 'page_view', date: '2026-09-24', userId: 'u2', visitorId: '' },
  ]);
  const stats = statements.filter((s) => s.sql.includes('analytics_daily_stats'));
  assert.equal(stats.length, 2);
  const today = stats.find((s) => s.args[0] === '2026-09-25');
  assert.deepEqual(today.args, ['2026-09-25', 2, 1]);
  assert.match(today.sql, /pv = pv \+ excluded\.pv/);
  const users = statements.filter((s) => s.sql.includes('analytics_daily_users'));
  assert.equal(users.length, 3);
  const visitor = users.find((s) => s.args[1] === 'v1');
  assert.deepEqual(visitor.args, ['2026-09-25', 'v1', 1, 1, 0]);
  const engaged = users.find((s) => s.args[1] === 'u1');
  assert.deepEqual(engaged.args, ['2026-09-25', 'u1', 0, 1, 1]);
});

test('daily analytics aggregate merges flags with MAX on conflict', async () => {
  const { updateDailyAnalyticsAggregate } = await import('../src/index.js');
  const { env, statements } = createAggregateFixture();
  await updateDailyAnalyticsAggregate(env, [
    { type: 'page_view', date: '2026-09-25', userId: 'u1', visitorId: '' },
  ]);
  const userStmt = statements.find((s) => s.sql.includes('analytics_daily_users'));
  assert.match(userStmt.sql, /MAX\(has_page_view, excluded\.has_page_view\)/);
});

test('daily analytics aggregate skips events without identity', async () => {
  const { updateDailyAnalyticsAggregate } = await import('../src/index.js');
  const { env, statements } = createAggregateFixture();
  await updateDailyAnalyticsAggregate(env, [
    { type: 'page_view', date: '2026-09-25', userId: '', visitorId: '' },
  ]);
  assert.equal(statements.filter((s) => s.sql.includes('analytics_daily_users')).length, 0);
  assert.equal(statements.filter((s) => s.sql.includes('analytics_daily_stats')).length, 1);
});

test('daily analytics aggregate is a no-op for empty input', async () => {
  const { updateDailyAnalyticsAggregate } = await import('../src/index.js');
  const { env, statements } = createAggregateFixture();
  await updateDailyAnalyticsAggregate(env, []);
  assert.equal(statements.length, 0);
});

function createGuestsFixture() {
  const statements = [];
  const users = new Map([
    ['user-admin', { id: 'user-admin', username: 'lovexl' }],
    ['user-regular', { id: 'user-regular', username: 'regular-user' }],
  ]);
  const sessions = new Map([
    ['admin-token', 'user-admin'],
    ['regular-token', 'user-regular'],
    ['expired-token', 'user-admin'],
    ['orphan-token', 'missing-user'],
  ].map(([token, userId]) => [createHash('sha256').update(token).digest('hex'), {
    user_id: userId,
    expires_at: token === 'expired-token' ? '2000-01-01T00:00:00.000Z' : new Date(Date.now() + 3600000).toISOString(),
  }]));
  const analyticsDailyUsers = [
    { identity: 'visitor-older', event_date: '2026-10-20', is_visitor_only: 1 },
    { identity: 'visitor-older', event_date: '2026-10-21', is_visitor_only: 1 },
    { identity: 'visitor-latest', event_date: '2026-10-22', is_visitor_only: 1 },
    { identity: 'visitor-latest', event_date: '2026-10-19', is_visitor_only: 1 },
    { identity: 'visitor-latest', event_date: '2026-10-23', is_visitor_only: 1 },
    { identity: 'user-regular', event_date: '2026-10-23', is_visitor_only: 0 },
  ];
  const env = {
    DB: {
      prepare(sql) {
        const query = sql.replace(/\s+/g, ' ').trim();
        const exec = (args = []) => ({
          async run() {
            assert.match(query, /^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/);
            return { success: true };
          },
          async first() {
            assert.equal(query, 'SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?');
            const session = sessions.get(args[0]);
            return session && session.expires_at > args[1] ? users.get(session.user_id) || null : null;
          },
          async all() {
            statements.push({ sql: query, args });
            assert.equal(query, 'SELECT identity AS visitorId, MIN(event_date) AS firstSeenDate, MAX(event_date) AS lastActiveDate, COUNT(*) AS activeDays FROM analytics_daily_users WHERE is_visitor_only = 1 GROUP BY identity ORDER BY lastActiveDate DESC LIMIT ?');
            const datesByVisitor = new Map();
            for (const row of analyticsDailyUsers) {
              if (row.is_visitor_only !== 1) continue;
              const dates = datesByVisitor.get(row.identity) || [];
              dates.push(row.event_date);
              datesByVisitor.set(row.identity, dates);
            }
            const results = [...datesByVisitor].map(([visitorId, dates]) => {
              dates.sort();
              return { visitorId, firstSeenDate: dates[0], lastActiveDate: dates.at(-1), activeDays: dates.length };
            }).sort((a, b) => b.lastActiveDate.localeCompare(a.lastActiveDate)).slice(0, args[0]);
            return { results };
          },
        });
        return { ...exec(), bind: (...args) => exec(args) };
      },
    },
  };
  return { env, statements };
}

function guestsRequest(token, query = '') {
  const headers = { origin: 'https://cn.freebacktrack.tech' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://api.freebacktrack.tech/api/sync/analytics/guests${query}`, { headers });
}

test('admin guests endpoint aggregates visitor-only identities across days in last-active order', async () => {
  const { env, statements } = createGuestsFixture();
  const response = await worker.fetch(guestsRequest('admin-token'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://cn.freebacktrack.tech');
  assert.deepEqual(await response.json(), {
    ok: true,
    available: true,
    guests: [
      { visitorId: 'visitor-latest', firstSeenDate: '2026-10-19', lastActiveDate: '2026-10-23', activeDays: 3 },
      { visitorId: 'visitor-older', firstSeenDate: '2026-10-20', lastActiveDate: '2026-10-21', activeDays: 2 },
    ],
  });
  assert.deepEqual(statements[0].args, [200]);
});

test('guests endpoint rejects a valid non-admin session without querying analytics', async () => {
  const { env, statements } = createGuestsFixture();
  const response = await worker.fetch(guestsRequest('regular-token'), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://cn.freebacktrack.tech');
  assert.deepEqual(statements, []);
});

test('guests endpoint requires an unexpired session belonging to an existing user', async (t) => {
  for (const token of [undefined, 'invalid-token', 'expired-token', 'orphan-token']) {
    await t.test(token || 'no token', async () => {
      const { env, statements } = createGuestsFixture();
      const response = await worker.fetch(guestsRequest(token), env);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://cn.freebacktrack.tech');
      assert.deepEqual(statements, []);
    });
  }
});

test('guests endpoint defaults invalid limits and clamps integer limits to 1–500', async (t) => {
  for (const [value, expected] of [
    ['', 200], [' ', 200], ['invalid', 200], ['5abc', 200], ['1.5', 200],
    ['Infinity', 200], ['NaN', 200], ['0', 1], ['-5', 1], ['1', 1], ['500', 500], ['999', 500],
  ]) {
    await t.test(JSON.stringify(value), async () => {
      const { env, statements } = createGuestsFixture();
      const response = await worker.fetch(guestsRequest('admin-token', `?limit=${encodeURIComponent(value)}`), env);
      assert.equal(response.status, 200);
      assert.deepEqual(statements[0].args, [expected]);
      assert.equal((await response.json()).guests.length, Math.min(expected, 2));
    });
  }
});
