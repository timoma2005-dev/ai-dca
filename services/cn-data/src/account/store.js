// cn-data account store: port of workers/account/src/store.js to synchronous
// node:sqlite (DatabaseSync). Table DDL lives in migrations/002-account-v1.sql;
// account_resources and account_holdings_transactions came from 001-init.sql.

import { createHash } from 'node:crypto';
import { RESOURCE_CATALOG, RESOURCE_HISTORY_LIMIT, measureBytes, getResourceDescriptor } from './catalog.js';
import { canonicalJson } from './patch.js';
import { assembleResourceRows, rowCount, splitResourceRows } from './recordRows.js';

export function nowIso() {
  return new Date().toISOString();
}

export function sha256Hex(text = '') {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

// Schema is owned by migrations/*.sql; kept as a no-op so call sites ported
// from the worker keep working unchanged.
export function ensureSchema() {
  return;
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

export function parsePayload(row) {
  if (!row || row.deleted) return null;
  if (!row.payload) return null;
  return parseJson(row.payload, null);
}

function rowToMeta(row, descriptor) {
  return {
    resource: descriptor.resource,
    feature: descriptor.feature,
    merge: descriptor.merge,
    revision: Number(row?.revision || 0),
    contentHash: String(row?.content_hash || ''),
    bytes: Number(row?.bytes || 0),
    itemCount: Number(row?.item_count || 0),
    deleted: Boolean(row?.deleted),
    updatedAt: String(row?.updated_at || ''),
    updatedByEndId: String(row?.updated_by_end_id || ''),
    updatedByEndType: String(row?.updated_by_end_type || '')
  };
}

function readRawResourceRow(db, userId, resource) {
  return db.prepare('SELECT * FROM account_resources WHERE user_id = ? AND resource = ?').get(userId, resource);
}

function readRecordRows(db, userId, resource) {
  return db.prepare(`SELECT * FROM account_resource_records
    WHERE user_id = ? AND resource = ? ORDER BY position ASC, record_id ASC`).all(userId, resource);
}

function backfillLegacyRows(db, userId, descriptor, legacyRow) {
  if (!legacyRow || Number(legacyRow.deleted || 0) === 1 || !legacyRow.payload) return [];
  const existing = readRecordRows(db, userId, descriptor.resource);
  if (existing.length) return existing;
  const data = parseJson(legacyRow.payload, null);
  if (data === null || data === undefined) return [];
  const rows = splitResourceRows(descriptor, data);
  const timestamp = nowIso();
  const insert = db.prepare(`INSERT OR IGNORE INTO account_resource_records
    (user_id, resource, record_id, parent_id, record_kind, position, revision, content_hash, bytes, payload, deleted, created_at, updated_at, updated_by_end_id, updated_by_end_type)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?, ?, ?)`);
  for (const item of rows) {
    const serialized = JSON.stringify(item.payload ?? null);
    insert.run(userId, descriptor.resource, item.recordId, item.parentId, item.recordKind, item.position, '', measureBytes(serialized), serialized, timestamp, timestamp, 'server-backfill', 'legacy-resource');
  }
  return readRecordRows(db, userId, descriptor.resource);
}

function hydratedResourceRow(db, userId, descriptor, rawRow = null) {
  const row = rawRow || readRawResourceRow(db, userId, descriptor.resource);
  if (!row) return null;
  let records = readRecordRows(db, userId, descriptor.resource);
  if (!records.length) records = backfillLegacyRows(db, userId, descriptor, row);
  if (records.length) {
    return { ...row, payload: JSON.stringify(assembleResourceRows(descriptor, records)) };
  }
  return row;
}

export function readResourceRow(db, userId, resource) {
  const descriptor = getResourceDescriptor(resource);
  return hydratedResourceRow(db, userId, descriptor || { resource, shape: 'object' });
}

export function readAllResourceRows(db, userId) {
  const rows = db.prepare('SELECT * FROM account_resources WHERE user_id = ?').all(userId);
  const map = new Map();
  for (const raw of rows || []) {
    const descriptor = getResourceDescriptor(raw.resource) || { resource: raw.resource, shape: 'object' };
    map.set(String(raw.resource), hydratedResourceRow(db, userId, descriptor, raw));
  }
  return map;
}

export function readManifest(db, userId) {
  const rows = readAllRawResourceRows(db, userId);
  return RESOURCE_CATALOG.map((descriptor) => rowToMeta(rows.get(descriptor.resource), descriptor));
}

function readAllRawResourceRows(db, userId) {
  const rows = db.prepare('SELECT * FROM account_resources WHERE user_id = ?').all(userId);
  const map = new Map();
  for (const row of rows || []) map.set(String(row.resource), row);
  return map;
}

function writeRecordRows(db, userId, descriptor, data, end = {}) {
  const incoming = splitResourceRows(descriptor, data);
  const existing = readRecordRows(db, userId, descriptor.resource);
  const existingById = new Map(existing.map((item) => [String(item.record_id), item]));
  const incomingIds = new Set(incoming.map((item) => item.recordId));
  const now = nowIso();
  const endId = String(end?.id || '').slice(0, 120);
  const endType = String(end?.type || '').slice(0, 40);
  const upsert = db.prepare(`INSERT INTO account_resource_records
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
      updated_by_end_type = excluded.updated_by_end_type`);
  for (const item of incoming) {
    const current = existingById.get(item.recordId);
    const serialized = JSON.stringify(item.payload ?? null);
    const contentHash = sha256Hex(canonicalJson(item.payload ?? null));
    const revision = Number(current?.revision || 0) + 1;
    upsert.run(userId, descriptor.resource, item.recordId, item.parentId, item.recordKind, item.position, revision, contentHash, measureBytes(serialized), serialized, now, now, endId, endType);
  }
  const tombstone = db.prepare(`UPDATE account_resource_records SET
    revision = ?, content_hash = '', bytes = 0, payload = '{}', deleted = 1,
    updated_at = ?, updated_by_end_id = ?, updated_by_end_type = ?
    WHERE user_id = ? AND resource = ? AND record_id = ?`);
  for (const current of existing) {
    const id = String(current.record_id || '');
    if (!incomingIds.has(id) && Number(current.deleted || 0) === 0) {
      tombstone.run(Number(current.revision || 0) + 1, now, endId, endType, userId, descriptor.resource, id);
    }
  }
  return { rows: incoming, count: incoming.length };
}

export function writeResource(db, userId, descriptor, {
  data = null,
  serialized = null,
  expectedRevision = null,
  force = false,
  deleted = false,
  end = {}
} = {}) {
  const current = readRawResourceRow(db, userId, descriptor.resource);
  const currentRevision = Number(current?.revision || 0);
  if (!force && expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
    const hydrated = hydratedResourceRow(db, userId, descriptor, current);
    return {
      conflict: true,
      currentRevision,
      updatedAt: String(current?.updated_at || ''),
      contentHash: String(current?.content_hash || ''),
      data: parsePayload(hydrated)
    };
  }

  const payloadData = deleted ? null : data;
  const contentHash = deleted ? '' : sha256Hex(canonicalJson(payloadData));
  const alreadySame = Boolean(current) && Number(current.deleted || 0) === (deleted ? 1 : 0) && String(current.content_hash || '') === contentHash;
  if (alreadySame) {
    return {
      unchanged: true,
      revision: currentRevision,
      updatedAt: String(current.updated_at || ''),
      contentHash,
      bytes: Number(current.bytes || 0),
      itemCount: Number(current.item_count || 0)
    };
  }

  let count = 0;
  const now = nowIso();
  const endId = String(end?.id || '').slice(0, 120);
  const endType = String(end?.type || '').slice(0, 40);
  if (!deleted) {
    const result = writeRecordRows(db, userId, descriptor, payloadData, end);
    count = result.count;
  } else {
    const records = readRecordRows(db, userId, descriptor.resource);
    const tombstone = db.prepare(`UPDATE account_resource_records SET
      revision = ?, content_hash = '', bytes = 0, payload = '{}', deleted = 1,
      updated_at = ?, updated_by_end_id = ?, updated_by_end_type = ?
      WHERE user_id = ? AND resource = ? AND record_id = ?`);
    for (const item of records) {
      if (Number(item.deleted || 0) !== 0) continue;
      tombstone.run(Number(item.revision || 0) + 1, now, endId, endType, userId, descriptor.resource, item.record_id);
    }
  }

  const revision = currentRevision + 1;
  const updatedAt = nowIso();
  const bytes = deleted ? 0 : measureBytes(canonicalJson(payloadData));
  db.prepare(`INSERT INTO account_resources (user_id, resource, feature, revision, content_hash, bytes, item_count, payload, deleted, updated_at, updated_by_end_id, updated_by_end_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
    ON CONFLICT(user_id, resource) DO UPDATE SET
      revision = excluded.revision,
      content_hash = excluded.content_hash,
      bytes = excluded.bytes,
      item_count = excluded.item_count,
      payload = '',
      deleted = excluded.deleted,
      updated_at = excluded.updated_at,
      updated_by_end_id = excluded.updated_by_end_id,
      updated_by_end_type = excluded.updated_by_end_type`)
    .run(userId, descriptor.resource, descriptor.feature, revision, contentHash, bytes, count, deleted ? 1 : 0, updatedAt, endId, endType);
  db.prepare(`INSERT OR REPLACE INTO account_resource_history (user_id, resource, revision, content_hash, bytes, payload, deleted, updated_at, updated_by_end_id, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`)
    .run(userId, descriptor.resource, revision, contentHash, bytes, deleted ? 1 : 0, updatedAt, endId, updatedAt);
  db.prepare('DELETE FROM account_resource_history WHERE user_id = ? AND resource = ? AND revision <= ?')
    .run(userId, descriptor.resource, revision - RESOURCE_HISTORY_LIMIT);

  return { revision, updatedAt, contentHash, bytes, itemCount: count, deleted };
}

export function readHistory(db, userId, resource, limit = RESOURCE_HISTORY_LIMIT) {
  const size = Math.min(Math.max(Number(limit) || RESOURCE_HISTORY_LIMIT, 1), RESOURCE_HISTORY_LIMIT);
  const rows = db
    .prepare('SELECT revision, content_hash, bytes, deleted, updated_at, updated_by_end_id FROM account_resource_history WHERE user_id = ? AND resource = ? ORDER BY revision DESC LIMIT ?')
    .all(userId, resource, size);
  return (rows || []).map((row) => ({
    revision: Number(row.revision || 0),
    contentHash: String(row.content_hash || ''),
    bytes: Number(row.bytes || 0),
    deleted: Boolean(row.deleted),
    updatedAt: String(row.updated_at || ''),
    updatedByEndId: String(row.updated_by_end_id || '')
  }));
}

export function readMigration(db, userId) {
  const row = db.prepare('SELECT * FROM account_migrations WHERE user_id = ?').get(userId);
  if (!row) return { status: 'pending', source: '', legacyVersion: 0, importedResources: 0, note: '', updatedAt: '' };
  return {
    status: String(row.status || 'pending'),
    source: String(row.source || ''),
    legacyVersion: Number(row.legacy_version || 0),
    importedResources: Number(row.imported_resources || 0),
    note: String(row.note || ''),
    updatedAt: String(row.updated_at || '')
  };
}

export function writeMigration(db, userId, { status, source = '', legacyVersion = 0, importedResources = 0, note = '' }) {
  const timestamp = nowIso();
  db.prepare(`INSERT INTO account_migrations (user_id, status, source, legacy_version, imported_resources, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      legacy_version = excluded.legacy_version,
      imported_resources = excluded.imported_resources,
      note = excluded.note,
      updated_at = excluded.updated_at`)
    .run(userId, status, source, Number(legacyVersion) || 0, Number(importedResources) || 0, String(note || '').slice(0, 400), timestamp, timestamp);
  return readMigration(db, userId);
}

// cn-data has no sync-worker `backups` table; the equivalent legacy envelope
// lives in cn-data's own sync_backups (user_id, payload, version, updated_at),
// whose payload is the encrypted-envelope JSON.
export function readLegacyBackupMeta(db, userId) {
  let row = null;
  try {
    row = db.prepare('SELECT version, updated_at, payload FROM sync_backups WHERE user_id = ?').get(userId);
  } catch {
    return { exists: false, reason: 'legacy-table-missing' };
  }
  if (!row) return { exists: false };
  const envelopeText = String(row.payload || 'null');
  let cryptoKind = 'unknown';
  let envelopeVersion = 0;
  try {
    const parsed = JSON.parse(envelopeText);
    envelopeVersion = Number(parsed?.version || 0);
    const cryptoMeta = parsed?.crypto || {};
    if (!parsed?.ciphertext) cryptoKind = 'plaintext';
    else if (envelopeVersion === 3 && cryptoMeta.wrappedDek) cryptoKind = 'password';
    else if (String(cryptoMeta.kdf || '') === 'RAW-AES-GCM' || !cryptoMeta.salt) cryptoKind = 'device-key';
    else cryptoKind = 'password';
  } catch {
    cryptoKind = 'unknown';
  }
  return {
    exists: true,
    version: Number(row.version || 0),
    envelopeVersion,
    updatedAt: String(row.updated_at || ''),
    keyCount: 0,
    bytes: Buffer.byteLength(envelopeText),
    contentHash: sha256Hex(envelopeText),
    cryptoKind
  };
}
