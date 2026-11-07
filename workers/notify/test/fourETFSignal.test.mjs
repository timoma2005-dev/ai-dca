import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { handleFourETFSignal, validateFourETFSignal } from '../src/fourETFSignalRoute.js';

const owner = 'usr_ad2be81697b5eec7ca3b2204efb7270c';
const now = () => new Date('2026-11-09T02:01:12Z');
const signal = () => ({
  owner_user_id: owner, date: '2026-11-09', decision: 'rotate', holding: '159696', target: '159941',
  signal_ts: '2026-11-09T10:00:00+08:00', event_id: 'fourETF:2026-11-09:1000', input_sha256: 'a'.repeat(64),
  gap_pp: 1, deviations_pp: { '513100': 2, '159696': 1, '159501': 2, '159941': 0 },
  eligible: { '513100': true, '159696': true, '159501': true, '159941': true },
  normal_pp: { '513100': 7.7054, '159696': 6.7413, '159501': 7.2303, '159941': 6.7483 },
  normal_effective: '2026-11-07', nav_date: '2026-11-06', nav_ready_at: '2026-11-09T09:20:00+08:00',
  generated_at: now().toISOString(), execution_reference: { time: '1001', sell_close: 1.984, buy_close: 1.582, sell_volume: 100, buy_volume: 100 }
});
const request = (payload, token = 'test-internal-only') => new Request('https://notify.test/api/notify/internal/four-etf-signal', {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(payload)
});
const attempt = (status = 'delivered') => ({ owner_user_id: owner, event_id: signal().event_id, channel: 'email', status });

function environment(prior = null) {
  const state = { attempt: prior, queries: [] };
  return { state, INTERNAL_SYNC_TOKEN: 'test-internal-only', SYNC_DB: { prepare(sql) {
    state.queries.push(sql);
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|token_hash/);
    return { bind(userId, id) {
      assert.equal(userId, owner);
      if (sql.includes('client-channel')) assert.equal(id, `account:${owner}::email`);
      else assert.match(id, /^fourETF:/);
      return { async first() { return sql.includes('client-channel') ? { verified: 1, enabled: 1 } : state.attempt; } };
    } };
  } } };
}

test('fresh next-minute confirmed rotation passes; exact 0.5pp does not', () => {
  assert.equal(validateFourETFSignal(signal(), now()), '');
  const exact = signal(); exact.gap_pp = 0.5; exact.deviations_pp['159696'] = 0.5;
  assert.match(validateFourETFSignal(exact, now()), /threshold/);
  exact.gap_pp = 0.50001; exact.deviations_pp['159696'] = 0.50001;
  assert.equal(validateFourETFSignal(exact, now()), '');
});

test('rejects held/unknown codes, gap mismatch, missing NAV, late NAV, stale data, wrong quarter and eligibility', () => {
  for (const patch of [
    { holding: '159941' }, { target: '513110' }, { decision: 'hold' }, { owner_user_id: 'other' },
    { gap_pp: 0.9 }, { nav_date: '2026-11-05' }, { nav_date: '' }, { nav_ready_at: '2026-11-09T09:30:00+08:00' },
    { nav_ready_at: '2026-11-08T09:00:00+08:00' }, { generated_at: '2026-11-09T02:00:00Z' },
    { normal_effective: '2026-10-01' }, { normal_pp: {} }, { date: '2026-11-06' }, { input_sha256: 'bad' },
    { eligible: { ...signal().eligible, '159941': false } }, { eligible: {} },
    { execution_reference: { ...signal().execution_reference, sell_volume: 0 } },
    { execution_reference: { ...signal().execution_reference, buy_volume: 0 } },
    { execution_reference: { ...signal().execution_reference, time: '1002' } },
    { event_id: 'relprice:B_REL:2026-11-09' }
  ]) assert.notEqual(validateFourETFSignal({ ...signal(), ...patch }, now()), '', JSON.stringify(patch));
});

test('15:00 cannot trigger a same-day confirmed push and weekends/holidays/unknown years close', () => {
  const close = { ...signal(), signal_ts: '2026-11-09T15:00:00+08:00', event_id: 'fourETF:2026-11-09:1500',
    generated_at: '2026-11-09T07:00:12Z', execution_reference: { ...signal().execution_reference, time: '1500' } };
  assert.notEqual(validateFourETFSignal(close, new Date('2026-11-09T07:00:12Z')), '');
  for (const date of ['2026-11-08', '2026-10-01', '2027-01-04']) {
    assert.notEqual(validateFourETFSignal({ ...signal(), date }, new Date(`${date}T02:01:12Z`)), '');
  }
});

test('lunch confirmation uses first right-labelled completed afternoon minute', () => {
  const body = { ...signal(), signal_ts: '2026-11-09T11:30:00+08:00', event_id: 'fourETF:2026-11-09:1130',
    generated_at: '2026-11-09T05:01:12Z', execution_reference: { ...signal().execution_reference, time: '1301' } };
  assert.equal(validateFourETFSignal(body, new Date('2026-11-09T05:01:12Z')), '');
});

test('auth, owner, payload size and invalid signal never deliver', async () => {
  const env = environment(); const deliver = () => assert.fail('must not deliver');
  assert.equal((await handleFourETFSignal(request(signal(), 'wrong'), env, { deliver, now })).status, 401);
  assert.equal((await handleFourETFSignal(request({ ...signal(), owner_user_id: 'other' }), env, { deliver, now })).status, 403);
  assert.equal((await handleFourETFSignal(request({ ...signal(), decision: 'hold' }), env, { deliver, now })).status, 400);
  assert.equal((await handleFourETFSignal(request({ ...signal(), junk: 'x'.repeat(17000) }), env, { deliver, now })).status, 400);
  assert.equal((await handleFourETFSignal(new Request('https://notify.test'), env, { deliver, now })).status, 405);
});

test('dry-run binding and event verification are read-only and return no address/provider secrets', async () => {
  const env = environment(); const deliver = () => assert.fail('read-only');
  let response = await handleFourETFSignal(request({ owner_user_id: owner, dry_run: true }), env, { deliver, now });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  response = await handleFourETFSignal(request({ owner_user_id: owner, dry_run: true, verify_event_id: signal().event_id }), env, { deliver, now });
  assert.equal((await response.json()).delivery_attempt, null);
  response = await handleFourETFSignal(request({ owner_user_id: owner, dry_run: true, verify_event_id: 'relprice:B_REL:2026-11-09' }), env, { deliver, now });
  assert.equal(response.status, 400);
  assert.ok(env.state.queries.every(sql => sql.startsWith('SELECT')));
});

test('only existing lovexl email chain is used; success needs D1 delivered confirmation', async () => {
  const env = environment(); let count = 0;
  const deliver = async (e, account, message, channels, reason) => {
    count += 1;
    assert.equal(account.userId, owner); assert.equal(account.username, 'lovexl');
    assert.deepEqual(channels, ['email']); assert.equal(reason, 'four-etf-signal');
    assert.equal(message.eventId, signal().event_id); assert.equal(message.eventType, 'four-etf-signal');
    assert.match(message.body, /下一分钟双方正量 close 已确认/); assert.match(message.body, /不自动交易/);
    e.state.attempt = attempt();
    return { events: [{ channels: [{ channel: 'email', status: 'delivered', detail: 'private provider detail' }] }] };
  };
  let response = await handleFourETFSignal(request(signal()), env, { deliver, now });
  assert.equal(response.status, 200);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private provider detail/);
  response = await handleFourETFSignal(request(signal()), env, { deliver, now });
  assert.equal(response.status, 200); assert.equal((await response.json()).duplicate, true);
  assert.equal(count, 1);
});

test('failed/uncertain previous attempts are never resent by ingress', async () => {
  for (const status of ['queued', 'retryable_failed', 'delivering', 'failed']) {
    const response = await handleFourETFSignal(request(signal()), environment(attempt(status)), { now, deliver: () => assert.fail('no retry') });
    assert.equal(response.status, 409);
  }
});

test('provider claim alone and queued/failed email cannot be reported as delivered', async () => {
  for (const status of ['delivered', 'queued', 'retryable_failed']) {
    const env = environment();
    const response = await handleFourETFSignal(request(signal()), env, { now,
      deliver: async () => ({ events: [{ channels: [{ channel: 'email', status }] }] }) });
    assert.equal(response.status, 503);
  }
});

test('new entry preserves every relprice/notify handler and routes only its own path', async () => {
  const calls = []; const context = vm.createContext({ URL });
  const worker = { fetch: (...args) => { calls.push(['fetch', ...args]); return 'old-fetch'; }, queue() {}, scheduled() {} };
  const entry = new vm.SourceTextModule(await fs.readFile(new URL('../src/fourETFEntry.js', import.meta.url), 'utf8'), { context });
  const old = new vm.SyntheticModule(['default', 'WsHub', 'stripDeviceIdentityFromAccountTestRequest'], function () {
    this.setExport('default', worker); this.setExport('WsHub', 'hub'); this.setExport('stripDeviceIdentityFromAccountTestRequest', 'strip');
  }, { context });
  const route = new vm.SyntheticModule(['handleFourETFSignal'], function () { this.setExport('handleFourETFSignal', () => 'four-etf'); }, { context });
  await entry.link(specifier => specifier === './relpriceEntry.js' ? old : route);
  await entry.evaluate();
  assert.equal(entry.namespace.default.queue, worker.queue);
  assert.equal(entry.namespace.default.scheduled, worker.scheduled);
  assert.equal(entry.namespace.WsHub, 'hub');
  assert.equal(entry.namespace.stripDeviceIdentityFromAccountTestRequest, 'strip');
  for (const path of ['/api/notify/internal/relprice-signal', '/api/notify/status', '/api/wechat/anything']) {
    assert.equal(await entry.namespace.default.fetch({ url: `https://notify.test${path}` }, {}, {}), 'old-fetch');
  }
  assert.equal(await entry.namespace.default.fetch({ url: 'https://notify.test/api/notify/internal/four-etf-signal' }, {}, {}), 'four-etf');
  assert.equal(calls.length, 3);
});
