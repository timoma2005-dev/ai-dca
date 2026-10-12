// cn-data holdings transaction store: port of workers/account/src/transactions.js
// to synchronous node:sqlite (DatabaseSync). Schema owned by
// migrations/001-init.sql + 002-account-v1.sql.

import { measureBytes } from './catalog.js';
import { canonicalJson } from './patch.js';
import { nowIso, sha256Hex } from './store.js';

export const HOLDINGS_LEDGER_RESOURCE = 'holdings/ledger';
export const HOLDINGS_TRANSACTION_MAX_BYTES = 64 * 1024;

// Schema is owned by migrations/*.sql; kept as a no-op so call sites ported
// from the worker keep working unchanged.
export function ensureTransactionSchema() {
  return;
}

export function normalizeTransactionRow(value = {}, requestedId = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = String(value.id || requestedId || '').trim();
  if (!id || id.length > 160) return null;
  return { ...value, id };
}

export function transactionSerialized(value) {
  const normalized = normalizeTransactionRow(value);
  if (!normalized) return { ok: false, code: 'TRANSACTION_INVALID' };
  let serialized;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    return { ok: false, code: 'TRANSACTION_UNSERIALIZABLE' };
  }
  const bytes = measureBytes(serialized);
  if (bytes > HOLDINGS_TRANSACTION_MAX_BYTES) {
    return { ok: false, code: 'TRANSACTION_TOO_LARGE', bytes };
  }
  return { ok: true, value: normalized, serialized, bytes };
}

export function sortTransactionRows(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const ad = String(a?.data?.date || a?.date || a?.createdAt || '');
    const bd = String(b?.data?.date || b?.date || b?.createdAt || '');
    if (ad !== bd) return ad.localeCompare(bd);
    return String(a?.data?.id || a?.id || '').localeCompare(String(b?.data?.id || b?.id || ''));
  });
}

export function canonicalTransactionRows(rows = []) {
  const values = sortTransactionRows(rows).map((row) => row?.data || row).filter(Boolean);
  return canonicalJson(values);
}

function parsePayload(row) {
  if (!row || Number(row.deleted || 0) === 1 || !row.payload) return null;
  try {
    return JSON.parse(String(row.payload));
  } catch {
    return null;
  }
}

function rowToItem(row) {
  const data = parsePayload(row);
  if (!data) return null;
  return {
    id: String(row.transaction_id || data.id || ''),
    revision: Number(row.revision || 0),
    contentHash: String(row.content_hash || ''),
    updatedAt: String(row.updated_at || ''),
    updatedByEndId: String(row.updated_by_end_id || ''),
    updatedByEndType: String(row.updated_by_end_type || ''),
    data
  };
}

function readMetaRow(db, userId) {
  return db.prepare('SELECT * FROM account_holdings_transaction_meta WHERE user_id = ?').get(userId);
}

export function readTransactionRow(db, userId, transactionId) {
  return db.prepare(
    'SELECT * FROM account_holdings_transactions WHERE user_id = ? AND transaction_id = ?'
  ).get(userId, transactionId);
}

export function readTransactionRows(db, userId, { includeDeleted = false, limit = 500, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const sql = includeDeleted
    ? 'SELECT * FROM account_holdings_transactions WHERE user_id = ? ORDER BY updated_at ASC, transaction_id ASC LIMIT ? OFFSET ?'
    : 'SELECT * FROM account_holdings_transactions WHERE user_id = ? AND deleted = 0 ORDER BY updated_at ASC, transaction_id ASC LIMIT ? OFFSET ?';
  const rows = db.prepare(sql).all(userId, safeLimit, safeOffset);
  return (rows || []).map(rowToItem).filter(Boolean);
}

const legacyBackfillAttempted = new Set();

// 历史版本记录：只 INSERT，不 UPDATE / DELETE。
// 删除操作必须在清空 payload 之前调用，传入删除前的完整行数据。
function recordTransactionHistory(db, userId, transactionId, {
  operation = '',
  revision = 0,
  contentHash = '',
  bytes = 0,
  payload = '',
  deleted = 0,
  recordedAt = '',
  endId = '',
  endType = ''
} = {}) {
  db.prepare(`INSERT INTO account_holdings_transaction_history
    (user_id, transaction_id, revision, operation, content_hash, bytes, payload, deleted,
     recorded_at, updated_by_end_id, updated_by_end_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      String(userId || ''),
      String(transactionId || ''),
      Number(revision || 0),
      String(operation || '').slice(0, 40),
      String(contentHash || ''),
      Number(bytes || 0),
      String(payload || ''),
      Number(deleted || 0) === 1 ? 1 : 0,
      String(recordedAt || nowIso()),
      String(endId || '').slice(0, 120),
      String(endType || '').slice(0, 40)
    );
}

export function readTransactionHistory(db, userId, transactionId, { limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = db.prepare(
    `SELECT seq, user_id, transaction_id, revision, operation, content_hash, bytes, payload, deleted,
            recorded_at, updated_by_end_id, updated_by_end_type
     FROM account_holdings_transaction_history
     WHERE user_id = ? AND transaction_id = ?
     ORDER BY seq DESC LIMIT ? OFFSET ?`
  ).all(String(userId || ''), String(transactionId || ''), safeLimit, safeOffset);
  return (rows || []).map((row) => ({
    seq: Number(row.seq || 0),
    userId: String(row.user_id || ''),
    transactionId: String(row.transaction_id || ''),
    revision: Number(row.revision || 0),
    operation: String(row.operation || ''),
    contentHash: String(row.content_hash || ''),
    bytes: Number(row.bytes || 0),
    payload: String(row.payload || ''),
    deleted: Number(row.deleted || 0) === 1,
    recordedAt: String(row.recorded_at || ''),
    updatedByEndId: String(row.updated_by_end_id || ''),
    updatedByEndType: String(row.updated_by_end_type || '')
  }));
}

export function backfillLegacyTransactions(db, userId) {
  const key = String(userId || '');
  if (legacyBackfillAttempted.has(key)) return false;
  legacyBackfillAttempted.add(key);
  const current = readMetaRow(db, userId);
  if (current && (Number(current.revision || 0) > 0 || Number(current.item_count || 0) > 0)) return false;
  let legacy = null;
  try {
    legacy = db.prepare('SELECT payload, deleted FROM account_resources WHERE user_id = ? AND resource = ?')
      .get(userId, HOLDINGS_LEDGER_RESOURCE);
  } catch {
    return false;
  }
  if (!legacy || Number(legacy.deleted || 0) === 1 || !legacy.payload) return false;
  let parsed = null;
  try { parsed = JSON.parse(String(legacy.payload)); } catch { return false; }
  const rows = extractLegacyTransactions(parsed);
  if (!rows.length) return false;
  for (const row of rows) {
    const normalized = normalizeTransactionRow(row);
    if (!normalized) continue;
    writeTransactionRow(db, userId, normalized.id, normalized, {
      force: true,
      end: { id: 'server-backfill', type: 'legacy-resource' }
    });
  }
  return true;
}

export function readTransactionManifest(db, userId) {
  backfillLegacyTransactions(db, userId);
  const row = readMetaRow(db, userId);
  return {
    resource: HOLDINGS_LEDGER_RESOURCE,
    feature: 'holdings',
    merge: 'holdingsTransactions',
    revision: Number(row?.revision || 0),
    contentHash: String(row?.content_hash || ''),
    bytes: Number(row?.bytes || 0),
    itemCount: Number(row?.item_count || 0),
    deleted: false,
    updatedAt: String(row?.updated_at || ''),
    updatedByEndId: String(row?.updated_by_end_id || ''),
    updatedByEndType: String(row?.updated_by_end_type || '')
  };
}

function rebuildTransactionMeta(db, userId, end = {}) {
  const rows = readTransactionRows(db, userId, { limit: 1000 });
  const canonical = canonicalTransactionRows(rows);
  const current = readMetaRow(db, userId);
  const revision = Number(current?.revision || 0) + 1;
  const updatedAt = nowIso();
  const contentHash = sha256Hex(canonical);
  const bytes = measureBytes(canonical);
  const endId = String(end?.id || '').slice(0, 120);
  const endType = String(end?.type || '').slice(0, 40);
  db.prepare(`INSERT INTO account_holdings_transaction_meta
    (user_id, revision, content_hash, bytes, item_count, updated_at, updated_by_end_id, updated_by_end_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      revision = excluded.revision,
      content_hash = excluded.content_hash,
      bytes = excluded.bytes,
      item_count = excluded.item_count,
      updated_at = excluded.updated_at,
      updated_by_end_id = excluded.updated_by_end_id,
      updated_by_end_type = excluded.updated_by_end_type`)
    .run(userId, revision, contentHash, bytes, rows.length, updatedAt, endId, endType);
  return {
    revision,
    contentHash,
    bytes,
    itemCount: rows.length,
    updatedAt,
    updatedByEndId: endId,
    updatedByEndType: endType
  };
}

export function writeTransactionRow(db, userId, transactionId, value, {
  expectedRevision = null,
  force = false,
  end = {}
} = {}) {
  const normalized = normalizeTransactionRow(value, transactionId);
  const validation = transactionSerialized(normalized);
  if (!validation.ok) return { invalid: true, ...validation };
  if (normalized.id !== String(transactionId || '').trim()) {
    return { invalid: true, code: 'TRANSACTION_ID_MISMATCH' };
  }

  const current = readTransactionRow(db, userId, normalized.id);
  const currentRevision = Number(current?.revision || 0);
  if (!force && expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
    return {
      conflict: true,
      currentRevision,
      current: rowToItem(current),
      resource: readTransactionManifest(db, userId)
    };
  }

  const contentHash = sha256Hex(canonicalJson(validation.value));
  const unchanged = Boolean(current)
    && Number(current.deleted || 0) === 0
    && String(current.content_hash || '') === contentHash;
  if (unchanged) {
    return {
      unchanged: true,
      rowRevision: currentRevision,
      contentHash: String(current?.content_hash || ''),
      transaction: rowToItem(current),
      resource: readTransactionManifest(db, userId)
    };
  }

  const revision = currentRevision + 1;
  const updatedAt = nowIso();
  const endId = String(end?.id || '').slice(0, 120);
  const endType = String(end?.type || '').slice(0, 40);
  db.prepare(`INSERT INTO account_holdings_transactions
    (user_id, transaction_id, revision, content_hash, bytes, payload, deleted, updated_at, updated_by_end_id, updated_by_end_type)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(user_id, transaction_id) DO UPDATE SET
      revision = excluded.revision,
      content_hash = excluded.content_hash,
      bytes = excluded.bytes,
      payload = excluded.payload,
      deleted = 0,
      updated_at = excluded.updated_at,
      updated_by_end_id = excluded.updated_by_end_id,
      updated_by_end_type = excluded.updated_by_end_type`)
    .run(userId, normalized.id, revision, contentHash, validation.bytes, validation.serialized, updatedAt, endId, endType);
  recordTransactionHistory(db, userId, normalized.id, {
    operation: 'write',
    revision,
    contentHash,
    bytes: validation.bytes,
    payload: validation.serialized,
    deleted: 0,
    recordedAt: updatedAt,
    endId,
    endType
  });
  const resource = rebuildTransactionMeta(db, userId, end);
  return { rowRevision: revision, contentHash, transaction: { ...validation.value, revision }, resource };
}

export function deleteTransactionRow(db, userId, transactionId, { expectedRevision = null, force = false, end = {} } = {}) {
  const id = String(transactionId || '').trim();
  const current = readTransactionRow(db, userId, id);
  const currentRevision = Number(current?.revision || 0);
  if (!current || Number(current.deleted || 0) === 1) {
    return { unchanged: true, rowRevision: currentRevision, resource: readTransactionManifest(db, userId) };
  }
  if (!force && expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
    return { conflict: true, currentRevision, current: rowToItem(current), resource: readTransactionManifest(db, userId) };
  }
  const revision = currentRevision + 1;
  const updatedAt = nowIso();
  const endId = String(end?.id || '').slice(0, 120);
  const endType = String(end?.type || '').slice(0, 40);
  // 先记历史（带删除前的完整 payload），再清空主表 payload，保证可恢复。
  recordTransactionHistory(db, userId, id, {
    operation: 'delete',
    revision,
    contentHash: String(current.content_hash || ''),
    bytes: Number(current.bytes || 0),
    payload: String(current.payload || ''),
    deleted: 1,
    recordedAt: updatedAt,
    endId,
    endType
  });
  db.prepare(`UPDATE account_holdings_transactions SET
    revision = ?, content_hash = '', bytes = 0, payload = '', deleted = 1,
    updated_at = ?, updated_by_end_id = ?, updated_by_end_type = ?
    WHERE user_id = ? AND transaction_id = ?`)
    .run(revision, updatedAt, endId, endType, userId, id);
  const resource = rebuildTransactionMeta(db, userId, end);
  return { rowRevision: revision, contentHash: '', deleted: true, resource };
}

export function extractLegacyTransactions(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.transactions)) return value.transactions;
  return [];
}

export function importLegacyTransactions(db, userId, value, { end = {}, overwrite = false } = {}) {
  const rows = extractLegacyTransactions(value);
  const imported = [];
  const skipped = [];
  const rejected = [];
  for (const row of rows) {
    const normalized = normalizeTransactionRow(row);
    if (!normalized) {
      rejected.push({ code: 'TRANSACTION_INVALID' });
      continue;
    }
    const current = readTransactionRow(db, userId, normalized.id);
    if (!overwrite && current && Number(current.deleted || 0) === 0 && Number(current.revision || 0) > 0) {
      skipped.push(normalized.id);
      continue;
    }
    const result = writeTransactionRow(db, userId, normalized.id, normalized, { force: true, end });
    if (result.invalid) rejected.push({ id: normalized.id, code: result.code });
    else imported.push({ id: normalized.id, revision: result.rowRevision });
  }
  return { imported, skipped, rejected, importedCount: imported.length };
}

export function readLegacyTransactionEnvelope(db, userId) {
  const rows = readTransactionRows(db, userId, { limit: 1000 });
  return {
    transactions: rows.map((item) => item.data),
    snapshotsByCode: {},
    lastNavMeta: { status: 'idle', updatedAt: '', successCount: 0, failureCount: 0, errors: [] },
    migratedFromLegacy: true,
    switchChains: []
  };
}
