import { handleInternalSyncBackup } from './internalSyncBackup.js';
import { handleInternalAuthSync } from './internalAuthSync.js';
import { hashPassword, verifyPassword } from './password.js';
import { buildProbeHtml } from '../../shared/probeHtml.js';
import { enforceAnalyticsRateLimit, pruneExpiredRateCounters } from './analyticsRateLimit.js';

const PROBE_HTML = buildProbeHtml({ analyticsUrl: 'https://api.freebacktrack.tech/api/sync/analytics/track' });

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const ANALYTICS_RETENTION_DAYS = 31;
const ANALYTICS_CLEANUP_BATCH_SIZE = 5000;
const ANALYTICS_CLEANUP_MAX_BATCHES = 12;
const ADMIN_USERNAMES = new Set(['lovexl', 'wanghao0902', 'de88903']);

function isAdminUsername(username = '') {
  return ADMIN_USERNAMES.has(String(username || '').trim().toLowerCase());
}

function corsHeaders(origin = '*') {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400'
  };
}

function json(payload, { status = 200, origin = '*' } = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...corsHeaders(origin), 'content-type': 'application/json; charset=utf-8' }
  });
}

function nowIso() { return new Date().toISOString(); }

export function analyticsRetentionCutoffDate(nowMs = Date.now()) {
  const keepDays = Math.max(1, ANALYTICS_RETENTION_DAYS - 1);
  return new Date(Number(nowMs) - keepDays * 86400000).toISOString().slice(0, 10);
}

export async function pruneOldAnalyticsEvents(env, nowMs = Date.now(), options = {}) {
  const cutoff = analyticsRetentionCutoffDate(nowMs);
  const batchSize = Math.max(
    1,
    Math.min(Number(options.batchSize) || ANALYTICS_CLEANUP_BATCH_SIZE, ANALYTICS_CLEANUP_BATCH_SIZE),
  );
  const maxBatches = Math.max(
    1,
    Math.min(Number(options.maxBatches) || ANALYTICS_CLEANUP_MAX_BATCHES, ANALYTICS_CLEANUP_MAX_BATCHES),
  );
  let deleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < maxBatches) {
    const result = await env.DB.prepare(`DELETE FROM analytics_events
      WHERE id IN (
        SELECT id FROM analytics_events
        WHERE event_date < ?
        ORDER BY event_date ASC, created_at ASC
        LIMIT ?
      )`).bind(cutoff, batchSize).run();
    lastBatchDeleted = Number(result?.meta?.changes) || 0;
    deleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < batchSize) break;
  }

  return {
    cutoff,
    deleted,
    batches,
    hitBatchLimit: batches >= maxBatches && lastBatchDeleted >= batchSize,
  };
}

function normalizeUsername(username = '') {
  return String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 48);
}

function randomId(prefix = '') {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex}`;
}

async function sha256Hex(text = '') {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

async function ensureSchema(env) {
  if (!env.DB) throw new Error('D1 binding DB missing');
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  try {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN password_salt TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // Existing databases may already have this column.
  }
  try {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN last_login_at TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // Existing databases may already have this column.
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sync_events (
    event_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    visitor_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_analytics_events_date_type ON analytics_events (event_date, type)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_rate_counters (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_analytics_rate_counters_expires
    ON analytics_rate_counters (expires_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_analytics_events_date_created ON analytics_events (event_date, created_at DESC)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_daily_stats (
    event_date TEXT PRIMARY KEY,
    pv INTEGER NOT NULL DEFAULT 0,
    switch_runs INTEGER NOT NULL DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_daily_users (
    event_date TEXT NOT NULL,
    identity TEXT NOT NULL,
    is_visitor_only INTEGER NOT NULL DEFAULT 0,
    has_page_view INTEGER NOT NULL DEFAULT 0,
    has_page_engagement INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_date, identity)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_analytics_daily_users_date_flags
    ON analytics_daily_users (event_date, has_page_view, has_page_engagement)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS backups (
    user_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    kv_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    key_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT ''
  )`).run();
  for (const alter of [
    "ALTER TABLE backups ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE backups ADD COLUMN envelope TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE backups ADD COLUMN cipher_sha256 TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE backups ADD COLUMN last_end_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE backups ADD COLUMN last_end_type TEXT NOT NULL DEFAULT ''"
  ]) {
    try {
      await env.DB.prepare(alter).run();
    } catch {
      // 现有表可能已存在该列。
    }
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS backup_versions (
    user_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kv_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    key_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    envelope TEXT NOT NULL DEFAULT '',
    cipher_sha256 TEXT NOT NULL DEFAULT '',
    last_end_id TEXT NOT NULL DEFAULT '',
    last_end_type TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, version)
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_backup_versions_user_version ON backup_versions (user_id, version DESC)').run();
}

async function createSession(env, user) {
  const accessToken = randomId('acc_');
  const refreshToken = randomId('ref_');
  const tokenHash = await sha256Hex(accessToken);
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, user.id, nowIso(), expires).run();
  return { userId: user.id, username: user.username, accessToken, refreshToken, expiresAt: expires, isAdmin: isAdminUsername(user.username) };
}

async function requireUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT users.id, users.username
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .bind(tokenHash, nowIso()).first();
  return row || null;
}

function analyticsEventIdentity(event = {}) {
  return String(event.userId || event.visitorId || '').trim();
}

export async function updateDailyAnalyticsAggregate(env, events = []) {
  const dailyStats = new Map();
  const dailyUsers = new Map();
  for (const event of events) {
    const date = String(event.date || event.createdAt || nowIso()).slice(0, 10);
    const type = String(event.type || '');
    const stats = dailyStats.get(date) || { pv: 0, switchRuns: 0 };
    if (type === 'page_view') stats.pv += 1;
    if (type === 'switch_worker_run') stats.switchRuns += 1;
    dailyStats.set(date, stats);
    const identity = analyticsEventIdentity(event);
    if (!identity) continue;
    const key = date + ' ' + identity;
    const user = dailyUsers.get(key) || { date, identity, isVisitorOnly: 0, hasPageView: 0, hasPageEngagement: 0 };
    if (type === 'page_view') user.hasPageView = 1;
    if (type === 'page_engagement') user.hasPageEngagement = 1;
    if (!event.userId && event.visitorId) user.isVisitorOnly = 1;
    dailyUsers.set(key, user);
  }
  const statements = [];
  for (const [date, stats] of dailyStats) {
    statements.push(env.DB.prepare(`INSERT INTO analytics_daily_stats (event_date, pv, switch_runs) VALUES (?, ?, ?)
      ON CONFLICT(event_date) DO UPDATE SET pv = pv + excluded.pv, switch_runs = switch_runs + excluded.switch_runs`).bind(date, stats.pv, stats.switchRuns));
  }
  for (const user of dailyUsers.values()) {
    statements.push(env.DB.prepare(`INSERT INTO analytics_daily_users (event_date, identity, is_visitor_only, has_page_view, has_page_engagement) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_date, identity) DO UPDATE SET
        is_visitor_only = MAX(is_visitor_only, excluded.is_visitor_only),
        has_page_view = MAX(has_page_view, excluded.has_page_view),
        has_page_engagement = MAX(has_page_engagement, excluded.has_page_engagement)
    `).bind(user.date, user.identity, user.isVisitorOnly, user.hasPageView, user.hasPageEngagement));
  }
  if (!statements.length) return;
  if (typeof env.DB.batch === 'function') {
    await env.DB.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}


async function handleTrackAnalytics(request, env, origin) {
  const body = await readBody(request);
  const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : [body];
  // 先归一化，再限流，最后写入：超限请求不得落任何事件。
  const normalizedEvents = [];
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const id = String(rawEvent.id || randomId('evt_')).slice(0, 96);
    const type = String(rawEvent.type || '').trim().slice(0, 64);
    if (!type) continue;
    if (type === 'network_trace' && rawEvent.meta && typeof rawEvent.meta === 'object') {
      const meta = { ...rawEvent.meta };
      if (!meta.ip) meta.ip = request.headers.get('cf-connecting-ip') || '';
      if (!meta.colo) meta.colo = request.cf?.colo || '';
      if (!meta.loc) meta.loc = request.cf?.country || '';
      rawEvent.meta = meta;
    }
    const createdAt = String(rawEvent.createdAt || nowIso()).slice(0, 40);
    const eventDate = String(rawEvent.date || createdAt.slice(0, 10) || nowIso().slice(0, 10)).slice(0, 10);
    normalizedEvents.push({
      id,
      type,
      createdAt,
      date: eventDate,
      userId: String(rawEvent.userId || '').slice(0, 96),
      username: normalizeUsername(rawEvent.username || ''),
      visitorId: String(rawEvent.visitorId || '').slice(0, 120),
      sessionId: String(rawEvent.sessionId || '').slice(0, 120),
      path: String(rawEvent.path || '').slice(0, 500),
      meta: JSON.stringify(rawEvent.meta || {}).slice(0, 4000)
    });
  }
  if (!normalizedEvents.length) return json({ message: 'missing event type' }, { status: 400, origin });

  const rate = await enforceAnalyticsRateLimit(env, request, normalizedEvents.length);
  if (rate.limited) {
    return new Response(JSON.stringify({
      message: '上报过于频繁，请稍后再试',
      error: 'RATE_LIMITED',
      limit: rate.limit,
      used: rate.used
    }), {
      status: 429,
      headers: {
        ...corsHeaders(origin),
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(rate.retryAfter)
      }
    });
  }

  let accepted = 0;
  const acceptedEvents = [];
  for (const normalizedEvent of normalizedEvents) {
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO analytics_events
      (id, type, user_id, username, visitor_id, session_id, path, event_date, created_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        normalizedEvent.id,
        normalizedEvent.type,
        normalizedEvent.userId,
        normalizedEvent.username,
        normalizedEvent.visitorId,
        normalizedEvent.sessionId,
        normalizedEvent.path,
        normalizedEvent.date,
        normalizedEvent.createdAt,
        normalizedEvent.meta
      ).run();
    accepted += 1;
    if (result?.meta?.changes === 0) continue;
    acceptedEvents.push(normalizedEvent);
  }
  if (acceptedEvents.length) await updateDailyAnalyticsAggregate(env, acceptedEvents);
  return json({ ok: true, accepted }, { origin });
}

async function handleAnalyticsGuests(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  if (!isAdminUsername(user.username)) return json({ message: '无管理员权限' }, { status: 403, origin });
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit')?.trim() || 200);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 200;
  const result = await env.DB.prepare(`SELECT identity AS visitorId, MIN(event_date) AS firstSeenDate,
    MAX(event_date) AS lastActiveDate, COUNT(*) AS activeDays
    FROM analytics_daily_users WHERE is_visitor_only = 1
    GROUP BY identity ORDER BY lastActiveDate DESC LIMIT ?`).bind(limit).all();
  return json({ ok: true, available: true, guests: result?.results || [] }, { origin });
}

async function handleRegister(request, env, origin) {
  const body = await readBody(request);
  const username = normalizeUsername(body.username);
  const passwordHash = String(body.passwordHash || '').trim();
  if (username.length < 3) return json({ message: '用户名至少 3 位' }, { status: 400, origin });
  if (passwordHash.length < 32) return json({ message: '密码不合法' }, { status: 400, origin });
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return json({ message: '用户名已存在' }, { status: 409, origin });
  const user = { id: randomId('usr_'), username };
  // PHC 自描述哈希内嵌随机盐；password_salt 列仅为兼容旧 schema 而留空。
  const storedHash = await hashPassword(passwordHash);
  try {
    await env.DB.prepare('INSERT INTO users (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(user.id, username, storedHash, '', nowIso(), nowIso()).run();
  } catch (err) {
    // 高并发下两个请求可能同时通过上面的存在性检查，UNIQUE 约束是最后一道防线。
    if (String(err?.message || '').includes('UNIQUE constraint failed')) {
      return json({ message: '用户名已存在' }, { status: 409, origin });
    }
    throw err;
  }
  return json(await createSession(env, user), { origin });
}

async function handleLogin(request, env, origin) {
  const body = await readBody(request);
  const username = normalizeUsername(body.username);
  const passwordHash = String(body.passwordHash || '').trim();
  const user = await env.DB.prepare('SELECT id, username, password_hash, password_salt FROM users WHERE username = ?').bind(username).first();
  // 新 PHC 走 PBKDF2，存量 hex 走旧 SHA-256；用户不存在与密码错误返回完全一致。
  const credentialOk = user
    ? await verifyPassword(passwordHash, user.password_hash, user.password_salt || '')
    : false;
  if (!user || !credentialOk) return json({ message: '用户名或密码不正确' }, { status: 401, origin });
  const session = await createSession(env, user);
  const meta = await env.DB.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes FROM backups WHERE user_id = ?').bind(user.id).first();
  return json({ ...session, latestBackupMeta: meta || null }, { origin });
}

async function handleMeta(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const meta = await env.DB.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes, content_hash AS contentHash, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').bind(user.id).first();
  return json(meta || { version: null, updatedAt: '', keyCount: 0, bytes: 0, contentHash: '', lastEndId: '', lastEndType: '' }, { origin });
}

async function archiveCurrentBackup(env, user, current) {
  if (!current || !Number.isSafeInteger(Number(current.version)) || Number(current.version) <= 0) return false;
  let encoded = String(current.envelope || '');
  if (!encoded && current.kvKey && env.SYNC_BACKUPS) {
    const stored = await env.SYNC_BACKUPS.get(current.kvKey);
    encoded = stored ? String(stored) : '';
  }
  if (!encoded) return false;
  await env.DB.prepare(`INSERT OR IGNORE INTO backup_versions
    (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256,
     last_end_id, last_end_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(user.id, Number(current.version), String(current.kvKey || `backup:${user.id}`), String(current.updatedAt || nowIso()),
      Number(current.keyCount) || 0, Number(current.bytes) || encoded.length, String(current.contentHash || ''), encoded,
      String(current.cipherSha256 || '') || await sha256Hex(encoded), String(current.lastEndId || ''), String(current.lastEndType || ''), nowIso()).run();
  return true;
}

function backupVersionSummary(row, currentVersion = null, source = 'history') {
  const version = Number(row?.version) || 0;
  return {
    version,
    updatedAt: String(row?.updatedAt || ''),
    keyCount: Number(row?.keyCount) || 0,
    bytes: Number(row?.bytes) || 0,
    contentHash: String(row?.contentHash || ''),
    current: currentVersion != null && version === Number(currentVersion),
    source
  };
}

async function handleGetBackupVersions(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit'));
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const current = await env.DB.prepare(`SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash FROM backups WHERE user_id = ?`).bind(user.id).first();
  const history = await env.DB.prepare(`SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash FROM backup_versions WHERE user_id = ? ORDER BY version DESC LIMIT ?`).bind(user.id, limit).all();
  const currentVersion = current ? Number(current.version) : null;
  const versions = new Map();
  for (const row of history?.results || []) versions.set(Number(row.version), backupVersionSummary(row, currentVersion));
  if (currentVersion != null && currentVersion > 0) versions.set(currentVersion, backupVersionSummary(current, currentVersion, 'current'));
  return json({ currentVersion, versions: [...versions.values()].sort((left, right) => right.version - left.version).slice(0, limit) }, { origin });
}

async function handleRollbackBackupVersion(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const body = await readBody(request);
  const targetVersion = Number(body.version);
  const baseVersion = Number(body.baseVersion);
  if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) return json({ message: '缺少有效的目标版本', code: 'VERSION_REQUIRED' }, { status: 400, origin });
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) return json({ message: '缺少有效的当前版本', code: 'BASE_VERSION_REQUIRED' }, { status: 400, origin });
  const current = await env.DB.prepare(`SELECT version, kv_key AS kvKey, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash, envelope, cipher_sha256 AS cipherSha256, last_end_id AS lastEndId, last_end_type AS lastEndType
    FROM backups WHERE user_id = ?`).bind(user.id).first();
  const currentVersion = Number(current?.version) || 0;
  if (!current) return json({ message: '云端没有可回滚的备份', code: 'BACKUP_NOT_FOUND' }, { status: 404, origin });
  if (currentVersion !== baseVersion) return json({ message: '云端版本已变化，请刷新版本列表后再回滚', code: 'REVISION_MISMATCH', currentVersion }, { status: 409, origin });
  if (targetVersion === currentVersion) return json({ version: currentVersion, unchanged: true }, { origin });
  const target = await env.DB.prepare(`SELECT version, key_count AS keyCount, bytes, content_hash AS contentHash, envelope
    FROM backup_versions WHERE user_id = ? AND version = ?`).bind(user.id, targetVersion).first();
  if (!target?.envelope) return json({ message: '目标版本不存在或不可恢复', code: 'VERSION_NOT_FOUND' }, { status: 404, origin });
  let parsed;
  try { parsed = JSON.parse(String(target.envelope)); } catch { parsed = null; }
  if (!parsed?.ciphertext || parsed.source !== 'ai-dca-secure-sync' || !parsed.crypto) {
    return json({ message: '目标版本密文已损坏，无法回滚', code: 'VERSION_CORRUPTED' }, { status: 409, origin });
  }
  await archiveCurrentBackup(env, user, current);
  const maxVersion = await env.DB.prepare('SELECT MAX(version) AS maxVersion FROM backup_versions WHERE user_id = ?').bind(user.id).first();
  const version = Math.max(currentVersion, Number(maxVersion?.maxVersion) || 0) + 1;
  const encoded = String(target.envelope);
  const updatedAt = nowIso();
  await env.DB.prepare(`UPDATE backups SET version = ?, updated_at = ?, key_count = ?, bytes = ?, content_hash = ?,
    envelope = ?, cipher_sha256 = ?, last_end_id = ?, last_end_type = ? WHERE user_id = ? AND version = ?`)
    .bind(version, updatedAt, Number(target.keyCount) || Number(parsed?.meta?.keyCount) || 0, encoded.length,
      String(target.contentHash || parsed?.meta?.contentHash || ''), encoded, await sha256Hex(encoded), `rollback:v${targetVersion}`, 'version-rollback', user.id, baseVersion).run();
  try { await env.SYNC_BACKUPS.put(String(current.kvKey || `backup:${user.id}`), encoded); } catch { /* D1 是主存储，KV 仅作兼容镜像。 */ }
  return json({ version, updatedAt, rolledBackFrom: targetVersion, keyCount: Number(target.keyCount) || 0, bytes: encoded.length }, { origin });
}

async function handleGetLatest(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const meta = await env.DB.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes, kv_key AS kvKey, envelope, cipher_sha256 AS cipherSha256, content_hash AS contentHash, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').bind(user.id).first();
  if (!meta) return json({ version: null, encryptedEnvelope: null }, { origin });
  let encoded = meta.envelope ? String(meta.envelope) : '';
  let backfilled = false;
  if (!encoded) {
    // 旧行：密文仅在 KV，回退读取并惰性回填进 D1（强一致主存储）。
    const legacy = await env.SYNC_BACKUPS.get(meta.kvKey);
    encoded = legacy ? String(legacy) : '';
    backfilled = Boolean(encoded);
  } else if (meta.cipherSha256) {
    // 校验 D1 内密文完整性：不一致绝不把坏 blob 发给端侧。
    const actual = await sha256Hex(encoded);
    if (actual !== String(meta.cipherSha256)) {
      return json({ message: '云端密文完整性校验失败，请重传备份', code: 'STORAGE_CORRUPTED' }, { status: 409, origin });
    }
  }
  if (!encoded) return json({ version: null, encryptedEnvelope: null }, { origin });
  let encryptedEnvelope = null;
  try {
    encryptedEnvelope = JSON.parse(encoded);
  } catch {
    return json({ message: '云端密文解析失败，请重传备份', code: 'STORAGE_CORRUPTED' }, { status: 409, origin });
  }
  if (backfilled) {
    // 旧 KV blob 回填进 D1 主存储，不改版本，幂等。
    const cipherSha = await sha256Hex(encoded);
    try {
      await env.DB.prepare('UPDATE backups SET envelope = ?, cipher_sha256 = ? WHERE user_id = ?')
        .bind(encoded, cipherSha, user.id).run();
    } catch {
      // 回填失败不影响本次读取。
    }
  }
  return json({
    version: meta.version,
    updatedAt: meta.updatedAt,
    keyCount: meta.keyCount,
    bytes: meta.bytes,
    kvKey: meta.kvKey,
    contentHash: meta.contentHash || '',
    lastEndId: meta.lastEndId || '',
    lastEndType: meta.lastEndType || '',
    encryptedEnvelope
  }, { origin });
}

async function handlePutLatest(request, env, origin) {
  const user = await requireUser(request, env);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const body = await readBody(request);
  const encryptedEnvelope = body.encryptedEnvelope || {};
  if (!encryptedEnvelope.ciphertext || encryptedEnvelope.source !== 'ai-dca-secure-sync') {
    return json({ message: '密文备份格式不合法' }, { status: 400, origin });
  }
  const current = await env.DB.prepare('SELECT version, kv_key AS kvKey, updated_at AS updatedAt, key_count AS keyCount, bytes, content_hash AS contentHash, envelope, cipher_sha256 AS cipherSha256, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').bind(user.id).first();
  const incomingHash = String(encryptedEnvelope?.meta?.contentHash || '');
  // 内容未变化：保持版本号不变，不重写 KV，不报冲突。
  if (current && incomingHash && incomingHash === String(current.contentHash || '')) {
    return json({
      version: Number(current.version),
      updatedAt: current.updatedAt,
      keyCount: Number(current.keyCount) || 0,
      bytes: Number(current.bytes) || 0,
      unchanged: true
    }, { origin });
  }
  // 端标识（登录账号粒度）：username 相同则连续修改只覆盖、不涨版本；不同账号才涨版本。
  const end = body.end && typeof body.end === 'object' ? body.end : {};
  const endId = String(end.id || '').slice(0, 80);
  const endType = String(end.type || '').slice(0, 40);
  const sameEnd = Boolean(current && endId && endId === String(current.lastEndId || ''));
  const baseVersion = body.baseVersion == null ? null : Number(body.baseVersion);
  // 乐观锁仅用于跨账号并发：同端连续写入直接覆盖，不做 baseVersion 校验。
  if (current && !sameEnd && baseVersion !== null && Number(current.version) !== baseVersion) {
    return json({ message: '云端数据已更新，请先处理冲突', currentVersion: current.version }, { status: 409, origin });
  }
  const version = current ? (sameEnd ? Number(current.version) : Number(current.version) + 1) : 1;
  const kvKey = current?.kvKey || `backup:${user.id}`;
  const encoded = JSON.stringify(encryptedEnvelope);
  const cipherSha = await sha256Hex(encoded);
  const updatedAt = nowIso();
  const keyCount = Number(encryptedEnvelope?.meta?.keyCount) || 0;
  // 强一致主存储：密文 BLOB + 完整性校验和 + 版本元数据写入同一 D1 行（单次原子写）。
  if (current) {
    await archiveCurrentBackup(env, user, current);
    await env.DB.prepare('UPDATE backups SET version = ?, updated_at = ?, key_count = ?, bytes = ?, content_hash = ?, envelope = ?, cipher_sha256 = ?, last_end_id = ?, last_end_type = ? WHERE user_id = ?')
      .bind(version, updatedAt, keyCount, encoded.length, incomingHash, encoded, cipherSha, endId, endType, user.id).run();
  } else {
    await env.DB.prepare('INSERT INTO backups (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256, last_end_id, last_end_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(user.id, version, kvKey, updatedAt, keyCount, encoded.length, incomingHash, encoded, cipherSha, endId, endType).run();
  }
  // KV 镜像仅为旧 Worker 回滚兼容（尽力而为，不阻塞、不影响一致性）。
  try {
    await env.SYNC_BACKUPS.put(kvKey, encoded);
  } catch {
    // 镜像失败不影响主存储一致性。
  }
  return json({ version, updatedAt, keyCount, bytes: encoded.length, contentHash: incomingHash, lastEndId: endId, lastEndType: endType, sameEnd }, { origin });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/sync/internal/sync-backup') return handleInternalSyncBackup(request, env, origin, () => ensureSchema(env));
    await ensureSchema(env);
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/api/sync/analytics/track') return handleTrackAnalytics(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/sync/analytics/guests') return handleAnalyticsGuests(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/sync/auth/register') return handleRegister(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/sync/auth/login') return handleLogin(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/sync/internal/sync-auth') return handleInternalAuthSync(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/sync/meta') return handleMeta(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/sync/versions') return handleGetBackupVersions(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/sync/versions/rollback') return handleRollbackBackupVersion(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/sync/latest') return handleGetLatest(request, env, origin);
      if (request.method === 'PUT' && url.pathname === '/api/sync/latest') return handlePutLatest(request, env, origin);
      if (request.method === 'GET' && (url.pathname === '/probe' || url.pathname === '/api/sync/probe')) {
        return new Response(PROBE_HTML, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'access-control-allow-origin': origin,
            'cache-control': 'public, max-age=300'
          }
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/sync/health') return json({ ok: true, service: 'sync', at: nowIso() }, { origin });
      return json({ message: 'not found' }, { status: 404, origin });
    } catch (err) {
      return json({ message: err?.message || 'server error' }, { status: 500, origin });
    }
  },
  async scheduled(controller, env) {
    try {
      await ensureSchema(env);
      const result = await pruneOldAnalyticsEvents(env, Number(controller?.scheduledTime) || Date.now());
      console.log('[sync] analytics retention cleanup', JSON.stringify(result));
      const counters = await pruneExpiredRateCounters(env, Number(controller?.scheduledTime) || Date.now());
      console.log('[sync] analytics rate counter cleanup', JSON.stringify(counters));
    } catch (error) {
      console.log('[sync] analytics retention cleanup failed', JSON.stringify({
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }
};
