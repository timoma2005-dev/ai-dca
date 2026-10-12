import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { claimPendingEvents, outboxStats } from '../src/outbox.js';
import { parseAccountPath } from '../src/account/catalog.js';

function memory(t) { const db = openDb(':memory:'); t.after(() => db.close()); return db; }
async function app(t, options) {
  const db = memory(t); const server = createServer(createApp(db, options));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { db, async request(path, method = 'GET', body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() };
  } };
}
function insertLegacyBackup(db, userId) {
  db.prepare("INSERT INTO sync_backups(user_id, payload, version, updated_at) VALUES (?, '{\"version\":3,\"ciphertext\":\"x\",\"crypto\":{\"wrappedDek\":\"y\"}}', 1, '2026-10-01T00:00:00.000Z')").run(userId);
}

test('parseAccountPath routes every v1 kind', () => {
  assert.equal(parseAccountPath('/api/account/v1/health').kind, 'health');
  assert.equal(parseAccountPath('/api/account/v1/manifest').kind, 'manifest');
  assert.equal(parseAccountPath('/api/account/v1/bundle').kind, 'bundle');
  assert.equal(parseAccountPath('/api/account/v1/exports/envelope').kind, 'export-envelope');
  assert.equal(parseAccountPath('/api/account/v1/migrations/legacy').kind, 'migration');
  assert.equal(parseAccountPath('/api/account/v1/migrations/legacy/skip').kind, 'migration-skip');
  const r = parseAccountPath('/api/account/v1/plans/store');
  assert.equal(r.kind, 'resource'); assert.equal(r.descriptor.resource, 'plans/store');
  const ri = parseAccountPath('/api/account/v1/trades/ledger/items/tx-1');
  assert.equal(ri.kind, 'resource-item'); assert.equal(ri.descriptor.resource, 'trades/ledger'); assert.equal(ri.itemId, 'tx-1');
  assert.equal(parseAccountPath('/api/account/v1/migrations/legacy/discard').kind, 'unknown');
  assert.equal(parseAccountPath('/api/account/v1/nope/nothing').kind, 'unknown');
  assert.equal(parseAccountPath('/api/account/v2/health').kind, 'unknown');
  assert.equal(parseAccountPath('/api/account/v1').kind, 'root');
});

test('v1 health needs no auth; unknown v1 paths 404', async (t) => {
  const { request } = await app(t);
  const res = await request('/api/account/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true); assert.equal(res.body.service, 'ai-dca-account'); assert.equal(res.body.encryption, 'none');
  assert.equal((await request('/api/account/v1/nope/nothing')).status, 404);
  assert.equal((await request('/api/account/v1/health', 'POST')).status, 405);
});

test('migration gate blocks resources until settled, skip settles', async (t) => {
  const { request, db } = await app(t);
  insertLegacyBackup(db, 'u');
  const res = await request('/api/account/v1/manifest?user_id=u');
  assert.equal(res.status, 409); assert.equal(res.body.error, 'LEGACY_MIGRATION_REQUIRED');
  assert.equal((await request('/api/account/v1/plans/store?user_id=u')).status, 409);
  assert.equal((await request('/api/account/v1/holdings/ledger/items?user_id=u')).status, 409);
  const status = await request('/api/account/v1/migrations/legacy?user_id=u');
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'pending'); assert.equal(status.body.needsMigration, true);
  assert.equal(status.body.legacy.exists, true); assert.equal(status.body.legacy.cryptoKind, 'password');
  assert.deepEqual(status.body.migratedResources, []);
  const skip = await request('/api/account/v1/migrations/legacy/skip', 'POST', { user_id: 'u' });
  assert.equal(skip.status, 200); assert.equal(skip.body.migration.status, 'skipped');
  const manifest = await request('/api/account/v1/manifest?user_id=u');
  assert.equal(manifest.status, 200); assert.equal(manifest.body.username, 'u');
  assert.equal(manifest.body.migration.status, 'skipped');
});

test('no legacy backup means the gate passes (manifest shows raw pending status)', async (t) => {
  const { request } = await app(t);
  const res = await request('/api/account/v1/manifest?user_id=u');
  assert.equal(res.status, 200);
  // matches the worker: /manifest returns the raw migration row; the frontend
  // normalizes pending+no-legacy to no-legacy client-side
  assert.equal(res.body.migration.status, 'pending');
  assert.equal(res.body.migration.legacy.exists, false);
});

test('resource CRUD: lww PUT/GET, revision conflicts, If-Match, unchanged', async (t) => {
  const { request, db } = await app(t);
  let res = await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: { plans: [], note: 'x' } });
  assert.equal(res.status, 200); assert.equal(res.body.revision, 1); assert.equal(res.body.unchanged, false);
  assert.equal(res.headers.get('etag'), '"1"'); assert.equal(res.headers.get('x-resource-revision'), '1');
  res = await request('/api/account/v1/plans/store?user_id=u');
  assert.equal(res.status, 200); assert.deepEqual(res.body.data, { plans: [], note: 'x' });
  assert.equal(res.body.revision, 1); assert.equal(res.body.merge, 'planStore'); assert.equal(res.body.feature, 'plans');
  res = await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: {}, baseRevision: 0 });
  assert.equal(res.status, 409); assert.equal(res.body.error, 'REVISION_MISMATCH');
  assert.equal(res.body.currentRevision, 1); assert.deepEqual(res.body.data, { plans: [], note: 'x' });
  res = await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: { plans: [], note: 'y' } }, { 'if-match': '"1"' });
  assert.equal(res.status, 200); assert.equal(res.body.revision, 2);
  res = await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: {} }, { 'if-match': '"1"' });
  assert.equal(res.status, 409);
  res = await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: { plans: [], note: 'y' } });
  assert.equal(res.body.unchanged, true); assert.equal(res.body.revision, 2);
  assert.equal(outboxStats(db).pending, 2); // only the two real writes
});

test('resource CRUD: array PATCH, shape mismatch, DELETE tombstone, history', async (t) => {
  const { request } = await app(t);
  let res = await request('/api/account/v1/trades/ledger', 'PUT', { user_id: 'u', data: [{ id: 't1', amount: 1 }] });
  assert.equal(res.body.revision, 1);
  res = await request('/api/account/v1/trades/ledger', 'PATCH', { user_id: 'u', patch: { upsert: [{ id: 't2', amount: 2 }], remove: ['t1'] } });
  assert.equal(res.status, 200); assert.equal(res.body.revision, 2);
  res = await request('/api/account/v1/trades/ledger?user_id=u');
  assert.deepEqual(res.body.data, [{ id: 't2', amount: 2 }]);
  res = await request('/api/account/v1/trades/ledger', 'PUT', { user_id: 'u', data: { not: 'array' } });
  assert.equal(res.status, 400); assert.equal(res.body.error, 'SHAPE_MISMATCH');
  res = await request('/api/account/v1/trades/ledger', 'DELETE', { user_id: 'u' });
  assert.equal(res.status, 200); assert.equal(res.body.deleted, true);
  res = await request('/api/account/v1/trades/ledger?user_id=u');
  assert.equal(res.body.deleted, true); assert.equal(res.body.data, null);
  res = await request('/api/account/v1/trades/ledger?user_id=u&history=1');
  assert.ok(Array.isArray(res.body.history)); assert.ok(res.body.history.length >= 3);
  assert.equal(res.body.history[0].revision, 3);
});

test('per-record item CRUD with independent revisions', async (t) => {
  const { request } = await app(t);
  let res = await request('/api/account/v1/trades/ledger/items/t1', 'PUT', { user_id: 'u', item: { id: 't1', amount: 5 } });
  assert.equal(res.status, 200); assert.equal(res.body.revision, 1); assert.equal(res.body.recordRevision, 1);
  assert.deepEqual(res.body.data, { id: 't1', amount: 5 }); assert.equal(res.body.resourceRevision, 1);
  assert.equal(res.headers.get('etag'), '"1"');
  res = await request('/api/account/v1/trades/ledger/items/t1?user_id=u');
  assert.equal(res.status, 200); assert.deepEqual(res.body.data, { id: 't1', amount: 5 });
  assert.equal(res.body.kind, 'item'); assert.equal(res.body.position, 0);
  res = await request('/api/account/v1/trades/ledger/items/t1', 'PUT', { user_id: 'u', item: { id: 't1' }, baseRevision: 0 });
  assert.equal(res.status, 409); assert.equal(res.body.error, 'REVISION_MISMATCH'); assert.equal(res.body.currentRevision, 1);
  res = await request('/api/account/v1/trades/ledger/items/t1', 'PATCH', { user_id: 'u', item: { id: 't1', amount: 9 } });
  assert.equal(res.status, 200); assert.deepEqual(res.body.data, { id: 't1', amount: 9 });
  res = await request('/api/account/v1/trades/ledger/items/t1', 'DELETE', { user_id: 'u' });
  assert.equal(res.status, 200); assert.equal(res.body.deleted, true);
  assert.equal((await request('/api/account/v1/trades/ledger/items/t1?user_id=u')).status, 404);
  // sibling rows of the aggregate survive the item delete
  await request('/api/account/v1/trades/ledger/items/t2', 'PUT', { user_id: 'u', item: { id: 't2' } });
  res = await request('/api/account/v1/trades/ledger?user_id=u');
  assert.deepEqual(res.body.data, [{ id: 't2' }]);
});

test('holdings ledger rows: write/read/pagination/manifest/delete', async (t) => {
  const { request } = await app(t);
  for (const [id, date] of [['tx1', '2026-10-01'], ['tx2', '2026-10-02'], ['tx3', '2026-10-03']]) {
    const res = await request(`/api/account/v1/holdings/ledger/items/${id}`, 'PUT', { user_id: 'u', data: { id, date, code: '159632', amount: 100 } });
    assert.equal(res.status, 200); assert.equal(res.body.rowRevision, 1);
    assert.equal(res.body.resource, 'holdings/ledger');
    assert.ok(res.body.resourceMeta); assert.equal(res.body.resourceMeta.itemCount, Number(id.slice(2)));
  }
  let res = await request('/api/account/v1/holdings/ledger/items/tx1?user_id=u');
  assert.equal(res.status, 200); assert.equal(res.body.data.code, '159632'); assert.equal(res.body.revision, 1);
  assert.equal(res.headers.get('etag'), '"1"');
  res = await request('/api/account/v1/holdings/ledger/items?user_id=u&limit=2&cursor=0');
  assert.equal(res.status, 200); assert.equal(res.body.rows.length, 2); assert.equal(res.body.nextCursor, '2');
  assert.equal(res.body.resource, 'holdings/ledger');
  assert.equal(res.body.rows[0].data.date, '2026-10-01');
  res = await request('/api/account/v1/holdings/ledger/items?user_id=u&limit=2&cursor=2');
  assert.equal(res.body.rows.length, 1); assert.equal(res.body.nextCursor, '');
  res = await request('/api/account/v1/holdings/ledger?user_id=u');
  assert.equal(res.status, 200); assert.equal(res.body.data.transactions.length, 3);
  assert.deepEqual(res.body.data.snapshotsByCode, {});
  res = await request('/api/account/v1/holdings/ledger/items/tx1', 'PUT', { user_id: 'u', data: { id: 'tx1' }, baseRevision: 99 });
  assert.equal(res.status, 409); assert.equal(res.body.error, 'REVISION_MISMATCH');
  assert.equal(res.body.current.id, 'tx1');
  res = await request('/api/account/v1/holdings/ledger/items/tx1', 'DELETE', { user_id: 'u' });
  assert.equal(res.status, 200); assert.equal(res.body.deleted, true);
  res = await request('/api/account/v1/holdings/ledger/items?user_id=u&limit=10');
  assert.equal(res.body.rows.length, 2);
  res = await request('/api/account/v1/manifest?user_id=u');
  const ledger = res.body.resources.find((r) => r.resource === 'holdings/ledger');
  assert.equal(ledger.itemCount, 2); assert.ok(ledger.revision > 0);
  assert.equal(ledger.merge, 'holdingsTransactions');
});

test('manifest, bundle and export envelope shapes', async (t) => {
  const { request } = await app(t);
  await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: { plans: [{ id: 'p1' }], version: 1 } });
  await request('/api/account/v1/holdings/ledger/items/tx1', 'PUT', { user_id: 'u', data: { id: 'tx1', date: '2026-10-01' } });
  let res = await request('/api/account/v1/manifest?user_id=u');
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'u'); assert.equal(typeof res.body.serverTime, 'string');
  assert.equal(res.body.resourceCount, 2); assert.ok(Array.isArray(res.body.resources));
  const plans = res.body.resources.find((r) => r.resource === 'plans/store');
  assert.equal(plans.feature, 'plans'); assert.equal(plans.revision, 1); assert.equal(plans.deleted, false);
  assert.equal(typeof res.body.migration.status, 'string');
  res = await request('/api/account/v1/bundle?user_id=u&resources=plans/store');
  assert.equal(res.status, 200); assert.deepEqual(Object.keys(res.body.resources), ['plans/store']);
  assert.equal(res.body.resources['plans/store'].revision, 1);
  assert.deepEqual(res.body.resources['plans/store'].data, { plans: [{ id: 'p1' }], version: 1 });
  assert.equal((await request('/api/account/v1/bundle?user_id=u&resources=nope/x')).status, 400);
  res = await request('/api/account/v1/bundle?user_id=u');
  assert.ok(res.body.resources['holdings/ledger']);
  assert.ok(Array.isArray(res.body.resources['holdings/ledger'].data.transactions));
  assert.equal(typeof res.body.serverTime, 'string');
  res = await request('/api/account/v1/exports/envelope?user_id=u');
  assert.equal(res.status, 200);
  assert.equal(res.body.version, 1); assert.equal(res.body.source, 'ai-dca');
  assert.ok(res.body.keys.includes('aiDcaPlanStore')); assert.ok(res.body.keys.includes('aiDcaFundHoldingsLedger'));
  assert.equal(res.body.keyCount, res.body.keys.length);
  assert.equal(JSON.parse(res.body.payload.aiDcaFundHoldingsLedger).transactions.length, 1);
  assert.deepEqual(JSON.parse(res.body.payload.aiDcaPlanStore), { plans: [{ id: 'p1' }], version: 1 });
});

test('writes enqueue account outbox events inside the same transaction', async (t) => {
  const { request, db } = await app(t);
  await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: { version: 1 }, end: { id: 'web', type: 'browser' } });
  await request('/api/account/v1/holdings/ledger/items/tx1', 'PUT', { user_id: 'u', data: { id: 'tx1', date: '2026-10-01' }, end: { id: 'web', type: 'browser' } });
  await request('/api/account/v1/holdings/ledger/items/tx1', 'DELETE', { user_id: 'u' });
  await request('/api/account/v1/plans/store', 'DELETE', { user_id: 'u' });
  const events = claimPendingEvents(db, 100);
  assert.equal(events.length, 4);
  for (const event of events) assert.equal(event.target, 'account');
  const [resourceEv, txUpsert, txDelete, resourceDelete] = events;
  assert.equal(resourceEv.event_type, 'upsert-resource');
  assert.equal(resourceEv.payload.resource, 'plans/store');
  assert.deepEqual(resourceEv.payload.resource_data, { version: 1, plans: [] });
  assert.equal(resourceEv.payload.deleted, false);
  assert.equal(resourceEv.payload.updated_by_end_id, 'web');
  assert.equal(resourceEv.payload.updated_by_end_type, 'browser');
  assert.equal(txUpsert.event_type, 'upsert-transaction');
  assert.deepEqual(txUpsert.payload.transaction_data, { id: 'tx1', date: '2026-10-01' });
  assert.equal(txUpsert.payload.transaction_id, 'tx1');
  assert.equal(txDelete.event_type, 'delete-transaction');
  assert.equal(txDelete.payload.transaction_id, 'tx1');
  assert.ok(!('transaction_data' in txDelete.payload));
  assert.equal(resourceDelete.event_type, 'upsert-resource');
  assert.equal(resourceDelete.payload.deleted, true); assert.equal(resourceDelete.payload.resource_data, null);
  // per-record writes also roll up to upsert-resource events
  await request('/api/account/v1/trades/ledger/items/t1', 'PUT', { user_id: 'u', item: { id: 't1' } });
  const itemEvents = claimPendingEvents(db, 100);
  assert.equal(itemEvents.length, 1); assert.equal(itemEvents[0].event_type, 'upsert-resource');
  assert.deepEqual(itemEvents[0].payload.resource_data, [{ id: 't1' }]);
  // conflicting writes enqueue nothing
  await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: { version: 2 }, baseRevision: 0 });
  assert.equal(outboxStats(db).pending, 0);
});

test('migration import writes resources, enqueues sync events, settles gate', async (t) => {
  const { request, db } = await app(t);
  insertLegacyBackup(db, 'u');
  const res = await request('/api/account/v1/migrations/legacy', 'POST', { user_id: 'u', resources: {
    'plans/store': { plans: [{ id: 'p1' }] },
    'holdings/ledger': { transactions: [{ id: 'tx1', date: '2026-10-01' }] },
    'holdings/position-snapshot': { ignored: true },
    'nope/resource': {}
  } });
  assert.equal(res.status, 200);
  assert.equal(res.body.migration.status, 'imported');
  assert.equal(res.body.imported.length, 2);
  assert.ok(res.body.skipped.some((s) => s.reason === 'deprecated_snapshot'));
  assert.ok(res.body.rejected.some((r) => r.code === 'UNKNOWN_RESOURCE'));
  const man = await request('/api/account/v1/manifest?user_id=u');
  assert.equal(man.status, 200); assert.equal(man.body.migration.status, 'imported');
  const plans = man.body.resources.find((r) => r.resource === 'plans/store');
  assert.equal(plans.revision, 1);
  const rows = await request('/api/account/v1/holdings/ledger/items?user_id=u&limit=10');
  assert.equal(rows.body.rows.length, 1); assert.equal(rows.body.rows[0].id, 'tx1');
  const events = claimPendingEvents(db, 100);
  assert.ok(events.some((e) => e.event_type === 'upsert-resource' && e.payload.resource === 'plans/store'));
  assert.ok(events.some((e) => e.event_type === 'upsert-transaction' && e.payload.transaction_id === 'tx1'));
  const txEvent = events.find((e) => e.event_type === 'upsert-transaction');
  assert.deepEqual(txEvent.payload.transaction_data, { id: 'tx1', date: '2026-10-01' });
  assert.equal((await request('/api/account/v1/migrations/legacy', 'POST', {})).status, 400);
});

test('legacy account_resources payload backfills transaction rows once', async (t) => {
  const { request, db } = await app(t);
  db.prepare(`INSERT INTO account_resources(user_id, resource, feature, revision, content_hash, bytes, item_count, payload, deleted, updated_at, updated_by_end_id, updated_by_end_type)
    VALUES ('backfill-u', 'holdings/ledger', 'holdings', 1, 'x', 10, 1, '{"transactions":[{"id":"old1","date":"2026-09-01"}]}', 0, '2026-09-01T00:00:00.000Z', '', '')`).run();
  const res = await request('/api/account/v1/holdings/ledger/items?user_id=backfill-u&limit=10');
  assert.equal(res.status, 200); assert.equal(res.body.rows.length, 1); assert.equal(res.body.rows[0].id, 'old1');
});

test('data-notice read/write and choice validation', async (t) => {
  const { request } = await app(t);
  let res = await request('/api/account/v1/user/data-notice?user_id=u');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { noticeVersion: '', choice: '', updatedAt: '' });
  res = await request('/api/account/v1/user/data-notice', 'PUT', { user_id: 'u', noticeVersion: 'plain-resource-sync-v1', choice: 'migrate' });
  assert.equal(res.status, 200);
  assert.equal(res.body.noticeVersion, 'plain-resource-sync-v1');
  assert.equal(res.body.choice, 'migrate'); assert.ok(res.body.updatedAt);
  res = await request('/api/account/v1/user/data-notice', 'PUT', { user_id: 'u', choice: 'bogus' });
  assert.equal(res.status, 400); assert.equal(res.body.error, 'INVALID_NOTICE_CHOICE');
  res = await request('/api/account/v1/user/data-notice', 'DELETE', { user_id: 'u' });
  assert.equal(res.status, 405);
});

test('discard requires confirmation, wipes data, skips outbox', async (t) => {
  const { request, db } = await app(t);
  await request('/api/account/v1/plans/store', 'PUT', { user_id: 'u', data: { version: 1 } });
  await request('/api/account/v1/holdings/ledger/items/tx1', 'PUT', { user_id: 'u', data: { id: 'tx1' } });
  claimPendingEvents(db, 100); // drain the two write events
  let res = await request('/api/account/v1/migrations/legacy/discard', 'POST', { user_id: 'u', confirmation: 'WRONG' });
  assert.equal(res.status, 400); assert.equal(res.body.error, 'CONFIRMATION_REQUIRED');
  assert.equal((await request('/api/account/v1/migrations/legacy/discard?user_id=u', 'GET')).status, 405);
  res = await request('/api/account/v1/migrations/legacy/discard', 'POST', { user_id: 'u', confirmation: 'DELETE_ALL_SYNC_DATA' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true); assert.equal(res.body.username, 'u');
  assert.equal(res.body.migration.status, 'skipped');
  assert.equal(res.body.dataNotice.choice, 'clear');
  assert.ok(res.body.purged.deletedRows > 0); assert.equal(res.body.purged.kvDeleted, false);
  res = await request('/api/account/v1/plans/store?user_id=u');
  assert.equal(res.body.revision, 0);
  res = await request('/api/account/v1/holdings/ledger/items?user_id=u&limit=10');
  assert.equal(res.body.rows.length, 0);
  assert.equal(outboxStats(db).pending, 0); // discard enqueues nothing
  assert.equal((await request('/api/account/v1/manifest?user_id=u')).status, 200);
});
