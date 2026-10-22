import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syntheticProjection, sseDeltaProjection, calendar } from './helpers/etfPcfSharesFixture.mjs';
import {
  validateSharesProjection,
  buildSharesProjection,
  persistSharesProjection,
  sharesKey,
  previousSession,
  SOURCE,
  TTL
} from '../workers/etf-shares/src/etfPcfSharesProjection.js';
const now = new Date('2026-10-14T00:00:00.000Z');
test('synthetic exact/near/over/negative/zero/unlimited and partial, v1 NAV is always absent', () => {
  const data = syntheticProjection();
  assert.equal(validateSharesProjection(data, { now }), true);
  assert.equal(data.records[0].deltaShares, 10000000);
  assert.equal(data.records[0].atLimit, true);
  assert.equal(data.records[1].atLimit, false);
  assert.equal(data.records[1].nearTotalLimit, true);
  assert.equal(data.records[2].utilization, 1.25);
  assert.equal(data.records[3].nearTotalLimit, false);
  assert.equal(data.records[4].atLimit, null);
  assert.equal(data.records[7].deltaShares, 0);
  assert.ok(data.records.every((r) => r.deltaAmountWan === null));
  assert.equal(validateSharesProjection(syntheticProjection({ partial: true }), { now }), true);
});
test('513 legal prevShares/delta/status/utilization passes; legacy snapshots keep passing; passthrough fields optional', () => {
  // 新快照：513 携带非空 prevShares/deltaShares 与一致的 status/utilization 口径，整体通过共享校验。
  const data = sseDeltaProjection();
  const sse = data.records.find((r) => r.code === '513100');
  assert.equal(sse.prevShares, 29990000000);
  assert.equal(sse.deltaShares, 10000000);
  assert.equal(sse.status, 'complete');
  assert.equal(validateSharesProjection(data, { now }), true);
  // 旧快照（513 prevShares/deltaShares 均为 null）继续通过。
  assert.equal(validateSharesProjection(syntheticProjection(), { now }), true);
  // 透传新字段可缺失：完全去掉环比字段的旧形态同样通过，不因缺少新字段被拒绝。
  const legacy = structuredClone(data);
  for (const r of legacy.records) {
    delete r.limitChange;
    delete r.limitChanges;
    delete r.prevLimitDate;
  }
  delete legacy.limitDate;
  delete legacy.prevLimitDate;
  delete legacy.limitSummary;
  assert.equal(validateSharesProjection(legacy, { now }), true);
});

test('513 delta/date/utilization/status inconsistencies reject under the unified 159 checks', () => {
  for (const mutate of [
    (r) => {
      r.deltaShares += 1;
    },
    (r) => {
      r.prevDate = '2026-10-08';
    },
    (r) => {
      r.utilization = 0.9;
    },
    (r) => {
      r.status = 'partial';
    }
  ]) {
    const x = sseDeltaProjection();
    mutate(x.records.find((r) => r.code === '513100'));
    assert.equal(validateSharesProjection(x, { now }), false);
  }
});

test('no calendar means no claimed adjacent-session delta; holiday sequence and malformed calendars', () => {
  assert.equal(previousSession('2026-10-12', calendar), '2026-10-09');
  assert.equal(previousSession('2026-10-12', null), null);
  assert.equal(previousSession('2026-10-12', { ...calendar, sessions: ['2026-10-12', '2026-10-09'] }), null);
  const x = buildSharesProjection({
    date: '2026-10-12',
    records: [{ code: '159501', date: '2026-10-12', shares: 10, unit: '份' }],
    fetchedAt: '2026-10-13T01:00:00.000Z',
    projectedAt: '2026-10-13T01:00:00.000Z',
    dateEvidence: { source: 'szse_fund_report', column: '日期', type: 'iso_date' }
  });
  assert.equal(x.records[0].deltaShares, null);
  assert.equal(validateSharesProjection(x, { now }), true);
});
test('schema rejects date/key/source/shape/math/time/price/identity corruption', () => {
  for (const mutate of [
    (x) => (x.source = 'other'),
    (x) => (x.date = '2026-02-30'),
    (x) => x.records.reverse(),
    (x) => x.records.pop(),
    (x) => (x.records[0] = null),
    (x) => (x.records[0] = {}),
    (x) => x.records[0].deltaShares++,
    (x) => (x.records[0].price = 2),
    (x) => (x.records[0].limitDate = 'not-a-date'),
    (x) => (x.records[0].atLimit = false),
    (x) => (x.prevDate = '2026-10-08'),
    (x) => (x.dateEvidence = null),
    (x) => (x.projectedAt = '2026-10-15T00:00:00.000Z'),
    (x) => (x.expiresAt = '2026-11-15T00:00:00.000Z'),
    (x) => (x.records[0].prevShares = -1)
  ]) {
    const x = syntheticProjection();
    mutate(x);
    assert.equal(validateSharesProjection(x, { now }), false);
  }
  assert.throws(() => sharesKey('x:latest'));
  // f65b5ca7: limitDate may differ from projection date (e.g. backfill with
  // limitDate=2026-10-16 on a 2026-10-15 projection); only malformed dates reject.
  const x = syntheticProjection();
  x.records[0].limitDate = '2026-10-09';
  assert.equal(validateSharesProjection(x, { now }), true);
  assert.equal(
    validateSharesProjection(syntheticProjection(), { now: new Date('2026-11-13T01:03:20.000Z') }),
    false
  );
});
test('TTL anchored to fetch; monotone pointer; independent date/pointer failures; budget and unchanged skip', async () => {
  const data = syntheticProjection({ fetchedAt: new Date(Date.now() - 10000).toISOString() });
  const values = new Map(),
    puts = [];
  const kv = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value, options) => {
      puts.push({ key, value, options, at: Date.now() });
      values.set(key, value);
    }
  };
  assert.equal((await persistSharesProjection(kv, data)).ok, true);
  assert.equal(puts.length, 2);
  for (const put of puts)
    assert.equal(put.options.expirationTtl, Math.floor((Date.parse(data.expiresAt) - put.at) / 1000));
  await persistSharesProjection(kv, data);
  assert.equal(puts.length, 2);
  assert.equal(
    (await persistSharesProjection(kv, data, { deadlineAt: Date.now() })).reason,
    'projection_budget'
  );
  const failPut = {
    get: async () => null,
    put: async () => {
      throw Error('failure');
    }
  };
  assert.equal((await persistSharesProjection(failPut, data)).reason, 'projection_put_failed');
  const failPointer = { get: async (key) => (key.endsWith('latest') ? '{bad' : null), put: async () => {} };
  assert.equal((await persistSharesProjection(failPointer, data)).reason, 'projection_pointer_failed');
  const newer = {
    schemaVersion: 1,
    source: SOURCE,
    date: '2026-10-13',
    fetchedAt: data.fetchedAt,
    expiresAt: data.expiresAt,
    key: sharesKey('2026-10-13')
  };
  values.set('etf-pcf-shares:latest', JSON.stringify(newer));
  assert.equal((await persistSharesProjection(kv, data)).pointer, 'unchanged');
  assert.equal(Date.parse(data.expiresAt) - Date.parse(data.fetchedAt), TTL);
});
test('remaining TTL below 60s refuses write; delayed KV abort stays inside budget; same-key edits obey 1s spacing', async () => {
  let puts = [];
  const values = new Map();
  const kv = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      puts.push({ key, at: Date.now() });
      values.set(key, value);
    }
  };
  const old = syntheticProjection({ fetchedAt: new Date(Date.now() - 10000).toISOString() });
  const originalNow = Date.now;
  Date.now = () => Date.parse(old.expiresAt) - 59000;
  try {
    assert.equal((await persistSharesProjection(kv, old)).reason, 'projection_put_failed');
    assert.equal(puts.length, 0);
  } finally {
    Date.now = originalNow;
  }
  const data = syntheticProjection({ fetchedAt: new Date(Date.now() - 10000).toISOString() });
  await persistSharesProjection(kv, data);
  const changed = structuredClone(data);
  changed.records[0].name += ' revised';
  await persistSharesProjection(kv, changed);
  const dated = puts.filter((p) => p.key === sharesKey(data.date));
  assert.equal(dated.length, 2);
  assert.ok(dated[1].at - dated[0].at >= 1000);
  const controller = new AbortController();
  const hanging = { get: () => new Promise(() => {}), put: async () => {} };
  const pending = persistSharesProjection(hanging, data, {
    deadlineAt: Date.now() + 2000,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await pending).reason, 'projection_put_failed');
});

test('verified 2026 calendar excludes long holidays and rejects an omitted intermediate session or unsupported year', async () => {
  const { confirmedSharesCalendar } = await import('../shared/etfPcfTradingCalendar.js');
  const c = confirmedSharesCalendar('2026-09-28', '2026-10-09');
  assert.equal(previousSession('2026-10-08', c), '2026-09-30');
  assert.equal(previousSession('2026-10-09', c), '2026-10-08');
  assert.equal(
    previousSession('2026-10-09', { ...c, sessions: c.sessions.filter((d) => d !== '2026-10-08') }),
    null
  );
  assert.equal(confirmedSharesCalendar('2027-01-01', '2027-01-10'), null);
});
test('acknowledged isolate state prevents rollback when KV reads remain temporarily invisible', async () => {
  const puts = [];
  const kv = { get: async () => null, put: async (key, value) => puts.push({ key, value }) };
  const current = syntheticProjection({ fetchedAt: new Date(Date.now() - 1000).toISOString() });
  const older = syntheticProjection({ fetchedAt: new Date(Date.now() - 10000).toISOString() });
  await persistSharesProjection(kv, current);
  assert.equal((await persistSharesProjection(kv, older)).pointer, 'unchanged');
  assert.equal(puts.length, 2);
  await persistSharesProjection(kv, current);
  // Acknowledged matching pointer must also skip writing despite stale get(null).
  assert.equal(puts.filter((p) => p.key === sharesKey(current.date)).length, 1);
});

test('13 ETFs: normalized PCF creation status, signed estimates, and honest SSE gaps', async () => {
  const { normalizeCreationStatus, TARGET_CODES } = await import('../shared/etfPcfSharesSchema.js');
  for (const [input, expected] of [
    ['仅允许赎回', [false, true]],
    ['仅允许申购', [true, false]],
    ['申购和赎回皆允许', [true, true]],
    ['申购赎回都允许', [true, true]],
    ['申购和赎回都允许', [true, true]],
    ['未知状态', [null, null]],
    [{ subscriptionAllowed: true, redemptionAllowed: false }, [true, false]],
    [{ subscriptionAllowed: 'false' }, [null, null]],
    [null, [null, null]]
  ])
    assert.deepEqual(Object.values(normalizeCreationStatus(input)), expected);
  const base = syntheticProjection();
  const records = base.records.slice(0, 8).flatMap((r) => [
    { code: r.code, date: base.date, shares: r.shares, unit: '份' },
    { code: r.code, date: base.prevDate, shares: r.prevShares, unit: '份' }
  ]);
  const build = (creationStatus) =>
    buildSharesProjection({
      date: base.date,
      records,
      creationStatus,
      calendar: base.calendar,
      fetchedAt: base.fetchedAt,
      projectedAt: base.projectedAt,
      dateEvidence: base.dateEvidence,
      limits: [{ code: '513100', date: base.date, total: { kind: 'limited', shares: 100 } }]
    });
  const x = build({
    159501: normalizeCreationStatus('仅允许赎回'),
    159509: normalizeCreationStatus('仅允许申购'),
    159513: normalizeCreationStatus('申购和赎回皆允许'),
    159632: normalizeCreationStatus('申购和赎回皆允许'),
    513100: normalizeCreationStatus('仅允许赎回'),
    513110: normalizeCreationStatus('仅允许申购'),
    513300: normalizeCreationStatus('申购和赎回皆允许')
  });
  assert.equal(x.records.length, 13);
  assert.deepEqual(
    x.records.map((r) => r.code),
    TARGET_CODES
  );
  assert.deepEqual(
    x.records.slice(0, 4).map((r) => [r.creationShares, r.creationSharesKind]),
    [
      [0, 'exact'],
      [9500000, 'exact'],
      [12500000, 'estimate'],
      [-1000000, 'estimate']
    ]
  );
  assert.equal(x.records[4].creationShares, null);
  for (const [i, r] of x.records.slice(8).entries()) {
    assert.equal(
      r.name,
      ['纳指ETF国泰', '纳指ETF华泰柏瑞', '纳斯达克ETF华夏', '纳指100ETF博时', '纳指ETF富国'][i]
    );
    assert.equal(r.status, 'partial');
    assert.ok(r.reasons.includes('missing_shares'));
    // 7908fc3d 后 513 限额走上交所 PCF：注入的 513100 限额生效，其余 513 无限额。
    assert.deepEqual(
      [r.shares, r.prevShares, r.deltaShares, r.totalLimitShares, r.limitDate],
      [null, null, null, i === 0 ? 100 : null, i === 0 ? '2026-10-12' : null]
    );
    assert.equal(r.totalLimitKind, i === 0 ? 'limited' : 'unknown');
    assert.equal(r.creationShares, i === 0 ? 0 : null);
    assert.equal(r.creationSharesKind, i === 0 ? 'exact' : null);
  }
  assert.equal(validateSharesProjection(x, { now }), true);
  const negativeExact = build({ 159632: normalizeCreationStatus('仅允许申购') });
  assert.equal(negativeExact.records[3].creationShares, null);
  assert.equal(negativeExact.records[3].creationSharesKind, null);
  for (const mutate of [
    (r) => {
      r.creationShares = 1.5;
      r.creationSharesKind = 'exact';
    },
    (r) => {
      r.creationShares = -1;
      r.creationSharesKind = 'exact';
    },
    (r) => {
      r.creationShares = null;
      r.creationSharesKind = 'estimate';
    },
    (r) => {
      r.creationShares = 1;
      r.creationSharesKind = 'estimate';
    },
    (r) => {
      delete r.creationShares;
    },
    (r) => {
      r.creationSharesKind = 'unknown';
    }
  ]) {
    const corrupted = structuredClone(x);
    mutate(corrupted.records[0]);
    assert.equal(validateSharesProjection(corrupted, { now }), false);
  }
});
