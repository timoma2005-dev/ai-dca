import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSharesClient,
  limitLabel,
  creationLabel,
  snapshotLabel,
  sharesPeriodDates,
  freshnessMessage,
  validateSharesProjection
} from '../src/app/etfPcfSharesClient.js';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';
import { confirmedSharesCalendar } from '../shared/etfPcfTradingCalendar.js';
const base = Date.parse('2026-10-13T01:03:20.000Z');
const response = (data) => new Response(JSON.stringify(data));
test('non-admin/inactive disabled, memory/local hit, strict cycle inflight share; no extra GET', async () => {
  let clock = base,
    calls = 0,
    options;
  const values = new Map();
  const storage = () => ({ getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) });
  const fetchImpl = async (_url, opts) => {
    calls++;
    options = opts;
    return response(syntheticProjection());
  };
  const client = createSharesClient({ fetchImpl, now: () => clock, storage });
  await client.subscribe({ enabled: false }).promise;
  assert.equal(calls, 0);
  const a = client.subscribe();
  a.release();
  const b = client.subscribe();
  assert.equal(a.promise, b.promise);
  assert.equal((await b.promise).state, 'partial');
  b.release();
  assert.equal(options.redirect, 'manual');
  assert.equal(options.credentials, 'omit');
  await client.subscribe().promise;
  assert.equal(calls, 1);
  const second = createSharesClient({ fetchImpl, now: () => clock, storage });
  await second.subscribe().promise;
  assert.equal(calls, 1);
  clock += 300001;
  await client.subscribe().promise;
  assert.equal(calls, 2);
  assert.ok(values.keys().next().value.includes('2026-10-13:latest'));
});
test('404 memory negative cache 30s, corrupt local storage/source/key/expired degrade to one GET', async () => {
  let clock = base,
    calls = 0;
  const client = createSharesClient({
    now: () => clock,
    storage: () => {
      throw Error('denied');
    },
    fetchImpl: async () => {
      calls++;
      return new Response('{"reason":"cache_miss"}', { status: 404 });
    }
  });
  assert.equal((await client.subscribe().promise).state, 'empty');
  await client.subscribe().promise;
  assert.equal(calls, 1);
  clock += 30001;
  await client.subscribe().promise;
  assert.equal(calls, 2);
  for (const local of [
    '{bad',
    JSON.stringify({ key: 'wrong', receivedAt: base, data: syntheticProjection() }),
    JSON.stringify({
      key: client.keyFor(),
      receivedAt: base,
      data: { ...syntheticProjection(), source: 'bad' }
    })
  ]) {
    let count = 0;
    const c = createSharesClient({
      now: () => clock,
      storage: () => ({
        getItem: () => local,
        setItem: () => {
          throw Error('quota');
        }
      }),
      fetchImpl: async () => {
        count++;
        return response(syntheticProjection());
      }
    });
    assert.equal((await c.subscribe().promise).state, 'partial');
    assert.equal(count, 1);
  }
});
test('manual redirect rejection including opaque and body cancellation errors, failures retry', async () => {
  for (const code of [301, 302, 307, 308]) {
    let cancelled = 0;
    const c = createSharesClient({
      now: () => base,
      storage: () => null,
      fetchImpl: async () => ({
        status: code,
        body: {
          cancel: async () => {
            cancelled++;
            throw Error('cancel');
          }
        }
      })
    });
    assert.equal((await c.subscribe().promise).state, 'error');
    assert.equal(cancelled, 1);
  }
  const c = createSharesClient({
    now: () => base,
    storage: () => null,
    fetchImpl: async () => ({ type: 'opaqueredirect', status: 0 })
  });
  assert.equal((await c.subscribe().promise).state, 'error');
});
test('unmount abort delayed, remount shares promise, aborted work never reused', async () => {
  const signals = [];
  const c = createSharesClient({
    now: () => base,
    storage: () => null,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
      })
  });
  const a = c.subscribe();
  a.release();
  const b = c.subscribe();
  assert.equal(a.promise, b.promise);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(signals[0].aborted, false);
  b.release();
  await b.promise;
  assert.equal(signals[0].aborted, true);
  const d = c.subscribe();
  assert.notEqual(d.promise, a.promise);
  d.release();
  await d.promise;
});
test('Shanghai midnight isolates old response and old latest cache; stale errors cannot extend service expiry', async () => {
  let clock = Date.parse('2026-10-13T15:59:59.000Z'),
    calls = 0,
    resolve;
  const c = createSharesClient({
    now: () => clock,
    storage: () => null,
    fetchImpl: () => {
      calls++;
      return calls === 1
        ? new Promise((r) => (resolve = r))
        : Promise.resolve(response(syntheticProjection()));
    }
  });
  const old = c.subscribe();
  clock += 2000;
  const fresh = c.subscribe();
  await fresh.promise;
  resolve(response(syntheticProjection()));
  await old.promise;
  await c.subscribe().promise;
  assert.equal(calls, 2);
  clock += 300001;
  // Another client seeds, then handles read failure with its unexpired old object.
  let fail = false;
  const s = createSharesClient({
    now: () => clock,
    storage: () => null,
    fetchImpl: async () => {
      if (fail) throw Error('offline');
      return response(syntheticProjection());
    }
  });
  await s.subscribe().promise;
  fail = true;
  clock += 300001;
  assert.equal((await s.subscribe().promise).state, 'stale');
  clock = Date.parse('2026-11-13T01:03:20.000Z');
  assert.equal((await s.subscribe().promise).state, 'error');
});
test('limit labels preserve exact/near/over/negative/unlimited/unknown', () => {
  const x = syntheticProjection();
  assert.match(limitLabel(x.records[0]), /100% 精确相等/);
  assert.match(limitLabel(x.records[1]), /95% 接近/);
  assert.match(limitLabel(x.records[2]), /125%/);
  assert.match(limitLabel(x.records[3]), /净减少/);
  assert.match(limitLabel(x.records[4]), /累计不限/);
  assert.equal(limitLabel(x.records[5]), '—');
});

test('creation labels distinguish inferred net growth, exact zero and unknown subscription volume', () => {
  assert.equal(creationLabel({ creationShares: 10000000, creationSharesKind: 'estimate' }), '约 1,000');
  assert.equal(creationLabel({ creationShares: 8425300, creationSharesKind: 'estimate' }), '约 842.53');
  assert.equal(creationLabel({ creationShares: 0, creationSharesKind: 'exact' }), '0');
  assert.equal(creationLabel({ creationShares: null, creationSharesKind: null }), '暂无');
  assert.equal(creationLabel({ creationShares: -1000, creationSharesKind: 'estimate' }), '暂无');
});

test('PCF snapshot caption preserves the real statistics date; unverified dates never replace it', () => {
  const data = syntheticProjection();
  const pcfSnapshot = { source: 'szse_pcf', date: '2026-10-13', codes: ['159941'] };
  const snapshot = { ...data, pcfSnapshot };
  assert.equal(validateSharesProjection(snapshot, { now: new Date(base) }), true);
  assert.equal(snapshotLabel(snapshot), '2026-10-13 PCF 快照，份额统计截至 2026-10-12');
  assert.equal(snapshotLabel(data), '份额统计截至 2026-10-12，PCF 快照日期暂无');
  assert.equal(snapshotLabel({ ...data, pcfSnapshot: null }), snapshotLabel(data));
  assert.deepEqual(snapshot.records, data.records);
  for (const invalid of [
    { source: 'bad' },
    { date: '2026-10-14' },
    { date: '2026-10-09' },
    { codes: [] },
    { codes: ['513100'] },
    { codes: ['159941', '159941'] },
    { codes: [null] },
    { codes: ['159000'] }
  ])
    assert.equal(
      validateSharesProjection(
        { ...data, pcfSnapshot: { ...pcfSnapshot, ...invalid } },
        { now: new Date(base) }
      ),
      false
    );
});

test('October 14 PCF column dates align while measured October 13/12 balances remain unchanged', () => {
  const data = {
    ...syntheticProjection({
      date: '2026-10-13',
      prevDate: '2026-10-12',
      tradingCalendar: confirmedSharesCalendar('2026-10-04', '2026-10-14')
    }),
    pcfSnapshot: { source: 'szse_pcf', date: '2026-10-14', codes: ['159941'] }
  };
  const before = JSON.stringify(data);
  assert.deepEqual(sharesPeriodDates(data), {
    basis: 'PCF',
    currentDate: '2026-10-14',
    previousDate: '2026-10-13'
  });
  assert.equal(freshnessMessage(data, '2026-10-14'), '');
  assert.equal(JSON.stringify(data), before);
  assert.equal(data.records[0].date, '2026-10-13');
  assert.equal(data.records[0].prevDate, '2026-10-12');
  assert.equal(data.records[0].deltaShares, 10000000);
  const sameDay = {
    ...syntheticProjection({
      fetchedAt: '2026-10-14T01:00:00.000Z',
      date: '2026-10-14',
      prevDate: '2026-10-13',
      tradingCalendar: data.calendar
    }),
    pcfSnapshot: data.pcfSnapshot
  };
  assert.deepEqual(sharesPeriodDates(sameDay), {
    basis: 'PCF',
    currentDate: '2026-10-14',
    previousDate: '2026-10-13'
  });
});

test('PCF period dates follow trading sessions across a weekend; unsupported mapping keeps statistics', () => {
  const data = {
    date: '2026-10-09',
    prevDate: '2026-10-08',
    pcfSnapshot: { source: 'szse_pcf', date: '2026-10-12', codes: ['159941'] },
    calendar: confirmedSharesCalendar('2026-10-04', '2026-10-14')
  };
  assert.deepEqual(sharesPeriodDates(data), {
    basis: 'PCF',
    currentDate: '2026-10-12',
    previousDate: '2026-10-09'
  });
  for (const changes of [
    { calendar: null },
    { pcfSnapshot: null },
    { pcfSnapshot: { ...data.pcfSnapshot, source: 'bad' } },
    { pcfSnapshot: { ...data.pcfSnapshot, date: '2026-10-14' } }
  ])
    assert.deepEqual(sharesPeriodDates({ ...data, ...changes }), {
      basis: '统计',
      currentDate: data.date,
      previousDate: data.prevDate
    });
  assert.match(freshnessMessage(data, '2026-10-14'), /数据滞后/);
});

test('decision pills cover exact, near, over, outflow, unlimited and missing without quote fallbacks', async () => {
  const { sharesCeiling } = await import('../src/app/etfPcfSharesClient.js');
  const rows = syntheticProjection().records;
  assert.deepEqual(
    rows.slice(0, 6).map((r) => sharesCeiling(r).label),
    ['顶格 100%', '接近 95%', '超限 125%', '净流出', '累计不限', '数据待确认']
  );
  assert.deepEqual(sharesCeiling(rows.find((r) => r.code.startsWith('513'))), {
    kind: 'pending',
    label: '数据待确认'
  });
  // 沪市有限额数据时标签中性提示"有限额"，不突出数字（快照无申赎状态，暂停时数字会误导）。
  assert.deepEqual(
    sharesCeiling({ code: '513100', totalLimitKind: 'limited', totalLimitShares: 2500000 }),
    { kind: 'sse-limited', label: '有限额' }
  );
  assert.deepEqual(
    sharesCeiling({ code: '513390', totalLimitKind: 'limited', totalLimitShares: 120000000 }),
    { kind: 'sse-limited', label: '有限额' }
  );
  assert.deepEqual(sharesCeiling({ code: '513300', totalLimitKind: 'unlimited' }), {
    kind: 'unlimited',
    label: '累计不限'
  });
  assert.equal(
    sharesCeiling({ ...rows[0], deltaShares: null, atLimit: null, high52w: 123 }).label,
    '数据待确认'
  );
  assert.equal(
    sharesCeiling({ ...rows[0], atLimit: false, nearTotalLimit: false, utilization: 0.5 }).label,
    '未顶格 50%'
  );
  assert.equal(creationLabel({ creationShares: null, deltaShares: 10000 }), '暂无');
  assert.ok(rows.every((r) => r.deltaAmountWan === null));
});
