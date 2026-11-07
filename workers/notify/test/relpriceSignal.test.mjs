/* global Request */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRelpriceSignal, validateRelpriceSignal } from '../src/relpriceSignalRoute.js';

const owner = 'usr_ad2be81697b5eec7ca3b2204efb7270c';
const now = () => new Date('2026-11-09T06:41:10Z');
const signal = () => ({ owner_user_id: owner, date: '2026-11-09', signal_ts: '2026-11-09T14:40:00+08:00',
  event_id: 'relprice:B_REL:2026-11-09', input_sha256: 'a'.repeat(64), holding: '159501', target: '513110',
  decision: 'rotate', gap_bp: 60, generated_at: now().toISOString(), execution_reference: { time: '1441', sell_close: 2.173, buy_close: 2.54 } });
const request = (body, token = 'test-internal-only') => new Request('https://notify.test/api/notify/internal/relprice-signal', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const environment = () => ({ INTERNAL_SYNC_TOKEN: 'test-internal-only', SYNC_DB: { prepare(sql) {
  assert.match(sql, /notify_delivery_attempts/);
  return { bind(userId, eventId) { assert.equal(userId, owner); return { async first() { return { owner_user_id: userId, event_id: eventId, channel: 'email', status: 'delivered' }; } }; } };
} } });

test('only a fresh live rotation at the exact threshold passes', () => {
  assert.equal(validateRelpriceSignal(signal(), now()), '');
  for (const patch of [{ gap_bp: 59.99999 }, { decision: 'hold' }, { target: '159501' }, { target: '000001' },
    { owner_user_id: 'someone-else' }, { date: '2026-10-15' }, { generated_at: '2026-11-09T06:40:00Z' },
    { signal_ts: '2026-11-09T14:41:00+08:00' }, { input_sha256: 'invalid' }, { execution_reference: { time: '1440' } }]) {
    assert.notEqual(validateRelpriceSignal({ ...signal(), ...patch }, now()), '');
  }
  assert.notEqual(validateRelpriceSignal(signal(), new Date('2026-11-07T06:41:10Z')), '');
});

test('missing/wrong internal auth and owner never call delivery', async () => {
  const deliver = () => assert.fail('must not deliver');
  assert.equal((await handleRelpriceSignal(request(signal(), 'wrong'), environment(), { deliver, now })).status, 401);
  assert.equal((await handleRelpriceSignal(request({ ...signal(), owner_user_id: 'other' }), environment(), { deliver, now })).status, 403);
  assert.equal((await handleRelpriceSignal(request({ ...signal(), decision: 'hold' }), environment(), { deliver, now })).status, 400);
});

test('dry-run resolves only binding metadata without events or sending', async () => {
  const env = { ...environment(), SYNC_DB: { prepare(sql) {
    assert.match(sql, /client-channel/); assert.doesNotMatch(sql, /token_hash|INSERT|UPDATE/);
    return { bind(userId, id) { assert.equal(userId, owner); assert.equal(id, `account:${owner}::email`); return { async first() { return { verified: 1, enabled: 1 }; } }; } };
  } } };
  const response = await handleRelpriceSignal(request({ owner_user_id: owner, dry_run: true }), env, { deliver: () => assert.fail('no send'), now });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
});

test('reuses account delivery with only email and a relprice-specific event', async () => {
  let calls = 0;
  const deliver = async (env, account, notification, channels, reason) => {
    calls++;
    assert.equal(account.userId, owner);
    assert.deepEqual(channels, ['email']);
    assert.equal(reason, 'relprice-signal');
    assert.equal(notification.eventType, 'relprice-signal');
    assert.equal(notification.eventId, signal().event_id);
    assert.match(notification.body, /仅信号提醒，不自动交易/);
    return { events: [{ channels: [{ channel: 'email', status: 'delivered', detail: 'private provider detail' }] }] };
  };
  const response = await handleRelpriceSignal(request(signal()), environment(), { deliver, now });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'delivered');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(body), /provider detail/);
});

test('queued or failed channels cannot be reported as successful delivery', async () => {
  for (const status of ['queued', 'skipped', 'retryable_failed']) {
    const response = await handleRelpriceSignal(request(signal()), environment(), { now, deliver: async () => ({ events: [{ channels: [{ channel: 'email', status }] }] }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  }
});

test('delivery result without a D1 successful email attempt is not accepted', async () => {
  const env = { ...environment(), SYNC_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
  const response = await handleRelpriceSignal(request(signal()), env, { now, deliver: async () => ({ events: [{ channels: [{ channel: 'email', status: 'delivered' }] }] }) });
  assert.equal(response.status, 503);
});

test('read-only verification queries owner and event, never delivers', async () => {
  const response = await handleRelpriceSignal(request({ owner_user_id: owner, dry_run: true, verify_event_id: signal().event_id }), environment(), { now, deliver: () => assert.fail('read-only') });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).delivery_attempt.owner_user_id, owner);
});
