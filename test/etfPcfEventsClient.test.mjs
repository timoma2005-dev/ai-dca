import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPcfEventsClient } from '../src/app/etfPcfEventsClient.js';

const date = '2026-10-19';
const atLimit = { code: '159632', date, signal_type: 'net_creation_near_total_limit', basis: 'total' };
const payload = (overrides = {}) => ({ source: 'szse_pcf_events', date, events: [atLimit], ...overrides });

test('event codes come only from near-total-limit events; dates without events remain empty', async () => {
  for (const [events, expected] of [
    [[atLimit, atLimit, { ...atLimit, code: '159501', signal_type: 'limit_relaxation' }, null, { ...atLimit, code: 159513 }], ['159632']],
    [[], []]
  ]) {
    const client = createPcfEventsClient({ fetchImpl: async () => Response.json(payload({ events })) });
    assert.deepEqual([...(await client.subscribe(date).promise)], expected);
  }
});

test('date requests share inflight work and five-minute memory cache; expired entries fetch again', async () => {
  let clock = 1000;
  const calls = [];
  const client = createPcfEventsClient({ now: () => clock, fetchImpl: (url, options) =>
    new Promise(resolve => calls.push({ url, options, resolve })) });
  const first = client.subscribe(date), second = client.subscribe(date);
  assert.equal(first.promise, second.promise);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/etf-pcf-events?date=${date}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'manual');
  first.release();
  calls[0].resolve(Response.json(payload()));
  assert.deepEqual([...(await second.promise)], ['159632']);
  second.release();
  assert.deepEqual([...(await client.subscribe(date).promise)], ['159632']);
  assert.equal(calls.length, 1);
  clock += 300000;
  const expired = client.subscribe(date);
  assert.equal(calls.length, 2);
  calls[1].resolve(Response.json(payload({ events: [] })));
  assert.deepEqual([...(await expired.promise)], []);
});

test('source/date/shape/HTTP/JSON failures silently return no markers and never populate the date cache', async () => {
  for (const response of [
    Response.json(payload({ source: 'wrong_source' })), Response.json(payload({ date: '2026-10-20' })),
    Response.json(payload({ events: {} })), Response.json({ events: [atLimit] }),
    Response.json({ reason: 'cache_miss' }, { status: 404 }), Response.json({}, { status: 503 }),
    new Response('broken JSON'), new Response('', { status: 302 })
  ]) {
    let calls = 0;
    const client = createPcfEventsClient({ fetchImpl: async () => { calls++; return response.clone(); } });
    assert.deepEqual([...(await client.subscribe(date).promise)], []);
    assert.deepEqual([...(await client.subscribe(date).promise)], []);
    assert.equal(calls, 2);
  }
  const offline = createPcfEventsClient({ fetchImpl: async () => { throw Error('offline'); } });
  assert.deepEqual([...(await offline.subscribe(date).promise)], []);
});

test('missing dates never fetch, and a response for another date cannot pollute either cache key', async () => {
  const calls = [];
  const client = createPcfEventsClient({ fetchImpl: (url, options) =>
    new Promise(resolve => calls.push({ url, options, resolve })) });
  for (const missing of [undefined, null, '', '20261019', '../events'])
    assert.deepEqual([...(await client.subscribe(missing).promise)], []);
  assert.equal(calls.length, 0);
  const first = client.subscribe(date);
  calls[0].resolve(Response.json(payload({ date: '2026-10-20' })));
  assert.deepEqual([...(await first.promise)], []);
  const other = client.subscribe('2026-10-20');
  assert.equal(calls.length, 2);
  calls[1].resolve(Response.json(payload({ date: '2026-10-20' })));
  assert.deepEqual([...(await other.promise)], ['159632']);
  const retry = client.subscribe(date);
  assert.equal(calls.length, 3);
  calls[2].resolve(Response.json(payload()));
  await retry.promise;
});

test('effect remount reuses inflight work, final release aborts and late responses are not cached', async () => {
  const calls = [];
  const client = createPcfEventsClient({ fetchImpl: (url, options) =>
    new Promise(resolve => calls.push({ url, options, resolve })) });
  const first = client.subscribe(date);
  first.release();
  const remount = client.subscribe(date);
  assert.equal(first.promise, remount.promise);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls[0].options.signal.aborted, false);
  remount.release(); remount.release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls[0].options.signal.aborted, true);
  const next = client.subscribe(date);
  assert.equal(calls.length, 2);
  calls[0].resolve(Response.json(payload()));
  assert.deepEqual([...(await first.promise)], []);
  calls[1].resolve(Response.json(payload({ events: [] })));
  assert.deepEqual([...(await next.promise)], []);
  assert.deepEqual([...(await client.subscribe(date).promise)], []);
  assert.equal(calls.length, 2);
});
