import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256Hex, validateEvent, receiveSync } from '../internalSync.js';
import { handleInternalSyncRules } from '../../notify/src/internalSyncRules.js';
import { handleInternalAccountSync } from '../../account/src/internalSync.js';
import { handleInternalSyncBackup } from '../../sync/src/internalSyncBackup.js';

test('canonical JSON recursively sorts objects and preserves array order', async () => {
  const a = { z: [{ b: 2, a: 1 }], a: null };
  const b = { a: null, z: [{ a: 1, b: 2 }] };
  assert.equal(canonicalJson(a), '{"a":null,"z":[{"a":1,"b":2}]}');
  assert.equal(await sha256Hex(canonicalJson(a)), await sha256Hex(canonicalJson(b)));
  assert.notEqual(await sha256Hex('[1,2]'), await sha256Hex('[2,1]'));
});
test('validation rejects malformed envelopes', () => {
  for (const body of [null, {}, { eventId: 'x', eventType: 'wrong', payload: {} }, { eventId: 'x', eventType: 'ok', payload: [] }, { eventId: 'x', eventType: 'ok', payload: {} }]) {
    assert.throws(() => validateEvent(body, ['ok']), { status: 400 });
  }
  assert.equal(validateEvent({ eventId: 'x', eventType: 'ok', payload: { user_id: 'u' } }, ['ok']).eventId, 'x');
});
for (const handler of [handleInternalSyncRules, handleInternalAccountSync, handleInternalSyncBackup]) {
  test(`${handler.name} rejects unconfigured and incorrect tokens before storage`, async () => {
    const request = token => new Request('https://example.test', { method: 'POST', headers: { authorization: token } });
    assert.equal((await handler(request('Bearer secret'), {})).status, 503);
    assert.equal((await handler(request('Bearer wrong'), { INTERNAL_SYNC_TOKEN: 'secret' })).status, 401);
    assert.equal((await handler(request('bearer secret'), { INTERNAL_SYNC_TOKEN: 'secret' })).status, 401);
  });
}
test('receipts deduplicate, reject conflicts, and retry failed batches', async () => {
  const events = new Map();
  let applied = 0;
  let fail = false;
  const db = { prepare(sql) { let args; return { bind(...values) { args = values; return this; }, async run() {}, async first() { return events.get(args[0]); }, sql, get args() { return args; } }; }, async batch(statements) {
    if (fail) throw new Error('failed');
    const receipt = statements[0];
    events.set(receipt.args[0], { payload_hash: receipt.args[1] });
    applied++;
  } };
  const send = (eventId, payload) => receiveSync(new Request('https://example.test', { method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify({ eventId, eventType: 'ok', payload }) }), { INTERNAL_SYNC_TOKEN: 'secret', DB: db }, 'DB', ['ok'], async () => ({ statements: [] }));
  assert.deepEqual(await (await send('1', { user_id: 'u' })).json(), { ok: true });
  assert.deepEqual(await (await send('1', { user_id: 'u' })).json(), { ok: true, deduplicated: true });
  assert.equal((await send('1', { user_id: 'v' })).status, 409);
  assert.equal(applied, 1);
  fail = true;
  assert.equal((await send('2', { user_id: 'u' })).status, 500);
  assert.equal(events.has('2'), false);
  fail = false;
  assert.equal((await send('2', { user_id: 'u' })).status, 200);
});
