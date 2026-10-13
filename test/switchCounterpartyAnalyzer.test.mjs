import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  analyzeCounterparties,
  backtestSpread,
  DEFAULT_AUTO_LOWER_PCT,
  DEFAULT_AUTO_UPPER_PCT,
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

test('ranks candidates by realized return after fees', async () => {
  mockHistories({ '159513': points(0), '159509': points(alternating(2, 2)), '159941': points(alternating(3, 2)) });
  const ranked = await analyzeCounterparties('159513', ['159509', '159941'], { lowerPct: 1, upperPct: 3 });
  assert.deepEqual(ranked.map(({ code }) => code), ['159941', '159509']);
  assert.equal(ranked[0].crossingCount, 79);
  assert.equal(ranked[0].volatility, 3);
  assert.equal(ranked[0].trades, 80);
  assert.equal(ranked[0].roundTrips, 40);
  assert.equal(ranked[0].returnPct, 232);
  assert.equal(ranked[1].returnPct, 152);
  assert.ok(ranked[0].name);
  assert.equal(calls[0].url, '/api/market-collector/premium/159513?interval=1d&limit=180');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  assert.ok(calls[0].options.signal instanceof globalThis.AbortSignal);
});

test('excludes flat high spreads that cannot complete a round trip', async () => {
  mockHistories({ '159501': points(0), '159509': points(18) });
  assert.deepEqual(await analyzeCounterparties('159501', ['159509'], { lowerPct: 1, upperPct: 3 }), []);
});

test('aligns and sorts only intersecting dates, filtering invalid points', async () => {
  mockHistories({
    '159513': points(0),
    '159509': [...points(alternating(2, 2), 80, 10).reverse(),
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
  mockHistories({ '159513': points(5), '159509': points(alternating(3, 8)) });
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
  mockHistories({ '159513': points(0), '159509': points(alternating(2, 2)) });
  await analyzeCounterparties('159513', ['159509']);
  await analyzeCounterparties('159513', ['159509']);
  await selectBestCounterparty('159509', ['159513']);
  assert.equal(calls.length, 2);
});

test('refetches expired cache using the same code keys', async () => {
  let now = 1000;
  Date.now = () => now;
  mockHistories({ '159513': points(0), '159509': points(alternating(2, 2)) });
  await analyzeCounterparties('159513', ['159509']);
  now += 60 * 60 * 1000;
  await analyzeCounterparties('159513', ['159509']);
  assert.equal(calls.length, 4);
});

test('holding failure or insufficient history returns no candidates', async () => {
  for (const holding of [undefined, points(0, 59)]) {
    clearCounterpartyHistoryCache();
    mockHistories({ '159513': holding, '159509': points(alternating(2, 2)) });
    assert.deepEqual(await analyzeCounterparties('159513', ['159509']), []);
  }
});

test('excludes insufficient aligned history and malformed candidate payloads', async () => {
  mockHistories({ '159513': points(0), '159509': points(alternating(2, 2), 80, 30), '159941': {} });
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
  mockHistories({ '159513': points(0), '159509': points(alternating(2, 2)) });
  const validFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/159509?')) {
      return { ok: true, json: async () => ({ symbol: '159941', interval: '1d', points: points(alternating(2, 2)) }) };
    }
    return validFetch(url, options);
  };
  assert.deepEqual(await analyzeCounterparties('159513', ['159509']), []);
  globalThis.fetch = validFetch;
  assert.equal((await analyzeCounterparties('159513', ['159509'])).length, 1);
  assert.equal(calls.length, 2);
});

test('backtest ignores flat high spreads', () => {
  assert.deepEqual(backtestSpread([18, 18, 18]), { trades: 0, roundTrips: 0, returnPct: 0 });
});

test('backtest realizes alternating spreads and deducts every trade fee', () => {
  assert.deepEqual(backtestSpread([-3, 3, -3, 3], { lowerPct: 0, upperPct: 2 }), {
    trades: 4, roundTrips: 2, returnPct: 11.6
  });
});

test('backtest enters on first point and excludes unrealized gains', () => {
  assert.deepEqual(backtestSpread([-3, 2]), { trades: 1, roundTrips: 0, returnPct: -0.1 });
  assert.deepEqual(backtestSpread([-3, 4]), { trades: 2, roundTrips: 1, returnPct: 6.8 });
});

test('backtest skips non-finite values and uses strict thresholds', () => {
  assert.deepEqual(backtestSpread([NaN, Infinity, -Infinity, null, '0', 1, 0, 3, 4]), {
    trades: 2, roundTrips: 1, returnPct: 3.8
  });
});

test('default analysis thresholds equal explicit 1/3 thresholds', async () => {
  assert.equal(DEFAULT_AUTO_LOWER_PCT, 1);
  assert.equal(DEFAULT_AUTO_UPPER_PCT, 3);
  mockHistories({ '159513': points(0), '159509': points(alternating(2, 2)) });
  assert.deepEqual(
    await analyzeCounterparties('159513', ['159509']),
    await analyzeCounterparties('159513', ['159509'], { lowerPct: 1, upperPct: 3 })
  );
});

test('normalizes spread when holding is the high side', async () => {
  mockHistories({ '159513': points(0), '159509': points(alternating(2, -2)) });
  const [result] = await analyzeCounterparties('159513', ['159509']);
  assert.equal(result.meanSpread, -2);
  assert.equal(result.roundTrips, 39);
  assert.equal(result.trades, 79);
  assert.equal(result.returnPct, 156 - 7.9);
});

test('accepts a completed round trip with fewer than 20 mean crossings', async () => {
  mockHistories({ '159513': points(0), '159509': points((i) => i < 40 ? 0 : 4) });
  const [result] = await analyzeCounterparties('159513', ['159509']);
  assert.equal(result.crossingCount, 1);
  assert.equal(result.roundTrips, 1);
  assert.equal(result.returnPct, 3.8);
});

test('selection forwards custom thresholds and retains backtest stats', async () => {
  mockHistories({ '159513': points(0), '159509': points((i) => i % 2 ? 1 : 0) });
  const selection = await selectBestCounterparty('159513', ['159509'], { lowerPct: 0.1, upperPct: 0.9 });
  assert.equal(selection.code, '159509');
  assert.equal(selection.stats.trades, 80);
  assert.equal(selection.stats.roundTrips, 40);
  assert.equal(selection.stats.returnPct, 32);
  assert.equal(await selectBestCounterparty('159513', ['159509']), null);
});
