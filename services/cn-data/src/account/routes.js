// cn-data account v1 routes: port of workers/account/src/index.js +
// workers/account/src/entry.js (data-notice, discard) to synchronous
// node:sqlite. Response shapes are kept byte-identical to the worker because
// the frontend (src/app/accountApi.js, holdingTransactionsApi.js,
// accountDataMigrationActions.js) depends on them.
//
// Auth: cn-data has no users/sessions tables, so Bearer tokens cannot be
// validated here. user_id is taken from query/body, the same known auth gap
// marked TODO in routes/data.js.
// TODO: derive user_id from the auth-service session verified by nginx,
// instead of trusting query/body identity, before exposing these APIs publicly.
//
// Outbox policy: every account resource/transaction write enqueues a
// sync_outbox event targeting 'account' INSIDE the same SQLite transaction.
// Event types match what workers/account/src/internalSync.js consumes:
// upsert-transaction, delete-transaction, upsert-resource. One-time setup ops
// are intentionally NOT enqueued (migration status imported/skipped,
// data-notice choice, discard/purge): the sync worker has no handler for
// them, and discard explicitly deletes everything by user request.

import { withTransaction } from '../db.js';
import { enqueueEvent } from '../outbox.js';
import {
  MAX_IMPORT_BYTES,
  MAX_RESOURCE_BYTES,
  getResourceDescriptor,
  listResourceDescriptors,
  measureBytes,
  parseAccountPath,
  validateResourcePayload
} from './catalog.js';
import { applyResourcePatch } from './patch.js';
import {
  nowIso,
  parsePayload,
  readAllResourceRows,
  readHistory,
  readLegacyBackupMeta,
  readManifest,
  readMigration,
  readResourceRow,
  writeMigration,
  writeResource
} from './store.js';
import {
  deleteResourceRecord,
  readResourceRecord,
  writeResourceRecord
} from './recordStore.js';
import {
  HOLDINGS_LEDGER_RESOURCE,
  deleteTransactionRow,
  importLegacyTransactions,
  readLegacyTransactionEnvelope,
  readTransactionManifest,
  readTransactionRow,
  readTransactionRows,
  writeTransactionRow
} from './transactions.js';
import {
  ACCOUNT_DATA_NOTICE_VERSION,
  readAccountDataNotice,
  writeAccountDataNotice
} from './userNotice.js';
import {
  ACCOUNT_PURGE_CONFIRMATION,
  purgeAccountData
} from './purge.js';

const DISCARD_PATH = '/api/account/v1/migrations/legacy/discard';
const DATA_NOTICE_PATH = '/api/account/v1/user/data-notice';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.message = message || code;
  }
}

const baseHeaders = {
  'cache-control': 'no-store',
  'access-control-expose-headers': 'etag, x-resource-revision'
};

function ok(body, headers = {}) {
  return { status: 200, body, headers: { ...baseHeaders, ...headers } };
}

function fail(error) {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.code, message: error.message }, headers: baseHeaders };
  console.error('[cn-data account] 未处理异常', error);
  return { status: 500, body: { error: 'INTERNAL_ERROR', message: '服务异常，请稍后重试' }, headers: baseHeaders };
}

function requireUserId(url, body) {
  const queryUser = url.searchParams.get('user_id');
  if (queryUser && body?.user_id && queryUser !== body.user_id) throw new HttpError(400, 'CONFLICTING_USER_ID', 'Conflicting user_id');
  const userId = String(body?.user_id ?? queryUser ?? '').trim();
  if (!userId) throw new HttpError(400, 'USER_ID_REQUIRED', 'user_id is required');
  return userId;
}

function readExpectedRevision(headers, body = {}) {
  const header = headers?.['if-match'] || '';
  if (header) {
    const normalized = header.replace(/^W\//, '').replace(/"/g, '').trim();
    if (normalized === '*') return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fromBody = body?.baseRevision ?? body?.expectedRevision;
  if (fromBody === null || fromBody === undefined || fromBody === '') return null;
  const parsed = Number(fromBody);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRequestPath(pathname) {
  const normalized = String(pathname || '').replace(/\/+$/, '');
  if (normalized === DISCARD_PATH) return { kind: 'discard' };
  if (normalized === DATA_NOTICE_PATH) return { kind: 'data-notice' };
  const match = normalized.match(/^\/api\/account\/v1\/([^/]+)\/([^/]+)\/items$/);
  if (match) {
    const descriptor = getResourceDescriptor(`${match[1]}/${match[2]}`);
    if (descriptor?.resource === HOLDINGS_LEDGER_RESOURCE) return { kind: 'holding-transaction-items', descriptor };
  }
  return parseAccountPath(pathname);
}

function endOf(body) {
  const end = body?.end || {};
  return { id: String(end.id || '').slice(0, 120), type: String(end.type || '').slice(0, 40) };
}

// --- outbox helpers: payload shapes match workers/account/src/internalSync.js ---
function enqueueUpsertTransaction(db, userId, transactionId, end) {
  const row = readTransactionRow(db, userId, transactionId);
  let data = null;
  try { data = row && Number(row.deleted || 0) !== 1 && row.payload ? JSON.parse(String(row.payload)) : null; } catch { data = null; }
  enqueueEvent(db, 'account', 'upsert-transaction', {
    user_id: userId,
    transaction_id: transactionId,
    transaction_data: data,
    updated_by_end_id: end.id,
    updated_by_end_type: end.type
  });
}

function enqueueDeleteTransaction(db, userId, transactionId, end) {
  enqueueEvent(db, 'account', 'delete-transaction', {
    user_id: userId,
    transaction_id: transactionId,
    updated_by_end_id: end.id,
    updated_by_end_type: end.type
  });
}

function enqueueUpsertResource(db, userId, descriptor, end, deleted = false) {
  const row = readResourceRow(db, userId, descriptor.resource);
  enqueueEvent(db, 'account', 'upsert-resource', {
    user_id: userId,
    resource: descriptor.resource,
    resource_data: deleted ? null : parsePayload(row),
    deleted: Boolean(deleted),
    updated_by_end_id: end.id,
    updated_by_end_type: end.type
  });
}

function resourceResponse(descriptor, row) {
  const revision = Number(row?.revision || 0);
  return ok({
    resource: descriptor.resource,
    feature: descriptor.feature,
    merge: descriptor.merge,
    revision,
    contentHash: String(row?.content_hash || ''),
    updatedAt: String(row?.updated_at || ''),
    updatedByEndId: String(row?.updated_by_end_id || ''),
    updatedByEndType: String(row?.updated_by_end_type || ''),
    deleted: Boolean(row?.deleted),
    data: parsePayload(row)
  }, { etag: `"${revision}"`, 'x-resource-revision': String(revision) });
}

function writeResultResponse(descriptor, result) {
  if (result.conflict) {
    return { status: 409, body: {
      error: 'REVISION_MISMATCH',
      message: '该功能的云端数据已更新，请合并后重试',
      resource: descriptor.resource,
      merge: descriptor.merge,
      currentRevision: result.currentRevision,
      updatedAt: result.updatedAt,
      contentHash: result.contentHash,
      data: result.data
    }, headers: baseHeaders };
  }
  const revision = Number(result.revision || 0);
  return ok({
    resource: descriptor.resource,
    feature: descriptor.feature,
    revision,
    updatedAt: result.updatedAt,
    contentHash: result.contentHash,
    bytes: result.bytes ?? 0,
    itemCount: result.itemCount ?? 0,
    unchanged: Boolean(result.unchanged),
    deleted: Boolean(result.deleted)
  }, { etag: `"${revision}"`, 'x-resource-revision': String(revision) });
}

function readCombinedManifest(db, userId) {
  const resources = readManifest(db, userId);
  const transaction = readTransactionManifest(db, userId);
  return resources.map((item) => item.resource === HOLDINGS_LEDGER_RESOURCE ? transaction : item);
}

function handleManifest(db, userId) {
  const resources = readCombinedManifest(db, userId);
  const migration = readMigration(db, userId);
  const legacy = readLegacyBackupMeta(db, userId);
  const populated = resources.filter((item) => item.revision > 0 && !item.deleted);
  return ok({
    username: userId,
    serverTime: nowIso(),
    resourceCount: populated.length,
    resources,
    migration: { ...migration, legacy }
  });
}

function handleBundle(db, userId, url) {
  const requested = String(url.searchParams.get('resources') || '').split(',').map((item) => item.trim()).filter(Boolean);
  const descriptors = requested.length
    ? requested.map((name) => getResourceDescriptor(name)).filter(Boolean)
    : listResourceDescriptors();
  if (requested.length && descriptors.length !== requested.length) {
    throw new HttpError(400, 'UNKNOWN_RESOURCE', '存在未知的资源名');
  }
  const rows = readAllResourceRows(db, userId);
  const payload = {};
  for (const descriptor of descriptors) {
    if (descriptor.resource === HOLDINGS_LEDGER_RESOURCE) {
      const meta = readTransactionManifest(db, userId);
      const envelope = readLegacyTransactionEnvelope(db, userId);
      if (meta.revision > 0) {
        payload[descriptor.resource] = {
          revision: meta.revision,
          updatedAt: meta.updatedAt,
          contentHash: meta.contentHash,
          data: envelope
        };
      }
      continue;
    }
    const row = rows.get(descriptor.resource);
    if (!row || row.deleted || descriptor.resource === 'holdings/position-snapshot') continue;
    payload[descriptor.resource] = {
      revision: Number(row.revision || 0),
      updatedAt: String(row.updated_at || ''),
      contentHash: String(row.content_hash || ''),
      data: parsePayload(row)
    };
  }
  return ok({ serverTime: nowIso(), resources: payload });
}

function handleExportEnvelope(db, userId) {
  const rows = readAllResourceRows(db, userId);
  const payload = {};
  const transactionMeta = readTransactionManifest(db, userId);
  const transactionEnvelope = readLegacyTransactionEnvelope(db, userId);
  if (transactionMeta.revision > 0 && transactionEnvelope.transactions.length) {
    payload.aiDcaFundHoldingsLedger = JSON.stringify(transactionEnvelope);
  }
  for (const descriptor of listResourceDescriptors()) {
    if (descriptor.resource === HOLDINGS_LEDGER_RESOURCE || descriptor.resource === 'holdings/position-snapshot') continue;
    const row = rows.get(descriptor.resource);
    if (!row || row.deleted) continue;
    const data = parsePayload(row);
    if (data === null || data === undefined) continue;
    payload[descriptor.legacyKey] = JSON.stringify(data);
  }
  const keys = Object.keys(payload).sort();
  return ok({
    version: 1,
    source: 'ai-dca',
    exportedAt: nowIso(),
    keyCount: keys.length,
    keys,
    payload
  });
}

function normalizeMigrationState(migration = {}, legacy = {}) {
  const rawStatus = String(migration?.status || 'pending').trim().toLowerCase();
  const legacyExists = Boolean(legacy?.exists);
  const status = rawStatus === 'pending' && !legacyExists ? 'no-legacy' : rawStatus;
  return {
    ...migration,
    status,
    legacy,
    needsMigration: status === 'pending' && legacyExists
  };
}

function readLegacyMigrationGate(db, userId) {
  const migration = readMigration(db, userId);
  const legacy = readLegacyBackupMeta(db, userId);
  return normalizeMigrationState(migration, legacy);
}

function assertLegacyMigrationSettled(db, userId) {
  const migration = readLegacyMigrationGate(db, userId);
  if (migration.status === 'imported' || migration.status === 'skipped' || migration.status === 'no-legacy') {
    return migration;
  }
  throw new HttpError(409, 'LEGACY_MIGRATION_REQUIRED', '账号旧数据尚未迁移，暂不允许访问新账号资源');
}

function handleMigrationStatus(db, userId) {
  const migration = readLegacyMigrationGate(db, userId);
  const manifest = readCombinedManifest(db, userId);
  const migratedResources = manifest.filter((item) => item.revision > 0 && !item.deleted).map((item) => item.resource);
  return ok({ ...migration, migratedResources });
}

function handleMigrationImport(db, userId, body) {
  const resources = body?.resources && typeof body.resources === 'object' ? body.resources : null;
  if (!resources) throw new HttpError(400, 'RESOURCES_REQUIRED', '缺少 resources 字段');
  const totalBytes = measureBytes(JSON.stringify(resources));
  if (totalBytes > MAX_IMPORT_BYTES) throw new HttpError(413, 'IMPORT_TOO_LARGE', '导入数据过大，请分批迁移');

  const overwrite = Boolean(body?.overwrite);
  const end = endOf(body);
  const endInput = body?.end || {};
  return withTransaction(db, () => {
    const existing = readAllResourceRows(db, userId);
    const imported = [];
    const skipped = [];
    const rejected = [];

    for (const [name, value] of Object.entries(resources)) {
      const descriptor = getResourceDescriptor(name);
      if (!descriptor) {
        rejected.push({ resource: name, code: 'UNKNOWN_RESOURCE' });
        continue;
      }
      if (descriptor.resource === HOLDINGS_LEDGER_RESOURCE) {
        const result = importLegacyTransactions(db, userId, value, { end: endInput, overwrite });
        const meta = readTransactionManifest(db, userId);
        for (const item of result.imported) enqueueUpsertTransaction(db, userId, item.id, end);
        imported.push({ resource: descriptor.resource, revision: meta.revision, itemCount: result.importedCount });
        skipped.push(...result.skipped.map((id) => ({ resource: descriptor.resource, id })));
        rejected.push(...result.rejected.map((item) => ({ resource: descriptor.resource, ...item })));
        continue;
      }
      if (descriptor.resource === 'holdings/position-snapshot') {
        skipped.push({ resource: descriptor.resource, reason: 'deprecated_snapshot' });
        continue;
      }
      const current = existing.get(descriptor.resource);
      if (!overwrite && current && !current.deleted && Number(current.revision || 0) > 0) {
        skipped.push({ resource: descriptor.resource, reason: 'exists' });
        continue;
      }
      const validation = validateResourcePayload(descriptor, value);
      if (!validation.ok) {
        rejected.push({ resource: descriptor.resource, code: validation.code, message: validation.message });
        continue;
      }
      const result = writeResource(db, userId, descriptor, {
        data: value,
        serialized: validation.serialized,
        force: true,
        end: endInput
      });
      if (!result.conflict && !result.unchanged) enqueueUpsertResource(db, userId, descriptor, end);
      imported.push({ resource: descriptor.resource, revision: result.revision, unchanged: Boolean(result.unchanged) });
    }

    const migration = writeMigration(db, userId, {
      status: 'imported',
      source: String(body?.source || 'client-decrypt').slice(0, 60),
      legacyVersion: Number(body?.legacyVersion || 0),
      importedResources: imported.length,
      note: String(body?.note || '')
    });
    return ok({ migration, imported, skipped, rejected });
  });
}

function handleMigrationSkip(db, userId, body) {
  const migration = writeMigration(db, userId, {
    status: 'skipped',
    source: String(body?.source || 'local-fresh').slice(0, 60),
    legacyVersion: Number(body?.legacyVersion || 0),
    importedResources: 0,
    note: String(body?.reason || '用户选择用本机数据重新开始，旧密文保留')
  });
  return ok({ migration });
}

function handleHoldingsLedgerResourceRequest(db, userId, method, body) {
  if (method === 'GET') {
    const resource = readTransactionManifest(db, userId);
    const rows = readTransactionRows(db, userId, { limit: 1000 });
    return ok({ resource: HOLDINGS_LEDGER_RESOURCE, ...resource, data: { transactions: rows.map((item) => item.data), snapshotsByCode: {} } });
  }
  if (method === 'PUT') {
    const end = endOf(body);
    const summary = withTransaction(db, () => {
      const result = importLegacyTransactions(db, userId, body?.data ?? body, {
        end: body?.end || {},
        overwrite: Boolean(body?.force)
      });
      for (const item of result.imported) enqueueUpsertTransaction(db, userId, item.id, end);
      return result;
    });
    const resource = readTransactionManifest(db, userId);
    return ok({ resource: HOLDINGS_LEDGER_RESOURCE, ...resource, imported: summary.imported, skipped: summary.skipped, rejected: summary.rejected });
  }
  if (method === 'DELETE') {
    const end = endOf(body);
    withTransaction(db, () => {
      const rows = readTransactionRows(db, userId, { limit: 1000 });
      for (const item of rows) {
        const result = deleteTransactionRow(db, userId, item.id, { force: true, end: body?.end || {} });
        if (result.deleted) enqueueDeleteTransaction(db, userId, item.id, end);
      }
    });
    return ok({ resource: HOLDINGS_LEDGER_RESOURCE, ...readTransactionManifest(db, userId), deleted: true });
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
}

function transactionItemResponse(result, id = '') {
  if (result.conflict) {
    return { status: 409, body: {
      error: 'REVISION_MISMATCH',
      message: '该交易行已在其他设备更新，请重新合并后重试',
      resource: HOLDINGS_LEDGER_RESOURCE,
      id,
      currentRevision: result.currentRevision,
      current: result.current,
      resourceMeta: result.resource
    }, headers: baseHeaders };
  }
  const row = result.transaction || null;
  const rowRevision = Number(result.rowRevision || row?.revision || 0);
  return ok({
    resource: HOLDINGS_LEDGER_RESOURCE,
    id: id || row?.id || '',
    rowRevision,
    transaction: row,
    contentHash: String(result.contentHash || ''),
    deleted: Boolean(result.deleted),
    unchanged: Boolean(result.unchanged),
    resourceMeta: result.resource
  }, { etag: `"${rowRevision}"` });
}

function handleHoldingTransactionCollection(db, userId, method, url) {
  if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '交易行集合只支持 GET');
  const resource = readTransactionManifest(db, userId);
  const rows = readTransactionRows(db, userId, {
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('cursor')
  });
  const offset = Math.max(Number(url.searchParams.get('cursor') || 0), 0);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 1000);
  return ok({
    resource: HOLDINGS_LEDGER_RESOURCE,
    ...resource,
    rows,
    nextCursor: rows.length >= limit ? String(offset + rows.length) : ''
  });
}

function handleHoldingTransactionItem(db, userId, method, headers, body, route) {
  const id = String(route.itemId || '').trim();
  const current = readTransactionRow(db, userId, id);
  if (method === 'GET') {
    if (!current || Number(current.deleted || 0) === 1) throw new HttpError(404, 'ITEM_NOT_FOUND', '交易行不存在');
    let data = null;
    try { data = JSON.parse(String(current.payload || 'null')); } catch { data = null; }
    return ok({ resource: HOLDINGS_LEDGER_RESOURCE, id, revision: Number(current.revision || 0), data }, { etag: `"${Number(current.revision || 0)}"` });
  }
  if (method === 'PUT' || method === 'PATCH') {
    const data = body?.data ?? body?.item ?? body;
    const end = endOf(body);
    const result = withTransaction(db, () => {
      const r = writeTransactionRow(db, userId, id, data, {
        expectedRevision: readExpectedRevision(headers, body),
        force: Boolean(body?.force),
        end: body?.end || {}
      });
      if (!r.invalid && !r.conflict && !r.unchanged) enqueueUpsertTransaction(db, userId, id, end);
      return r;
    });
    if (result.invalid) throw new HttpError(400, result.code, '交易行数据无效');
    return transactionItemResponse(result, id);
  }
  if (method === 'DELETE') {
    const end = endOf(body);
    const result = withTransaction(db, () => {
      const r = deleteTransactionRow(db, userId, id, {
        expectedRevision: readExpectedRevision(headers, body),
        force: Boolean(body?.force),
        end: body?.end || {}
      });
      if (r.deleted) enqueueDeleteTransaction(db, userId, id, end);
      return r;
    });
    return transactionItemResponse(result, id);
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
}

function handleResourceRequest(db, userId, method, headers, body, route, url) {
  const { descriptor } = route;
  if (descriptor.resource === HOLDINGS_LEDGER_RESOURCE) {
    return handleHoldingsLedgerResourceRequest(db, userId, method, body);
  }
  if (method === 'GET') {
    if (url.searchParams.get('history') === '1') {
      const history = readHistory(db, userId, descriptor.resource, url.searchParams.get('limit'));
      return ok({ resource: descriptor.resource, history });
    }
    const row = readResourceRow(db, userId, descriptor.resource);
    return resourceResponse(descriptor, row);
  }
  if (method === 'PUT') {
    const validation = validateResourcePayload(descriptor, body?.data);
    if (!validation.ok) throw new HttpError(400, validation.code, validation.message);
    const end = endOf(body);
    const result = withTransaction(db, () => {
      const r = writeResource(db, userId, descriptor, {
        data: body.data,
        serialized: validation.serialized,
        expectedRevision: readExpectedRevision(headers, body),
        force: Boolean(body?.force),
        end: body?.end || {}
      });
      if (!r.conflict && !r.unchanged) enqueueUpsertResource(db, userId, descriptor, end);
      return r;
    });
    return writeResultResponse(descriptor, result);
  }
  if (method === 'PATCH') {
    const row = readResourceRow(db, userId, descriptor.resource);
    const expectedRevision = readExpectedRevision(headers, body);
    if (expectedRevision !== null && expectedRevision !== Number(row?.revision || 0)) {
      return writeResultResponse(descriptor, {
        conflict: true,
        currentRevision: Number(row?.revision || 0),
        updatedAt: String(row?.updated_at || ''),
        contentHash: String(row?.content_hash || ''),
        data: parsePayload(row)
      });
    }
    const patched = applyResourcePatch(descriptor, parsePayload(row), body?.patch || body);
    const validation = validateResourcePayload(descriptor, patched.data);
    if (!validation.ok) throw new HttpError(400, validation.code, validation.message);
    const end = endOf(body);
    const result = withTransaction(db, () => {
      const r = writeResource(db, userId, descriptor, {
        data: patched.data,
        serialized: validation.serialized,
        force: true,
        end: body?.end || {}
      });
      if (!r.conflict && !r.unchanged) enqueueUpsertResource(db, userId, descriptor, end);
      return r;
    });
    return writeResultResponse(descriptor, result);
  }
  if (method === 'DELETE') {
    const end = endOf(body);
    const result = withTransaction(db, () => {
      const r = writeResource(db, userId, descriptor, { deleted: true, force: true });
      if (!r.conflict && !r.unchanged) enqueueUpsertResource(db, userId, descriptor, end, true);
      return r;
    });
    return writeResultResponse(descriptor, { ...result, deleted: true });
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
}

function resourceRecordResponse(descriptor, id, result) {
  if (result.conflict) {
    // NOTE: duplicate `resource` key is intentional, matching the worker:
    // the second (metadata object, serialized to the resource name via toJSON) wins.
    return { status: 409, body: {
      error: 'REVISION_MISMATCH',
      message: '该记录已在其他设备更新，请合并后重试',
      resource: descriptor.resource,
      id,
      currentRevision: result.currentRevision,
      current: result.current,
      resource: result.resource
    }, headers: baseHeaders };
  }
  if (result.notFound) throw new HttpError(404, 'ITEM_NOT_FOUND', '记录不存在');
  const record = result.record || null;
  const resourceRevision = Number(result.resource?.revision || 0);
  const recordRevision = Number(result.recordRevision || record?.revision || 0);
  return ok({
    resource: descriptor.resource,
    id,
    revision: recordRevision,
    recordRevision,
    resourceRevision,
    data: record?.data ?? null,
    deleted: Boolean(result.deleted),
    unchanged: Boolean(result.unchanged),
    contentHash: String(record?.contentHash || '')
  }, { etag: `"${recordRevision}"` });
}

function handleResourceItemRequest(db, userId, method, headers, body, route) {
  if (route.descriptor.resource === HOLDINGS_LEDGER_RESOURCE) return handleHoldingTransactionItem(db, userId, method, headers, body, route);
  const { descriptor, itemId } = route;
  if (method === 'GET') {
    const record = readResourceRecord(db, userId, descriptor, itemId);
    if (!record || record.deleted) throw new HttpError(404, 'ITEM_NOT_FOUND', '记录不存在');
    return ok({
      resource: descriptor.resource,
      id: record.id,
      revision: record.revision,
      parentId: record.parentId,
      kind: record.kind,
      position: record.position,
      data: record.data
    }, { etag: `"${record.revision}"` });
  }
  if (method === 'PUT' || method === 'PATCH') {
    const current = readResourceRecord(db, userId, descriptor, itemId);
    let data = body?.item ?? body?.data;
    if (method === 'PATCH' && body?.patch) {
      const patched = applyResourcePatch(descriptor, current?.data, body.patch);
      data = patched.data;
    }
    if (data === undefined) throw new HttpError(400, 'PAYLOAD_REQUIRED', '缺少记录数据');
    let serialized;
    try { serialized = JSON.stringify(data); } catch { serialized = undefined; }
    if (serialized === undefined) throw new HttpError(400, 'PAYLOAD_UNSERIALIZABLE', '记录无法序列化为 JSON');
    if (measureBytes(serialized) > MAX_RESOURCE_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '单条记录过大');
    const end = endOf(body);
    const result = withTransaction(db, () => {
      const r = writeResourceRecord(db, userId, descriptor, itemId, data, {
        parentId: body?.parentId ?? current?.parentId ?? '',
        kind: body?.kind ?? current?.kind ?? 'item',
        position: body?.position ?? current?.position ?? 0,
        expectedRevision: readExpectedRevision(headers, body),
        force: Boolean(body?.force),
        end: body?.end || {}
      });
      if (!r.conflict && !r.unchanged && !r.notFound) enqueueUpsertResource(db, userId, descriptor, end);
      return r;
    });
    return resourceRecordResponse(descriptor, itemId, result);
  }
  if (method === 'DELETE') {
    const end = endOf(body);
    const result = withTransaction(db, () => {
      const r = deleteResourceRecord(db, userId, descriptor, itemId, {
        expectedRevision: readExpectedRevision(headers, body),
        force: Boolean(body?.force),
        end: body?.end || {}
      });
      if (r.deleted) enqueueUpsertResource(db, userId, descriptor, end);
      return r;
    });
    return resourceRecordResponse(descriptor, itemId, result);
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
}

function handleDataNotice(db, method, url, body) {
  if (method !== 'GET' && method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET 或 PUT');
  const userId = requireUserId(url, body);
  if (method === 'GET') return ok(readAccountDataNotice(db, userId));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  try {
    const dataNotice = writeAccountDataNotice(db, userId, {
      noticeVersion: body.noticeVersion || ACCOUNT_DATA_NOTICE_VERSION,
      choice: body.choice
    });
    return ok(dataNotice);
  } catch (error) {
    const invalid = ['INVALID_NOTICE_CHOICE', 'NOTICE_VERSION_REQUIRED'].includes(error?.code);
    console.error('[cn-data account] data notice failed', error);
    throw new HttpError(invalid ? 400 : 500, error?.code || 'DATA_NOTICE_FAILED', invalid ? error.message : '账号选择保存失败，请稍后重试');
  }
}

function handleDiscard(db, url, body) {
  const userId = requireUserId(url, body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  if (body.confirmation !== ACCOUNT_PURGE_CONFIRMATION) {
    throw new HttpError(400, 'CONFIRMATION_REQUIRED', '请确认永久删除全部同步数据');
  }
  try {
    const result = withTransaction(db, () => {
      const purged = purgeAccountData(db, userId);
      const migration = writeMigration(db, userId, {
        status: 'skipped',
        source: String(body.source || 'user-discard-all').slice(0, 60),
        legacyVersion: 0,
        importedResources: 0,
        note: `用户于 ${nowIso()} 主动删除旧密文、新资源及历史版本`
      });
      const dataNotice = writeAccountDataNotice(db, userId, {
        noticeVersion: ACCOUNT_DATA_NOTICE_VERSION,
        choice: 'clear'
      });
      return { purged, migration, dataNotice };
    });
    return ok({
      ok: true,
      username: userId,
      migration: result.migration,
      dataNotice: result.dataNotice,
      purged: {
        kvDeleted: result.purged.kvDeleted,
        deletedRows: result.purged.deletedRows,
        tableChanges: result.purged.tableChanges
      }
    });
  } catch (error) {
    console.error('[cn-data account] discard failed', error);
    throw new HttpError(500, 'DISCARD_FAILED', '数据删除未完成，请稍后重试');
  }
}

// Returns { status, body, headers? } or null when the path is not under /api/account/v1/*.
export function handleAccountV1Route(db, method, url, body = {}, headers = {}) {
  const pathname = String(url.pathname || '');
  if (pathname !== '/api/account/v1' && !pathname.startsWith('/api/account/v1/')) return null;
  try {
    const route = parseRequestPath(pathname);
    if (route.kind === 'unknown' || route.kind === 'root') {
      return { status: 404, body: { error: 'NOT_FOUND', message: '接口不存在' }, headers: baseHeaders };
    }
    if (route.kind === 'health') {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
      return ok({ ok: true, service: 'ai-dca-account', encryption: 'none', time: nowIso() });
    }
    if (route.kind === 'discard') {
      if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
      return handleDiscard(db, url, body);
    }
    if (route.kind === 'data-notice') {
      return handleDataNotice(db, method, url, body);
    }
    // migrations/legacy 是账号资源的唯一门禁。迁移查询/导入/跳过之外，
    // manifest、bundle、资源与交易行接口都必须在服务端再次确认已 settled。
    const userId = requireUserId(url, body);
    if (route.kind !== 'migration' && route.kind !== 'migration-skip') {
      assertLegacyMigrationSettled(db, userId);
    }
    if (route.kind === 'manifest') {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
      return handleManifest(db, userId);
    }
    if (route.kind === 'bundle') {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
      return handleBundle(db, userId, url);
    }
    if (route.kind === 'export-envelope') {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
      return handleExportEnvelope(db, userId);
    }
    if (route.kind === 'migration') {
      if (method === 'GET') return handleMigrationStatus(db, userId);
      if (method === 'POST') return handleMigrationImport(db, userId, body);
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
    }
    if (route.kind === 'migration-skip') {
      if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
      return handleMigrationSkip(db, userId, body);
    }
    if (route.kind === 'holding-transaction-items') return handleHoldingTransactionCollection(db, userId, method, url);
    if (route.kind === 'resource') return handleResourceRequest(db, userId, method, headers, body, route, url);
    if (route.kind === 'resource-item') return handleResourceItemRequest(db, userId, method, headers, body, route);
    return { status: 404, body: { error: 'NOT_FOUND', message: '接口不存在' }, headers: baseHeaders };
  } catch (error) {
    return fail(error);
  }
}
