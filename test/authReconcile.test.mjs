import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  parseWranglerD1,
  evaluateHealth,
  outboxFindings,
  reconcileUsers,
  reconcileSessions,
  CLAIM_LEASE_MS,
} from '../scripts/auth-reconcile.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE sync_outbox (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL,
      claimed_at TEXT
    );
  `);
  return db;
}

const iso = (ms) => new Date(ms).toISOString();
const codes = (findings) => findings.map((f) => f.code);
const has = (findings, code, severity) => findings.some((f) => f.code === code && (!severity || f.severity === severity));

test('parseWranglerD1 只取 d1_databases 块', () => {
  const toml = `
name = "ai-dca-account"
[[routes]]
pattern = "api.freebacktrack.tech/x"
[[d1_databases]]
binding = "DB"
database_name = "ai-dca-sync-db"
database_id = "b0e5feab-dbcf-4ba7-9f3f-2e5169e8d868"
[[kv_namespaces]]
binding = "SYNC_BACKUPS"
id = "34af9b7435a84b5290e179875d272f27"`;
  assert.deepEqual(parseWranglerD1(toml), {
    binding: 'DB',
    database_name: 'ai-dca-sync-db',
    database_id: 'b0e5feab-dbcf-4ba7-9f3f-2e5169e8d868',
  });
  assert.equal(parseWranglerD1('name = "x"\n'), null);
});

test('evaluateHealth：dead 严重、积压警告、统计分叉警告、干净通过', () => {
  assert.equal(evaluateHealth({ outbox: { pending: 0, processing: 0, dead: 0 } }).length, 0);
  const dead = evaluateHealth({ outbox: { pending: 1, processing: 0, dead: 2 } }, { pendingWarn: 50 });
  assert.ok(has(dead, 'OUTBOX_DEAD', 'critical'));
  const backlog = evaluateHealth({ outbox: { pending: 51, processing: 0, dead: 0 } }, { pendingWarn: 50 });
  assert.ok(has(backlog, 'OUTBOX_BACKLOG', 'warning'));
  const diverge = evaluateHealth(
    { outbox: { pending: 1, processing: 0, dead: 0 } },
    { dbStats: { pending: 2, processing: 0, dead: 0 } }
  );
  assert.ok(has(diverge, 'HEALTH_DIVERGENCE', 'warning'));
  assert.ok(has(evaluateHealth({}), 'HEALTH_SHAPE', 'critical'));
});

test('outboxFindings：死信上报、超租约 processing 与过老 pending 警告', () => {
  const db = makeDb();
  const now = Date.parse('2026-10-27T08:00:00.000Z');
  const insert = (event_id, status, extra = {}) => db.prepare(
    `INSERT INTO sync_outbox (event_id, event_type, payload, status, retry_count, next_attempt_at, created_at, claimed_at, last_error)
     VALUES (?, ?, '{}', ?, ?, ?, ?, ?, ?)`
  ).run(event_id, extra.type || 'user.login', status, extra.retry || 0, iso(now), extra.createdAt || iso(now), extra.claimedAt ?? null, extra.lastError ?? null);

  insert('evt-dead', 'dead', { retry: 5, lastError: 'worker 400: 未知事件' });
  insert('evt-stale', 'processing', { claimedAt: iso(now - CLAIM_LEASE_MS - 60000) });
  insert('evt-fresh', 'processing', { claimedAt: iso(now - 30000) });
  insert('evt-old-pending', 'pending', { createdAt: iso(now - CLAIM_LEASE_MS - 60000) });

  const findings = outboxFindings(db, { now });
  assert.ok(has(findings, 'OUTBOX_DEAD_ROW', 'critical'));
  assert.ok(has(findings, 'OUTBOX_STALE_PROCESSING', 'warning'));
  assert.ok(has(findings, 'OUTBOX_OLDEST_PENDING', 'warning'));
  assert.equal(findings.some((f) => f.message.includes('evt-fresh')), false, '新鲜 processing 不应告警');
  assert.ok(findings.find((f) => f.code === 'OUTBOX_DEAD_ROW').message.includes('worker 400'));
});

test('reconcileUsers：一致通过，缺失/分叉为严重，D1 独有仅 info', () => {
  const local = makeDb(); const remote = makeDb();
  local.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'alice', 'hash-a', 'salt-a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  local.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
    .run('u2', 'bob', 'hash-b', 'salt-b', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  remote.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'alice', 'hash-a', 'salt-a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  // u2 远端缺失；u3 仅远端存在。
  remote.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
    .run('u3', 'carol', 'hash-c', 'salt-c', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');

  const findings = reconcileUsers(local, remote);
  assert.ok(has(findings, 'USER_MISSING_REMOTE', 'critical'));
  assert.ok(has(findings, 'USER_REMOTE_ONLY', 'info'));
  assert.ok(!has(findings, 'USER_CREDENTIAL_MISMATCH'));

  // 补上 u2 但给错凭据 → 凭据分叉。
  remote.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
    .run('u2', 'bob', 'WRONG', 'salt-b', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  const second = reconcileUsers(local, remote);
  assert.ok(has(second, 'USER_CREDENTIAL_MISMATCH', 'critical'));

  // 完全一致时只剩 info 汇总。
  const cleanLocal = makeDb(); const cleanRemote = makeDb();
  cleanLocal.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'alice', 'hash-a', 'salt-a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  cleanRemote.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
    .run('u1', 'alice', 'hash-a', 'salt-a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  assert.equal(reconcileUsers(cleanLocal, cleanRemote).every((f) => f.severity === 'info'), true);
});

test('reconcileSessions：未过期缺失/分叉严重，过期缺失不追究', () => {
  const local = makeDb(); const remote = makeDb();
  const now = Date.parse('2026-10-27T08:00:00.000Z');
  const future = iso(now + 86400000);
  const past = iso(now - 86400000);
  local.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('tok-active', 'u1', iso(now), future);
  local.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('tok-expired', 'u1', iso(now - 2 * 86400000), past);

  const missing = reconcileSessions(local, remote, { now });
  assert.ok(has(missing, 'SESSION_MISSING_REMOTE', 'critical'));
  assert.equal(missing.some((f) => f.message.includes('tok-expired')), false);

  // 远端补齐 active 但 expires_at 被延长 → 分叉。
  remote.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('tok-active', 'u1', iso(now), iso(now + 2 * 86400000));
  const mismatch = reconcileSessions(local, remote, { now });
  assert.ok(has(mismatch, 'SESSION_MISMATCH', 'critical'));

  // 修正为完全一致：无 critical/warning。
  remote.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(future, 'tok-active');
  const clean = reconcileSessions(local, remote, { now });
  assert.equal(clean.every((f) => f.severity === 'info'), true);
});
