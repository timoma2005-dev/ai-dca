import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

import {
  __internals as cacheInternals,
  readCachedKline,
  writeCachedKline,
} from '../src/app/marketHistoryCache.js';
import { __internals as apiInternals, fetchKline } from '../src/app/marketsApi.js';

const { Response, URL, queueMicrotask, structuredClone } = globalThis;
const NOW = Date.parse('2026-10-22T08:00:00Z');
const MINUTE = 60 * 1000;
const records = new Map();
const originalIndexedDb = globalThis.indexedDB;

// Exercise the real cache reader/writer without adding a browser or dependency.
function memoryIndexedDb() {
  return {
    open(name, version) {
      assert.equal(name, cacheInternals.DB_NAME);
      assert.equal(version, 1);
      const request = {};
      queueMicrotask(() => {
        request.result = {
          transaction(storeName) {
            assert.equal(storeName, cacheInternals.STORE_NAME);
            const tx = {
              objectStore() {
                return {
                  get(key) {
                    const req = {};
                    queueMicrotask(() => {
                      req.result = structuredClone(records.get(key));
                      req.onsuccess();
                    });
                    return req;
                  },
                  put(record) {
                    records.set(record.key, structuredClone(record));
                    queueMicrotask(() => tx.oncomplete());
                  },
                  count() {
                    const req = {};
                    queueMicrotask(() => {
                      req.result = records.size;
                      req.onsuccess();
                      tx.oncomplete();
                    });
                    return req;
                  },
                };
              },
            };
            return tx;
          },
        };
        request.onsuccess();
      });
      return request;
    },
  };
}

before(() => { globalThis.indexedDB = memoryIndexedDb(); });
after(() => {
  if (originalIndexedDb === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = originalIndexedDb;
});
beforeEach((t) => {
  records.clear();
  apiInternals.clearMarketsApiInflight();
  t.mock.method(Date, 'now', () => NOW);
});

function candle(date) {
  return { date, t: Date.parse(`${date}T15:00:00+08:00`) / 1000, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 100 };
}

function seedKline({
  symbol = '513390', timeframe = '1d', dates = ['2026-09-17', '2026-09-30'],
  storedAt = NOW - 31 * MINUTE, source = 'sina-kline', candles = dates.map(candle),
} = {}) {
  const key = cacheInternals.cacheKey({ symbol, timeframe });
  const record = {
    key, type: 'kline', symbol, timeframe, candles, storedAt,
    payload: { symbol, source, candles },
  };
  records.set(key, record);
  return record;
}

function stubFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    calls.push(String(input));
    return handler(input);
  });
  return calls;
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

test('daily freshness uses the nearest Shanghai trading day across holidays, weekends and UTC midnight', () => {
  const cases = [
    ['2026-10-22T08:00:00Z', '2026-10-22', true],
    ['2026-10-22T08:00:00Z', '2026-10-23', true],
    ['2026-10-22T08:00:00Z', '2026-10-21', false],
    ['2026-10-02T08:00:00Z', '2026-09-30', true],
    ['2026-10-02T08:00:00Z', '2026-09-29', false],
    ['2026-10-24T08:00:00Z', '2026-10-23', true],
    ['2026-10-24T08:00:00Z', '2026-10-22', false],
    ['2026-10-22T16:05:00Z', '2026-10-22', false],
    ['2026-10-22T16:05:00Z', '2026-10-23', true],
  ];
  for (const [now, date, expected] of cases) {
    assert.equal(cacheInternals.isKlineCacheFresh({
      candles: [candle(date)], storedAt: Date.parse(now) - 31 * MINUTE, now: Date.parse(now),
    }), expected, `${now}: last candle ${date}`);
  }
});

test('the recent-fetch exemption includes 30 minutes and rejects older, future or invalid storedAt', () => {
  const cases = [
    [NOW, true], [NOW - 30 * MINUTE, true], [NOW - 30 * MINUTE - 1, false],
    [NOW + 1, false], [undefined, false], [null, false], [0, false], [-1, false],
    [NaN, false], [Infinity, false], ['invalid', false],
  ];
  for (const [storedAt, expected] of cases) {
    assert.equal(cacheInternals.isKlineCacheFresh({
      candles: [candle('2026-09-30')], storedAt, now: NOW,
    }), expected, `storedAt=${storedAt}`);
  }
});

test('readCachedKline hits current daily candles even without storedAt', async () => {
  const record = seedKline({ dates: ['2026-10-21', '2026-10-22'] });
  delete record.storedAt;
  const result = await readCachedKline({ symbol: '513390', minCandles: 2 });
  assert.equal(result.source, 'indexeddb');
  assert.equal(result.dataSource, 'sina-kline');
  assert.equal(result.cache.stale, false);
  assert.equal(result.candles.at(-1).date, '2026-10-22');
});

test('readCachedKline misses old daily candles written more than 30 minutes ago', async () => {
  seedKline();
  assert.equal(await readCachedKline({ symbol: '513390' }), null);
});

test('readCachedKline accepts old candles at the recent-fetch boundary', async () => {
  seedKline({ storedAt: NOW - 30 * MINUTE });
  const result = await readCachedKline({ symbol: '513390' });
  assert.equal(result.cache.stale, false);
  assert.equal(result.candles.at(-1).date, '2026-09-30');
});

test('an explicit historical endDate keeps range-only semantics', async () => {
  seedKline();
  const result = await readCachedKline({
    symbol: '513390', startDate: '2026-09-17', endDate: '2026-09-30', minCandles: 2,
  });
  assert.equal(result.cache.stale, false);
  assert.equal(result.candles.at(-1).date, '2026-09-30');
  assert.equal(await readCachedKline({ symbol: '513390', startDate: '2026-09-17' }), null);
});

test('session-suffixed daily candles require freshness while intraday timeframes remain unchanged', async () => {
  seedKline({ timeframe: '1d|session=all' });
  assert.equal(await readCachedKline({ symbol: '513390', timeframe: '1d|session=all' }), null);
  for (const timeframe of ['5m', '5m|session=all']) {
    seedKline({ timeframe });
    assert.equal((await readCachedKline({ symbol: '513390', timeframe })).cache.stale, false);
  }
});

test('eastmoney-direct is excluded for both payload and legacy sources, including allowStale', async () => {
  const record = seedKline({ source: 'eastmoney-direct', storedAt: NOW, dates: ['2026-10-22'] });
  for (const allowStale of [false, true]) {
    assert.equal(await readCachedKline({ symbol: '513390', allowStale }), null);
  }
  delete record.payload.source;
  record.source = 'eastmoney-direct';
  for (const allowStale of [false, true]) {
    assert.equal(await readCachedKline({ symbol: '513390', allowStale }), null);
  }
});

test('allowStale returns expired candles with both stale flags without changing storedAt', async () => {
  const record = seedKline();
  const result = await readCachedKline({ symbol: '513390', allowStale: true });
  assert.equal(result.stale, true);
  assert.equal(result.cache.stale, true);
  assert.equal(result.dataSource, 'sina-kline');
  assert.equal(records.get(record.key).storedAt, NOW - 31 * MINUTE);
  assert.equal(await readCachedKline({ symbol: '513390' }), null);
});

test('allowStale does not mark a current cache entry as expired', async () => {
  seedKline({ dates: ['2026-10-21', '2026-10-22'] });
  const result = await readCachedKline({ symbol: '513390', allowStale: true });
  assert.equal(result.cache.stale, false);
  assert.notEqual(result.stale, true);
});

test('allowStale cannot bypass range coverage, minimum count or malformed candles', async () => {
  seedKline();
  for (const options of [
    { startDate: '2026-09-16' }, { endDate: '2026-10-01' }, { minCandles: 3 },
  ]) {
    assert.equal(await readCachedKline({ symbol: '513390', allowStale: true, ...options }), null);
  }
  for (const candles of [[], [{ date: 'invalid', t: 0 }], 'invalid']) {
    seedKline({ candles });
    assert.equal(await readCachedKline({ symbol: '513390', allowStale: true }), null);
  }
});

test('freshness checks the normalized last Shanghai candle, including timestamp-only data', async () => {
  seedKline({ candles: [
    { t: Date.parse('2026-10-21T16:05:00Z') / 1000, c: 1.2 },
    candle('2026-09-30'),
  ] });
  const result = await readCachedKline({ symbol: '513390' });
  assert.equal(result.candles.at(-1).date, '2026-10-22');
  assert.equal(result.cache.stale, false);
});

test('cache writes use the requested symbol/timeframe key and cannot overwrite neighboring entries', async () => {
  const daily = seedKline();
  const otherSymbol = seedKline({ symbol: '513100' });
  const timeframe = '1d|session=all';
  assert.equal(await writeCachedKline({
    symbol: ' 513390 ', timeframe,
    payload: { key: otherSymbol.key, symbol: '513100', timeframe: '5m', source: 'sina-kline', candles: [candle('2026-10-22')] },
  }), true);
  await setImmediate();
  assert.equal(records.size, 3);
  const written = records.get('kline|513390|1d|session=all');
  assert.equal(written.symbol, '513390');
  assert.equal(written.timeframe, timeframe);
  assert.equal(written.storedAt, NOW);
  assert.deepEqual(records.get(daily.key), daily);
  assert.deepEqual(records.get(otherSymbol.key), otherSymbol);
  assert.equal((await readCachedKline({ symbol: '513390', timeframe })).cache.stale, false);
});

test('cache writes reject missing symbols and empty or unnormalizable candles', async () => {
  assert.equal(await writeCachedKline({ payload: { candles: [candle('2026-10-22')] } }), false);
  assert.equal(await writeCachedKline({ symbol: '513390', payload: { candles: [] } }), false);
  assert.equal(await writeCachedKline({ symbol: '513390', payload: { candles: [{ date: 'invalid' }] } }), false);
  assert.equal(records.size, 0);
});

test('fetchKline returns current cached candles without calling live and respects the requested limit', async (t) => {
  seedKline({ dates: ['2026-10-20', '2026-10-21', '2026-10-22'] });
  const calls = stubFetch(t, () => { throw new Error('unexpected live fetch'); });
  const result = await fetchKline('513390', { market: 'cn', limit: 2 });
  assert.equal(calls.length, 0);
  assert.equal(result.source, 'indexeddb');
  assert.equal(result.cache.stale, false);
  assert.deepEqual(result.candles.map((row) => row.date), ['2026-10-21', '2026-10-22']);
});

test('fetchKline honors the recent-fetch exemption without calling live', async (t) => {
  seedKline({ storedAt: NOW - 30 * MINUTE });
  const calls = stubFetch(t, () => { throw new Error('unexpected live fetch'); });
  const result = await fetchKline('513390');
  assert.equal(calls.length, 0);
  assert.equal(result.cache.stale, false);
});

test('fetchKline refreshes expired daily/session data and overwrites the same key', async (t) => {
  const record = seedKline({ timeframe: '1d|session=all' });
  const live = { source: 'xueqiu-kline', candles: [candle('2026-10-21'), candle('2026-10-22')] };
  const calls = stubFetch(t, () => jsonResponse(live));
  assert.deepEqual(await fetchKline('513390', { market: 'cn', session: 'all', limit: 2 }), live);
  await setImmediate();
  assert.equal(calls.length, 1);
  const url = new URL(calls[0], 'https://example.test');
  assert.equal(url.pathname, '/api/markets/kline/513390');
  assert.equal(url.searchParams.get('tf'), '1d');
  assert.equal(url.searchParams.get('session'), 'all');
  assert.equal(records.size, 1);
  assert.equal(records.get(record.key).storedAt, NOW);
  assert.equal(records.get(record.key).candles.at(-1).date, '2026-10-22');
  const cached = await fetchKline('513390', { market: 'cn', session: 'all', limit: 2 });
  assert.equal(calls.length, 1);
  assert.equal(cached.cache.stale, false);
});

test('an unchanged live tail is cached for 30 minutes, then fetched again', async (t) => {
  const record = seedKline();
  const calls = stubFetch(t, () => jsonResponse(record.payload));
  await fetchKline('513390');
  await setImmediate();
  assert.equal(calls.length, 1);
  assert.equal((await fetchKline('513390')).cache.stale, false);
  assert.equal(calls.length, 1);
  t.mock.method(Date, 'now', () => NOW + 30 * MINUTE + 1);
  await fetchKline('513390');
  await setImmediate();
  assert.equal(calls.length, 2);
});

test('fetchKline falls back after a live exception with both stale flags and without renewing the cache', async (t) => {
  const record = seedKline({ timeframe: '1d|session=all', dates: ['2026-09-16', '2026-09-17', '2026-09-30'] });
  const calls = stubFetch(t, () => { throw new Error('live unavailable'); });
  const result = await fetchKline('513390', { session: 'all', limit: 2 });
  assert.equal(calls.length, 1);
  assert.equal(result.stale, true);
  assert.equal(result.cache.stale, true);
  assert.equal(result.source, 'indexeddb');
  assert.equal(result.dataSource, 'sina-kline');
  assert.deepEqual(result.candles.map((row) => row.date), ['2026-09-17', '2026-09-30']);
  assert.equal(records.get(record.key).storedAt, NOW - 31 * MINUTE);
});

test('fetchKline also marks a cache fallback stale after an HTTP failure', async (t) => {
  seedKline();
  const calls = stubFetch(t, () => new Response('', { status: 503 }));
  const result = await fetchKline('513390');
  assert.equal(calls.length, 1);
  assert.equal(result.stale, true);
  assert.equal(result.cache.stale, true);
});

test('fetchKline keeps the original live error when no cache, sufficient range or approved source is available', async (t) => {
  const error = new Error('live unavailable');
  const calls = stubFetch(t, () => { throw error; });
  await assert.rejects(fetchKline('513390'), (actual) => actual === error);
  seedKline();
  await assert.rejects(fetchKline('513390', { minCandles: 3 }), (actual) => actual === error);
  seedKline({ source: 'eastmoney-direct' });
  await assert.rejects(fetchKline('513390'), (actual) => actual === error);
  assert.equal(calls.length, 3);
});

test('an explicit forceLive request still calls live, and a failed request marks even current fallback data stale', async (t) => {
  seedKline({ dates: ['2026-10-21', '2026-10-22'] });
  const calls = stubFetch(t, () => { throw new Error('live unavailable'); });
  const result = await fetchKline('513390', { forceLive: true });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0], 'https://example.test').searchParams.get('live'), '1');
  assert.equal(result.stale, true);
  assert.equal(result.cache.stale, true);
});
