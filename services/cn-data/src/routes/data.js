import { createHash } from 'node:crypto';
import { nowIso, withTransaction } from '../db.js';
import { enqueueEvent } from '../outbox.js';

export function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }
export function required(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw badRequest(`${name} is required (1–200 characters)`);
  return value.trim();
}
function payloadOf(body) {
  if (!Object.hasOwn(body, 'payload')) throw badRequest('payload is required');
  return JSON.stringify(body.payload);
}
function flag(value, name, fallback) {
  if (value === undefined) return fallback;
  if (![true, false, 0, 1].includes(value)) throw badRequest(`${name} must be boolean or 0/1`);
  return Number(value);
}
const decode = (row) => row ? { ...row, payload: JSON.parse(row.payload) } : null;
function write(db, target, type, fn) {
  return withTransaction(db, () => {
    const row = fn();
    enqueueEvent(db, target, type, decode(row));
    return decode(row);
  });
}

export function handleDataRoute(db, method, url, body) {
  const path = url.pathname;
  const query = url.searchParams;
  const known = ['/api/notify/rules', '/api/notify/configs', '/api/account/transactions', '/api/account/resources', '/api/sync/backup'];
  const deletingRule = path.startsWith('/api/notify/rules/');
  if (!known.includes(path) && !deletingRule) return null;
  const allowed = deletingRule ? ['DELETE'] : path === '/api/sync/backup' ? ['GET', 'PUT'] : ['GET', 'POST'];
  if (!allowed.includes(method)) return { status: 405, body: { message: 'Method not allowed' } };
  // TODO: derive user_id from the auth-service session verified by nginx,
  // instead of trusting query/body identity, before exposing these APIs publicly.
  const queryUser = query.get('user_id');
  if (queryUser && body.user_id && queryUser !== body.user_id) throw badRequest('Conflicting user_id');
  const user = required(body.user_id ?? queryUser, 'user_id');
  const now = nowIso();
  if (deletingRule) {
    let id;
    try { id = required(decodeURIComponent(path.slice('/api/notify/rules/'.length)), 'rule_id'); }
    catch { throw badRequest('Invalid rule_id'); }
    const client = body.client_id ?? query.get('client_id') ?? '';
    if (typeof client !== 'string' || client.length > 200) throw badRequest('Invalid client_id');
    withTransaction(db, () => {
      db.prepare('DELETE FROM notify_rules WHERE user_id = ? AND client_id = ? AND rule_id = ?').run(user, client, id);
      enqueueEvent(db, 'notify', 'delete-rule', { user_id: user, client_id: client, rule_id: id, updated_at: now });
    });
    return { body: { ok: true } };
  }
  if (path === '/api/notify/rules') {
    if (method === 'GET') {
      const client = query.get('client_id');
      const rows = client === null
        ? db.prepare('SELECT * FROM notify_rules WHERE user_id = ? ORDER BY client_id, rule_id').all(user)
        : db.prepare('SELECT * FROM notify_rules WHERE user_id = ? AND client_id = ? ORDER BY rule_id').all(user, client);
      return { body: { rules: rows.map(decode) } };
    }
    const id = required(body.rule_id, 'rule_id');
    const type = required(body.rule_type, 'rule_type');
    const client = body.client_id === undefined ? '' : body.client_id;
    if (typeof client !== 'string' || client.length > 200) throw badRequest('Invalid client_id');
    const payload = payloadOf(body);
    const enabled = flag(body.enabled, 'enabled', 1);
    const row = write(db, 'notify', 'upsert-rule', () => {
      db.prepare(`INSERT INTO notify_rules(user_id, client_id, rule_id, rule_type, payload, enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, client_id, rule_id) DO UPDATE SET
        rule_type = excluded.rule_type, payload = excluded.payload, enabled = excluded.enabled, updated_at = excluded.updated_at`)
        .run(user, client, id, type, payload, enabled, now);
      return db.prepare('SELECT * FROM notify_rules WHERE user_id = ? AND client_id = ? AND rule_id = ?').get(user, client, id);
    });
    return { body: { rule: row } };
  }
  if (path === '/api/notify/configs') {
    if (method === 'GET') {
      const key = query.get('config_key');
      const rows = key === null ? db.prepare('SELECT * FROM notify_configs WHERE user_id = ? ORDER BY config_key').all(user)
        : db.prepare('SELECT * FROM notify_configs WHERE user_id = ? AND config_key = ?').all(user, key);
      return { body: { configs: rows.map(decode) } };
    }
    const key = required(body.config_key, 'config_key');
    const payload = payloadOf(body);
    return { body: { config: write(db, 'notify', 'upsert-config', () => {
      db.prepare(`INSERT INTO notify_configs(user_id, config_key, payload, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, config_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`).run(user, key, payload, now);
      return db.prepare('SELECT * FROM notify_configs WHERE user_id = ? AND config_key = ?').get(user, key);
    }) } };
  }
  if (path === '/api/account/transactions' || path === '/api/account/resources') {
    const transactions = path === '/api/account/transactions';
    if (method === 'GET') {
      const rows = transactions
        ? db.prepare('SELECT * FROM account_holdings_transactions WHERE user_id = ? AND deleted = 0 ORDER BY updated_at, transaction_id').all(user)
        : db.prepare('SELECT * FROM account_resources WHERE user_id = ? AND deleted = 0 ORDER BY resource').all(user);
      return { body: transactions ? { transactions: rows.map(decode) } : { resources: rows.map(decode) } };
    }
    const id = required(transactions ? body.transaction_id : body.resource, transactions ? 'transaction_id' : 'resource');
    const feature = transactions ? '' : required(body.feature, 'feature');
    const deleted = flag(body.deleted, 'deleted', 0);
    const payload = deleted ? 'null' : payloadOf(body);
    if (transactions && Buffer.byteLength(payload) > 64 * 1024) throw Object.assign(new Error('Transaction payload too large'), { status: 413 });
    const hash = deleted ? '' : createHash('sha256').update(payload).digest('hex');
    const bytes = deleted ? 0 : Buffer.byteLength(payload);
    const endId = body.updated_by_end_id === undefined ? '' : required(body.updated_by_end_id, 'updated_by_end_id');
    const endType = body.updated_by_end_type === undefined ? '' : required(body.updated_by_end_type, 'updated_by_end_type');
    const count = body.item_count ?? (Array.isArray(body.payload) ? body.payload.length : 1);
    if (!Number.isSafeInteger(count) || count < 0) throw badRequest('Invalid item_count');
    const row = write(db, 'account', transactions ? 'upsert-transaction' : 'upsert-resource', () => {
      const current = transactions
        ? db.prepare('SELECT * FROM account_holdings_transactions WHERE user_id = ? AND transaction_id = ?').get(user, id)
        : db.prepare('SELECT * FROM account_resources WHERE user_id = ? AND resource = ?').get(user, id);
      const revision = (current?.revision ?? 0) + 1;
      if (body.expected_revision !== undefined && body.expected_revision !== (current?.revision ?? 0)) {
        throw Object.assign(new Error('Revision conflict'), { status: 409 });
      }
      if (transactions) {
        db.prepare(`INSERT INTO account_holdings_transactions
          (user_id, transaction_id, revision, content_hash, bytes, payload, deleted, updated_at, updated_by_end_id, updated_by_end_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, transaction_id) DO UPDATE SET
          revision = excluded.revision, content_hash = excluded.content_hash, bytes = excluded.bytes, payload = excluded.payload,
          deleted = excluded.deleted, updated_at = excluded.updated_at, updated_by_end_id = excluded.updated_by_end_id,
          updated_by_end_type = excluded.updated_by_end_type`).run(user, id, revision, hash, bytes, payload, deleted, now, endId, endType);
        return db.prepare('SELECT * FROM account_holdings_transactions WHERE user_id = ? AND transaction_id = ?').get(user, id);
      }
      db.prepare(`INSERT INTO account_resources
        (user_id, resource, feature, revision, content_hash, bytes, item_count, payload, deleted, updated_at, updated_by_end_id, updated_by_end_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, resource) DO UPDATE SET
        feature = excluded.feature, revision = excluded.revision, content_hash = excluded.content_hash,
        bytes = excluded.bytes, item_count = excluded.item_count, payload = excluded.payload,
        deleted = excluded.deleted, updated_at = excluded.updated_at, updated_by_end_id = excluded.updated_by_end_id,
        updated_by_end_type = excluded.updated_by_end_type`).run(user, id, feature, revision, hash, bytes, deleted ? 0 : count, payload, deleted, now, endId, endType);
      return db.prepare('SELECT * FROM account_resources WHERE user_id = ? AND resource = ?').get(user, id);
    });
    return { body: transactions ? { transaction: row } : { resource: row } };
  }
  if (method === 'GET') return { body: { backup: decode(db.prepare('SELECT * FROM sync_backups WHERE user_id = ?').get(user)) } };
  const payload = payloadOf(body);
  return { body: { backup: write(db, 'sync', 'upsert-backup', () => {
    const current = db.prepare('SELECT version FROM sync_backups WHERE user_id = ?').get(user);
    const version = (current?.version ?? 0) + 1;
    if (body.expected_version !== undefined && body.expected_version !== (current?.version ?? 0)) {
      throw Object.assign(new Error('Version conflict'), { status: 409 });
    }
    db.prepare(`INSERT INTO sync_backups(user_id, payload, version, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, version = excluded.version, updated_at = excluded.updated_at`)
      .run(user, payload, version, now);
    return db.prepare('SELECT * FROM sync_backups WHERE user_id = ?').get(user);
  }) } };
}
