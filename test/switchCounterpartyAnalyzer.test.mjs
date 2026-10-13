import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  analyzeCounterparties,
  clearCounterpartyHistoryCache,
  defaultCounterpartyPool,
  selectBestCounterparty
} from '../src/app/switchCounterpartyAnalyzer.js';

let originalFetch;
let originalNow;
let calls;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalNow = Date.now;
  calls = [];
  clearCounterpartyHistoryCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  clearCounterpartyHistoryCache();
});

function points(value, length = 80, offset = 0) {
  return Array.from({ length }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + offset + 1)).toISOString().slice(0, 10),
    premiumPercent: typeof value === 'function' ? value(i) : value
  }));
}

function mockHistories(histories) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const code = url.match(/premium\/(\d{6})/)[1];
    return { ok: true, json: async () => ({ points: histories[code] }) };
  };
}

const alternating = (amplitude, mean = 0) => (i) => mean + (i % 2 ? amplitude : -amplitude);

test('ranks candidates by crossing count times population volatility', async () => {
  mockHistories({ '159513': points(0), '159509': points(alternating(1)), '159941': points(alternating(3)) });
  const ranked = await analyzeCounterparties('159513', ['159509', '159941']);
  assert.deepEqual(ranked.map(({ code }) => code), ['159941', '159509']);
  assert.equal(ranked[0].crossingCount, 79);
  assert.equal(ranked[0].volatility, 3);
  assert.equal(ranked[0].score, 237);
  assert.ok(ranked[0].name);
  assert.equal(calls[0].url, '/api/market-collector/premium/159513?interval=1d&limit=180');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  assert.ok(calls[0].options.signal instanceof globalThis.AbortSignal);
});

test('excludes candidates with fewer than 20 strict mean crossings', async () => {
  mockHistories({ '159513': points(0), '159509': points((i) => i), '159941': points(0) });
  assert.deepEqual(await analyzeCounterparties('159513', ['159509', '159941']), []);
});

test('aligns and sorts only intersecting dates, filtering invalid points', async () => {
  mockHistories({
    '159513': points(0),
    '159509': [...points(alternating(2), 80, 10).reverse(),
      { date: '2026-01-01', premiumPercent: null },
      { date: '', premiumPercent: 100 },
      { date: '2026-01-02', premiumPercent: Infinity }]
  });
  const [result] = await analyzeCounterparties('159513', ['159509']);
  assert.equal(result.alignedCount, 70);
  assert.equal(result.crossingCount, 69);
  assert.equal(result.volatility, 2);
});

test('positive mean spread places candidate above holding on average', async () => {
  mockHistories({ '159513': points(5), '159509': points(alternating(2, 8)) });
  const selection = await selectBestCounterparty('159513', ['159509']);
  assert.equal(selection.code, '159509');
  assert.equal(selection.stats.meanSpread, 3);
});

test('returns null when fetch throws or responds non-OK', async () => {
  for (const fail of [async () => { throw new Error('offline'); }, async () => ({ ok: false })]) {
    globalThis.fetch = fail;
    assert.equal(await selectBestCounterparty('159513', ['159509']), null);
  }
});

test('reuses history cache across analysis and selection calls within one hour', async () => {
  mockHistories({ '159513': points(0), '159509': points(alternating(2)) });
  await analyzeCounterparties('159513', ['159509']);
  await analyzeCounterparties('159513', ['159509']);
  await selectBestCounterparty('159509', ['159513']);
  assert.equal(calls.length, 2);
});

test('refetches expired cache using the same code keys', async () => {
  let now = 1000;
  Date.now = () => now;
  mockHistories({ '159513': points(0), '159509': points(alternating(2)) });
  await analyzeCounterparties('159513', ['159509']);
  now += 60 * 60 * 1000;
  await analyzeCounterparties('159513', ['159509']);
  assert.equal(calls.length, 4);
});

test('holding failure or insufficient history returns no candidates', async () => {
  for (const holding of [undefined, points(0, 59)]) {
    clearCounterpartyHistoryCache();
    mockHistories({ '159513': holding, '159509': points(alternating(2)) });
    assert.deepEqual(await analyzeCounterparties('159513', ['159509']), []);
  }
});

test('excludes insufficient aligned history and malformed candidate payloads', async () => {
  mockHistories({ '159513': points(0), '159509': points(alternating(2), 80, 30), '159941': {} });
  assert.deepEqual(await analyzeCounterparties('159513', ['159509', '159941']), []);
});

test('default pool excludes holding and includes the six-digit LOF code', () => {
  const pool = defaultCounterpartyPool('159513');
  assert.equal(pool.length, 13);
  assert.ok(!pool.includes('159513'));
  assert.ok(pool.includes('161128'));
  assert.ok(pool.every((code) => /^\d{6}$/.test(code)));
});


test('rejects mismatched history source without poisoning the code cache', async () => {
  mockHistories({ '159513': points(0), '159509': points(alternating(2)) });
  const validFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/159509?')) {
      return { ok: true, json: async () => ({ symbol: '159941', interval: '1d', points: points(alternating(2)) }) };
    }
    return validFetch(url, options);
  };
  assert.deepEqual(await analyzeCounterparties('159513', ['159509']), []);
  globalThis.fetch = validFetch;
  assert.equal((await analyzeCounterparties('159513', ['159509'])).length, 1);
  assert.equal(calls.length, 2);
});
