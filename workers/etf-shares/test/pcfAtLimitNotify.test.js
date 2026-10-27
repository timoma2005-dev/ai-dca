import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendPcfAtLimitNotifications } from '../src/pcfSignalNotify.js';
import { runEtfPcfDailyRefresh } from '../src/index.js';

const date = '2026-10-19';
const key = 'etf-pcf-atlimit-notified:20261019';
const event = (overrides = {}) => ({
  code: '159632', date, signal_type: 'net_creation_near_total_limit', basis: 'total',
  netCreation: 10000000, totalLimit: { kind: 'limited', shares: 10000000 }, ratio: 1,
  ...overrides
});
const id = (e) => `${e.date}:${e.code}:${e.signal_type}:${e.basis}`;
class KV {
  store = new Map();
  gets = [];
  puts = [];
  async get(key) { this.gets.push(key); return this.store.get(key) ?? null; }
  async put(key, value) { this.puts.push({ key, value }); this.store.set(key, value); }
}
function mockFetch(t, handler = () => Response.json({ ok: true })) {
  return t.mock.method(globalThis, 'fetch', handler);
}

test('filters all events except near-total-limit signals with total basis without touching KV or fetch', async (t) => {
  const kv = new KV();
  const fetch = mockFetch(t);
  const events = [null, {}, event({ signal_type: 'limit_relaxation' }), event({ basis: 'net' })];
  for (const input of [undefined, [], events]) {
    assert.deepEqual(await sendPcfAtLimitNotifications({ FUND_LIMIT_KV: kv }, input), {
      ok: true, sent: 0, skipped: 0, total: 0, results: []
    });
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(kv.gets, []);
  assert.deepEqual(kv.puts, []);
});

test('first send uses the internal endpoint/token/payload and the second call skips the persisted id', async (t) => {
  const kv = new KV();
  const fetch = mockFetch(t, () => {
    assert.equal(kv.puts.length, 0, 'must wait for a successful POST before persisting');
    return Response.json({ ok: true });
  });
  const env = { FUND_LIMIT_KV: kv, INTERNAL_NOTIFY_TOKEN: 'test-internal-token' };
  const first = await sendPcfAtLimitNotifications(env, [event()]);
  assert.equal(first.sent, 1);
  assert.equal(first.skipped, 0);
  assert.equal(first.total, 1);
  assert.equal(first.results[0].dedupe, 'stored');
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://api.freebacktrack.tech/api/notify/internal/pcf-at-limit');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-token' });
  assert.deepEqual(JSON.parse(init.body), { code: '159632', date, netCreation: 10000000, totalLimitShares: 10000000, ratio: 1 });
  assert.deepEqual(kv.puts, [{ key, value: JSON.stringify([id(event())]) }]);
  const second = await sendPcfAtLimitNotifications(env, [event({ ratio: 0.95 })]);
  assert.deepEqual(second, {
    ok: true, sent: 0, skipped: 1, total: 1,
    results: [{ code: '159632', date, ok: true, skipped: true, dedupe: 'hit' }]
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(kv.puts.length, 1);
});

test('groups by event date, preserves other ids, dedupes within a batch and writes each day once', async (t) => {
  const kv = new KV();
  kv.store.set(key, JSON.stringify([id(event({ code: '159513' }))]));
  const fetch = mockFetch(t);
  const next = event({ date: '2026-10-20' });
  const result = await sendPcfAtLimitNotifications({ FUND_LIMIT_KV: kv }, [
    event(), event(), event({ code: '159659' }), event({ code: '159513' }), next
  ]);
  assert.equal(result.sent, 3);
  assert.equal(result.skipped, 2);
  assert.equal(result.total, 5);
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, undefined);
  assert.deepEqual(kv.gets, [key, 'etf-pcf-atlimit-notified:20261020']);
  assert.deepEqual(JSON.parse(kv.store.get(key)), [id(event({ code: '159513' })), id(event()), id(event({ code: '159659' }))]);
  assert.deepEqual(JSON.parse(kv.store.get('etf-pcf-atlimit-notified:20261020')), [id(next)]);
  assert.equal(kv.puts.length, 2);
});

for (const [name, response] of [
  ['HTTP failure', () => Response.json({ ok: true }, { status: 503 })],
  ['application failure', () => Response.json({ ok: false })],
  ['missing ok', () => Response.json({})],
  ['null JSON', () => Response.json(null)],
  ['malformed JSON', () => new Response('broken')],
  ['network failure', () => { throw Error('network down'); }]
]) {
  test(`${name} never records an id and remains retryable`, async (t) => {
    const kv = new KV();
    const fetch = mockFetch(t, response);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await sendPcfAtLimitNotifications({ FUND_LIMIT_KV: kv }, [event()]);
      assert.equal(result.sent, 0);
      assert.equal(result.skipped, 0);
      assert.equal(result.results[0].ok, false);
    }
    assert.equal(fetch.mock.callCount(), 2);
    assert.deepEqual(kv.puts, []);
  });
}

test('a failed POST does not prevent later events and only successful ids are persisted', async (t) => {
  const kv = new KV();
  mockFetch(t, (_url, init) => Response.json({ ok: JSON.parse(init.body).code === '159659' }));
  const result = await sendPcfAtLimitNotifications({ FUND_LIMIT_KV: kv }, [event(), event({ code: '159659' })]);
  assert.equal(result.sent, 1);
  assert.equal(result.results[0].dedupe, 'miss');
  assert.equal(result.results[1].dedupe, 'stored');
  assert.deepEqual(JSON.parse(kv.store.get(key)), [id(event({ code: '159659' }))]);
});

for (const failure of ['read_failed', 'write_failed', 'unavailable', 'invalid_cache']) {
  test(`KV ${failure} degrades to sending and reports dedupe status`, async (t) => {
    const kv = new KV();
    if (failure === 'read_failed') kv.get = async () => { throw Error('read down'); };
    if (failure === 'write_failed') kv.put = async () => { throw Error('write down'); };
    if (failure === 'invalid_cache') kv.store.set(key, JSON.stringify([id(event({ date: '2026-10-20' }))]));
    const fetch = mockFetch(t);
    const result = await sendPcfAtLimitNotifications(failure === 'unavailable' ? {} : { FUND_LIMIT_KV: kv }, [event()]);
    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
    assert.equal(result.results[0].dedupe, failure);
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(kv.puts, []);
  });
}

test('malformed event identities cannot issue requests or write dedupe keys', async (t) => {
  const kv = new KV();
  const fetch = mockFetch(t);
  const result = await sendPcfAtLimitNotifications({ FUND_LIMIT_KV: kv }, [
    event({ date: '2026-02-30' }), event({ date: '../20261019' }), event({ date: null }),
    event({ code: 159632 }), event({ code: '159632:net' })
  ]);
  assert.equal(result.sent, 0);
  assert.ok(result.results.every(r => r.dedupe === 'invalid_event'));
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(kv.gets, []);
  assert.deepEqual(kv.puts, []);
});

const refresh = (env, events) => runEtfPcfDailyRefresh({
  env, scheduledTime: Date.parse('2026-10-20T01:00:00Z'),
  sseRefresh: async () => ({ ok: true }), szseRefresh: async () => ({ ok: true }),
  eventsRefresh: async () => events
});

test('daily refresh no longer pushes limit relaxation, only at-limit', async (t) => {
  const fetch = mockFetch(t);
  const relaxation = { code: '159513', date, signal_type: 'limit_relaxation', basis: 'net', tier: '5x', prev: {}, cur: {}, ratio: 5 };
  const result = await refresh({ FUND_LIMIT_KV: new KV() }, { ok: true, detectedEvents: [relaxation, event()] });
  assert.equal(result.pcfSignal, null);
  assert.equal(result.pcfAtLimit.sent, 1);
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments[0].split('/').at(-1)), ['pcf-at-limit']);
});

test('daily refresh does not call at-limit delivery for failed stages or other signals', async (t) => {
  const fetch = mockFetch(t);
  for (const events of [null, { ok: false, detectedEvents: [event()] }, { ok: true, detectedEvents: [] }, { ok: true, detectedEvents: [event({ basis: 'net' })] }]) {
    const result = await refresh({}, events);
    assert.equal(result.pcfAtLimit, null);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await runEtfPcfDailyRefresh()).pcfAtLimit, null);
});
