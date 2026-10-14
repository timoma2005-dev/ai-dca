import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharesClient, limitLabel } from '../src/app/etfPcfSharesClient.js';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';
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
