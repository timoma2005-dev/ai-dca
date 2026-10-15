// Email enabled flag respected in cycleDelivery + testDelivery.
// Regression test: /api/notify/email/disable must stop emails from going out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { deliverCycleNotification } from '../src/notify/cycleDelivery.js';

function memoryDb(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

function seedEmailChannel(db, userId, clientId, email) {
  db.prepare(`INSERT INTO notify_user_records (owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
    VALUES (?, 'client-channel', ?, ?, 1, ?, ?)`)
    .run(userId, `${clientId}::email`, JSON.stringify({ email }), new Date().toISOString(), new Date().toISOString());
}

const account = { userId: 'u1', clientId: 'c1' };
const notification = { eventId: 'e1', title: 't', body: 'b' };

test('deliverCycleNotification skips email when enabled=false', async (t) => {
  const db = memoryDb(t);
  seedEmailChannel(db, 'u1', 'c1', { address: 'a@b.c', verified: true, enabled: false });
  // Stub fetch so a real send would fail loudly if attempted.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch should not be called'); };
  t.after(() => { globalThis.fetch = origFetch; });
  const result = await deliverCycleNotification(db, account, notification, { targetChannels: ['email'] });
  const email = result.results.find((r) => r.channel === 'email');
  assert.equal(email.status, 'skipped');
  assert.match(email.detail, /已关闭/);
});

test('deliverCycleNotification still sends email when enabled=true', async (t) => {
  const db = memoryDb(t);
  seedEmailChannel(db, 'u1', 'c1', { address: 'a@b.c', verified: true, enabled: true });
  process.env.RESEND_TOKEN = 'test-token';
  t.after(() => { delete process.env.RESEND_TOKEN; });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
  t.after(() => { globalThis.fetch = origFetch; });
  const result = await deliverCycleNotification(db, account, notification, { targetChannels: ['email'] });
  const email = result.results.find((r) => r.channel === 'email');
  assert.equal(email.status, 'delivered');
});
