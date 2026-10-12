// cn-data per-record store: port of workers/account/src/recordStore.js to
// synchronous node:sqlite (DatabaseSync).

import { RESOURCE_HISTORY_LIMIT, measureBytes } from './catalog.js';
import { canonicalJson } from './patch.js';
import { assembleResourceRows } from './recordRows.js';
import { ensureSchema, nowIso, readResourceRow, sha256Hex } from './store.js';

function parsePayload(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || 'null')); } catch { return null; }
}

function readRows(db, userId, resource) {
  return db.prepare(`SELECT * FROM account_resource_records
    WHERE user_id = ? AND resource = ? ORDER BY position ASC, record_id ASC`).all(userId, resource);
}

function readRawResource(db, userId, resource) {
  return db.prepare('SELECT * FROM account_resources WHERE user_id = ? AND resource = ?').get(userId, resource);
}

function recordResult(row) {
  if (!row) return null;
  return {
    id: String(row.record_id || ''),
    parentId: String(row.parent_id || ''),
    kind: String(row.record_kind || 'item'),
    position: Number(row.position || 0),
    revision: Number(row.revision || 0),
    contentHash: String(row.content_hash || ''),
    updatedAt: String(row.updated_at || ''),
    updatedByEndId: String(row.updated_by_end_id || ''),
    updatedByEndType: String(row.updated_by_end_type || ''),
    deleted: Boolean(row.deleted),
    data: parsePayload(row.payload)
  };
}

// The item endpoint serializes this value twice: it needs revision metadata in
// JavaScript, while the public `resource` field remains the resource name.
function responseResource(descriptor, value) {
  const metadata = value && typeof value === 'object' ? { ...value } : {};
  Object.defineProperty(metadata, 'toJSON', {
    enumerable: false,
    value: () => descriptor.resource
  });
  return metadata;
}

function refreshResourceManifest(db, userId, descriptor, end = {}) {
  const records = readRows(db, userId, descriptor.resource);
  const assembled = assembleResourceRows(descriptor, records);
  const serialized = canonicalJson(assembled);
  const contentHash = sha256Hex(serialized);
  const current = readRawResource(db, userId, descriptor.resource);
  const revision = Number(current?.revision || 0) + 1;
  const updatedAt = nowIso();
  const endId = String(end?.id || '').slice(0, 120);
  const endType = String(end?.type || '').slice(0, 40);
  const activeCount = records.filter((record) => Number(record.deleted || 0) === 0 && record.record_kind !== 'meta').length;
  db.prepare(`INSERT INTO account_resources
    (user_id, resource, feature, revision, content_hash, bytes, item_count, payload, deleted, updated_at, updated_by_end_id, updated_by_end_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)
    ON CONFLICT(user_id, resource) DO UPDATE SET
      revision = excluded.revision,
      content_hash = excluded.content_hash,
      bytes = excluded.bytes,
      item_count = excluded.item_count,
      payload = '',
      deleted = 0,
      updated_at = excluded.updated_at,
      updated_by_end_id = excluded.updated_by_end_id,
      updated_by_end_type = excluded.updated_by_end_type`)
    .run(userId, descriptor.resource, descriptor.feature, revision, contentHash, measureBytes(serialized), activeCount, updatedAt, endId, endType);
  db.prepare(`INSERT OR REPLACE INTO account_resource_history
    (user_id, resource, revision, content_hash, bytes, payload, deleted, updated_at, updated_by_end_id, created_at)
    VALUES (?, ?, ?, ?, ?, '', 0, ?, ?, ?)`)
    .run(userId, descriptor.resource, revision, contentHash, measureBytes(serialized), updatedAt, endId, updatedAt);
  db.prepare('DELETE FROM account_resource_history WHERE user_id = ? AND resource = ? AND revision <= ?')
    .run(userId, descriptor.resource, revision - RESOURCE_HISTORY_LIMIT);
  return { revision, contentHash, updatedAt, itemCount: activeCount };
}

export function readResourceRecord(db, userId, descriptor, recordId) {
  ensureSchema();
  let row = db.prepare(`SELECT * FROM account_resource_records
    WHERE user_id = ? AND resource = ? AND record_id = ?`).get(userId, descriptor.resource, recordId);
  if (!row) {
    // This also lazily converts an old account_resources.payload aggregate.
    readResourceRow(db, userId, descriptor.resource);
    row = db.prepare(`SELECT * FROM account_resource_records
      WHERE user_id = ? AND resource = ? AND record_id = ?`).get(userId, descriptor.resource, recordId);
  }
  return recordResult(row);
}

export function writeResourceRecord(db, userId, descriptor, recordId, data, {
  parentId = '',
  kind = 'item',
  position = 0,
  expectedRevision = null,
  force = false,
  end = {}
} = {}) {
  ensureSchema();
  // Backfill first, otherwise updating one item on an old aggregate would
  // accidentally hide its untouched sibling records.
  readResourceRow(db, userId, descriptor.resource);
  const id = String(recordId || '').trim();
  const current = db.prepare(`SELECT * FROM account_resource_records
    WHERE user_id = ? AND resource = ? AND record_id = ?`).get(userId, descriptor.resource, id);
  const currentRevision = Number(current?.revision || 0);
  if (!force && expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
    return { conflict: true, currentRevision, current: recordResult(current), resource: responseResource(descriptor, readResourceRow(db, userId, descriptor.resource)) };
  }
  const serialized = JSON.stringify(data ?? null);
  const contentHash = sha256Hex(canonicalJson(data ?? null));
  if (current && Number(current.deleted || 0) === 0 && String(current.content_hash || '') === contentHash) {
    return { unchanged: true, recordRevision: currentRevision, record: recordResult(current), resource: responseResource(descriptor, readResourceRow(db, userId, descriptor.resource)) };
  }
  const timestamp = nowIso();
  const endId = String(end?.id || '').slice(0, 120);
  const endType = String(end?.type || '').slice(0, 40);
  const revision = currentRevision + 1;
  db.prepare(`INSERT INTO account_resource_records
    (user_id, resource, record_id, parent_id, record_kind, position, revision, content_hash, bytes, payload, deleted, created_at, updated_at, updated_by_end_id, updated_by_end_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(user_id, resource, record_id) DO UPDATE SET
      parent_id = excluded.parent_id,
      record_kind = excluded.record_kind,
      position = excluded.position,
      revision = excluded.revision,
      content_hash = excluded.content_hash,
      bytes = excluded.bytes,
      payload = excluded.payload,
      deleted = 0,
      updated_at = excluded.updated_at,
      updated_by_end_id = excluded.updated_by_end_id,
      updated_by_end_type = excluded.updated_by_end_type`)
    .run(userId, descriptor.resource, id, String(parentId || '').slice(0, 240), String(kind || 'item').slice(0, 40), Number(position) || 0, revision, contentHash, measureBytes(serialized), serialized, timestamp, timestamp, endId, endType);
  const resource = refreshResourceManifest(db, userId, descriptor, end);
  return { recordRevision: revision, record: { id, parentId, kind, position: Number(position) || 0, revision, contentHash, updatedAt: timestamp, data }, resource: responseResource(descriptor, resource) };
}

export function deleteResourceRecord(db, userId, descriptor, recordId, { expectedRevision = null, force = false, end = {} } = {}) {
  ensureSchema();
  readResourceRow(db, userId, descriptor.resource);
  const id = String(recordId || '').trim();
  const current = db.prepare(`SELECT * FROM account_resource_records
    WHERE user_id = ? AND resource = ? AND record_id = ?`).get(userId, descriptor.resource, id);
  const currentRevision = Number(current?.revision || 0);
  if (!current || Number(current.deleted || 0) === 1) return { notFound: true, currentRevision };
  if (!force && expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
    return { conflict: true, currentRevision, current: recordResult(current), resource: responseResource(descriptor, readResourceRow(db, userId, descriptor.resource)) };
  }
  const timestamp = nowIso();
  const revision = currentRevision + 1;
  db.prepare(`UPDATE account_resource_records SET
    revision = ?, content_hash = '', bytes = 0, payload = '{}', deleted = 1,
    updated_at = ?, updated_by_end_id = ?, updated_by_end_type = ?
    WHERE user_id = ? AND resource = ? AND record_id = ?`)
    .run(revision, timestamp, String(end?.id || '').slice(0, 120), String(end?.type || '').slice(0, 40), userId, descriptor.resource, id);
  const resource = refreshResourceManifest(db, userId, descriptor, end);
  return { recordRevision: revision, deleted: true, resource: responseResource(descriptor, resource) };
}
