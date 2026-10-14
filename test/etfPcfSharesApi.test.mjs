import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';
import { sharesKey, SOURCE } from '../workers/ocr-proxy/src/etfPcfSharesProjection.js';
import { handleEtfPcfShares } from '../workers/ocr-proxy/src/etfPcfSharesRoute.js';
import { buildEtfPcfCacheKey, parseEtfPcf } from '../workers/ocr-proxy/src/etfPcfLimit.js';
const now = new Date('2026-10-14T00:00:00.000Z');
test('read-only API all branches: complete/partial/zero/missing/corrupt/invalid/method/unavailable', async () => {
  const original = globalThis.fetch;
  let fetches = 0,
    writes = 0,
    lists = 0,
    r2 = 0,
    gets = [];
  globalThis.fetch = () => {
    fetches++;
    throw Error('forbidden');
  };
  const data = syntheticProjection();
  const pointer = {
    schemaVersion: 1,
    source: SOURCE,
    date: data.date,
    fetchedAt: data.fetchedAt,
    expiresAt: data.expiresAt,
    key: sharesKey(data.date)
  };
  const store = new Map([
    [pointer.key, JSON.stringify(data)],
    ['etf-pcf-shares:latest', JSON.stringify(pointer)]
  ]);
  const env = {
    FUND_LIMIT_KV: {
      get: async (key) => {
        gets.push(key);
        return store.get(key) ?? null;
      },
      put: () => {
        writes++;
      },
      list: () => {
        lists++;
      }
    },
    R2: {
      get: () => {
        r2++;
      }
    }
  };
  const call = async (query = '', status = 200, method = 'GET', binding = env) => {
    gets = [];
    const response = await handleEtfPcfShares(
      new Request(`https://test/api/etf-pcf-shares${query}`, { method }),
      binding,
      null,
      new URLSearchParams(query.slice(1)),
      now
    );
    assert.equal(response.status, status, query);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual([fetches, writes, lists, r2], [0, 0, 0, 0]);
    return response;
  };
  try {
    assert.deepEqual(await (await call()).json(), { ...data, pcfSnapshot: null });
    assert.equal(gets.length, 10);
    assert.deepEqual(await (await call('?date=latest')).json(), { ...data, pcfSnapshot: null });
    await call('?date=2026-10-12');
    assert.equal(gets.length, 9);
    store.set(pointer.key, JSON.stringify(syntheticProjection({ partial: true })));
    assert.equal((await (await call()).json()).status, 'partial');
    for (const q of [
      '?date=',
      '?date=2026-02-30',
      '?date=2026-10-15',
      '?date=1999-01-01',
      '?date=latest&date=latest',
      '?date=x:latest'
    ])
      await call(q, 400);
    for (const q of ['?refresh=1', '?force=1', '?forceRefresh=1', '?code=159501', '?foo=1'])
      assert.equal((await (await call(q, 400)).json()).reason, 'unsupported_query_param');
    await call('', 405, 'POST');
    await call('', 204, 'OPTIONS');
    await call('', 503, 'GET', {});
    await call('', 503, 'GET', {
      FUND_LIMIT_KV: {
        get: () => {
          throw Error('read');
        }
      }
    });
    for (const value of [
      null,
      '{bad',
      JSON.stringify({ ...data, source: 'bad' }),
      JSON.stringify({ ...data, expiresAt: '2026-10-13T00:00:00.000Z' })
    ]) {
      if (value === null) store.delete(pointer.key);
      else store.set(pointer.key, value);
      await call('', 404);
    }
    store.set(pointer.key, JSON.stringify(data));
    store.set('etf-pcf-shares:latest', JSON.stringify({ ...pointer, fetchedAt: '2026-10-13T02:00:00.000Z' }));
    await call('', 404);
    store.set('etf-pcf-shares:latest', '{bad');
    await call('', 404);
    await call('?date=2026-10-11', 404);
  } finally {
    globalThis.fetch = original;
  }
});

test('PCF snapshot metadata uses validated cached dates and leaves share measurements unchanged', async () => {
  const at = new Date('2026-10-14T07:03:00.000Z');
  const data = syntheticProjection();
  const pointer = {
    schemaVersion: 1,
    source: SOURCE,
    date: data.date,
    fetchedAt: data.fetchedAt,
    expiresAt: data.expiresAt,
    key: sharesKey(data.date)
  };
  const text = new TextDecoder('gbk').decode(
    readFileSync(new URL('./fixtures/etf-pcf/ETF15994120261013.gbk.txt', import.meta.url))
  );
  const makePcf = (date) => ({
    ...parseEtfPcf(text.replaceAll('2026-10-12', '2026-10-09').replaceAll('2026-10-13', date), {
      code: '159941',
      date
    }),
    fetchedAt: `${date}T01:00:00.000Z`,
    expiresAt: `${date}T02:00:00.000Z`
  });
  const current = { ...makePcf('2026-10-14'), expiresAt: '2026-10-15T01:00:00.000Z' };
  const currentKey = buildEtfPcfCacheKey('159941', '2026-10-14');
  const values = new Map([
    [pointer.key, JSON.stringify(data)],
    ['etf-pcf-shares:latest', JSON.stringify(pointer)],
    [currentKey, JSON.stringify(current)],
    [buildEtfPcfCacheKey('159941', data.date), JSON.stringify(makePcf(data.date))]
  ]);
  let fault = false;
  const env = {
    FUND_LIMIT_KV: {
      get: async (key) => {
        if (fault && key === currentKey) throw Error('pcf read unavailable');
        return values.get(key) ?? null;
      }
    }
  };
  const read = async (query = '') => {
    const response = await handleEtfPcfShares(
      new Request('https://test/api/etf-pcf-shares' + query),
      env,
      null,
      new URLSearchParams(query.slice(1)),
      at
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    const { pcfSnapshot, ...measurements } = result;
    assert.deepEqual(measurements, data);
    return pcfSnapshot;
  };
  assert.deepEqual(await read(), { source: 'szse_pcf', date: '2026-10-14', codes: ['159941'] });
  assert.deepEqual(await read('?date=' + data.date), {
    source: 'szse_pcf',
    date: data.date,
    codes: ['159941']
  });
  for (const invalid of [
    { source: 'bad' },
    { date: '2026-10-13' },
    { code: '159632' },
    { expiresAt: '2026-10-14T02:00:00.000Z' }
  ]) {
    values.set(currentKey, JSON.stringify({ ...current, ...invalid }));
    assert.equal(await read(), null);
  }
  values.set(currentKey, JSON.stringify(current));
  fault = true;
  assert.equal(await read(), null);
});
test('Worker dispatch uses the read-only shares route including OPTIONS no-store/Allow', async () => {
  const { default: worker } = await import('../workers/ocr-proxy/src/index.js');
  const data = syntheticProjection({ fetchedAt: new Date(Date.now() - 1000).toISOString() });
  const pointer = {
    schemaVersion: 1,
    source: SOURCE,
    date: data.date,
    fetchedAt: data.fetchedAt,
    expiresAt: data.expiresAt,
    key: sharesKey(data.date)
  };
  const env = {
    FUND_LIMIT_KV: { get: async (key) => JSON.stringify(key.endsWith('latest') ? pointer : data) }
  };
  for (const method of ['GET', 'OPTIONS', 'POST']) {
    const response = await worker.fetch(new Request('https://test/api/etf-pcf-shares', { method }), env, {});
    assert.equal(response.status, method === 'GET' ? 200 : method === 'OPTIONS' ? 204 : 405);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('allow'), 'GET, OPTIONS');
  }
});
