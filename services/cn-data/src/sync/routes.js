import { randomBytes } from 'node:crypto';
import { resolveUser, openAuthDb } from '../authSession.js';
import { sha256Hex } from '../account/store.js';
import { nowIso, withTransaction } from '../db.js';
import { PROBE_HTML } from './probeHtml.js';
import { enforceAnalyticsRateLimit } from './analyticsRateLimit.js';

// Worker payloads are preserved; SQLite is the primary storage on CN.
const json = (body, { status = 200, origin = '*', headers = {} } = {}) => ({
  status, body, headers: { 'Access-Control-Allow-Origin': origin, ...headers }
});
const readBody = (request) => request.body;
const randomId = (prefix = '') => prefix + randomBytes(16).toString('hex');
const normalizeUsername = (username = '') => String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 48);
function requireUser(request) {
  try {
    const id = resolveUser(request.rawHeaders, request.urlObject, request.body);
    const auth = openAuthDb();
    if (!auth) return { id, username: '' };
    try {
      const row = auth.prepare('SELECT username FROM users WHERE id = ?').get(id);
      return { id, username: String(row?.username || '') };
    } finally { auth.close(); }
  } catch (error) {
    if ([400, 401, 403].includes(error.status)) return null;
    throw error;
  }
}
function registeredUsers() {
  const auth = openAuthDb();
  if (!auth) return { total: 0 };
  try { return auth.prepare('SELECT COUNT(*) AS total FROM users').get(); }
  finally { auth.close(); }
}
function analyticsEventIdentity(event = {}) {
  return String(event.userId || event.visitorId || '').trim();
}

function updateDailyAnalyticsAggregate(db, events = []) {
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
  for (const [date, stats] of dailyStats) {
    db.prepare(`INSERT INTO analytics_daily_stats (event_date, pv, switch_runs) VALUES (?, ?, ?)
      ON CONFLICT(event_date) DO UPDATE SET pv = pv + excluded.pv, switch_runs = switch_runs + excluded.switch_runs`).run(date, stats.pv, stats.switchRuns);
  }
  for (const user of dailyUsers.values()) {
    db.prepare(`INSERT INTO analytics_daily_users (event_date, identity, is_visitor_only, has_page_view, has_page_engagement) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_date, identity) DO UPDATE SET
        is_visitor_only = MAX(is_visitor_only, excluded.is_visitor_only),
        has_page_view = MAX(has_page_view, excluded.has_page_view),
        has_page_engagement = MAX(has_page_engagement, excluded.has_page_engagement)
    `).run(user.date, user.identity, user.isVisitorOnly, user.hasPageView, user.hasPageEngagement);
  }
}


function handleTrackAnalytics(request, db, origin) {
  const body = readBody(request);
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
      if (!meta.colo) meta.colo = request.headers.get('cf-colo') || '';
      if (!meta.loc) meta.loc = request.headers.get('cf-country') || '';
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

  // 5% 请求顺带清理过期窗口，无需独立调度即可控制表增长。
  const rate = enforceAnalyticsRateLimit(db, request, normalizedEvents.length, {
    prune: Math.random() < 0.05
  });
  if (rate.limited) {
    return json(
      { message: '上报过于频繁，请稍后再试', error: 'RATE_LIMITED', limit: rate.limit, used: rate.used },
      { status: 429, origin, headers: { 'Retry-After': String(rate.retryAfter) } }
    );
  }

  let accepted = 0;
  const acceptedEvents = [];
  for (const normalizedEvent of normalizedEvents) {
    const result = db.prepare(`INSERT OR IGNORE INTO analytics_events
      (id, type, user_id, username, visitor_id, session_id, path, event_date, created_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
      );
    accepted += 1;
    if (result?.changes === 0) continue;
    acceptedEvents.push(normalizedEvent);
  }
  if (acceptedEvents.length) updateDailyAnalyticsAggregate(db, acceptedEvents);
  return json({ ok: true, accepted }, { origin });
}

function handleMeta(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const meta = db.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes, content_hash AS contentHash, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').get(user.id);
  return json(meta || { version: null, updatedAt: '', keyCount: 0, bytes: 0, contentHash: '', lastEndId: '', lastEndType: '' }, { origin });
}

function archiveCurrentBackup(db, user, current) {
  if (!current || !Number.isSafeInteger(Number(current.version)) || Number(current.version) <= 0) return false;
  const encoded = String(current.envelope || '');
  if (!encoded) return false;
  db.prepare(`INSERT OR IGNORE INTO backup_versions
    (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256,
     last_end_id, last_end_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, Number(current.version), String(current.kvKey || `backup:${user.id}`), String(current.updatedAt || nowIso()),
      Number(current.keyCount) || 0, Number(current.bytes) || encoded.length, String(current.contentHash || ''), encoded,
      String(current.cipherSha256 || '') || sha256Hex(encoded), String(current.lastEndId || ''), String(current.lastEndType || ''), nowIso());
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

function handleGetBackupVersions(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit'));
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const current = db.prepare(`SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash FROM backups WHERE user_id = ?`).get(user.id);
  const history = db.prepare(`SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash FROM backup_versions WHERE user_id = ? ORDER BY version DESC LIMIT ?`).all(user.id, limit);
  const currentVersion = current ? Number(current.version) : null;
  const versions = new Map();
  for (const row of history || []) versions.set(Number(row.version), backupVersionSummary(row, currentVersion));
  if (currentVersion != null && currentVersion > 0) versions.set(currentVersion, backupVersionSummary(current, currentVersion, 'current'));
  return json({ currentVersion, versions: [...versions.values()].sort((left, right) => right.version - left.version).slice(0, limit) }, { origin });
}

function handleRollbackBackupVersion(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const body = readBody(request);
  const targetVersion = Number(body.version);
  const baseVersion = Number(body.baseVersion);
  if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) return json({ message: '缺少有效的目标版本', code: 'VERSION_REQUIRED' }, { status: 400, origin });
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) return json({ message: '缺少有效的当前版本', code: 'BASE_VERSION_REQUIRED' }, { status: 400, origin });
  const current = db.prepare(`SELECT version, kv_key AS kvKey, updated_at AS updatedAt, key_count AS keyCount, bytes,
    content_hash AS contentHash, envelope, cipher_sha256 AS cipherSha256, last_end_id AS lastEndId, last_end_type AS lastEndType
    FROM backups WHERE user_id = ?`).get(user.id);
  const currentVersion = Number(current?.version) || 0;
  if (!current) return json({ message: '云端没有可回滚的备份', code: 'BACKUP_NOT_FOUND' }, { status: 404, origin });
  if (currentVersion !== baseVersion) return json({ message: '云端版本已变化，请刷新版本列表后再回滚', code: 'REVISION_MISMATCH', currentVersion }, { status: 409, origin });
  if (targetVersion === currentVersion) return json({ version: currentVersion, unchanged: true }, { origin });
  const target = db.prepare(`SELECT version, key_count AS keyCount, bytes, content_hash AS contentHash, envelope
    FROM backup_versions WHERE user_id = ? AND version = ?`).get(user.id, targetVersion);
  if (!target?.envelope) return json({ message: '目标版本不存在或不可恢复', code: 'VERSION_NOT_FOUND' }, { status: 404, origin });
  let parsed;
  try { parsed = JSON.parse(String(target.envelope)); } catch { parsed = null; }
  if (!parsed?.ciphertext || parsed.source !== 'ai-dca-secure-sync' || !parsed.crypto) {
    return json({ message: '目标版本密文已损坏，无法回滚', code: 'VERSION_CORRUPTED' }, { status: 409, origin });
  }
  archiveCurrentBackup(db, user, current);
  const maxVersion = db.prepare('SELECT MAX(version) AS maxVersion FROM backup_versions WHERE user_id = ?').get(user.id);
  const version = Math.max(currentVersion, Number(maxVersion?.maxVersion) || 0) + 1;
  const encoded = String(target.envelope);
  const updatedAt = nowIso();
  db.prepare(`UPDATE backups SET version = ?, updated_at = ?, key_count = ?, bytes = ?, content_hash = ?,
    envelope = ?, cipher_sha256 = ?, last_end_id = ?, last_end_type = ? WHERE user_id = ? AND version = ?`)
    .run(version, updatedAt, Number(target.keyCount) || Number(parsed?.meta?.keyCount) || 0, encoded.length,
      String(target.contentHash || parsed?.meta?.contentHash || ''), encoded, sha256Hex(encoded), `rollback:v${targetVersion}`, 'version-rollback', user.id, baseVersion);
  return json({ version, updatedAt, rolledBackFrom: targetVersion, keyCount: Number(target.keyCount) || 0, bytes: encoded.length }, { origin });
}

function handleGetLatest(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const meta = db.prepare('SELECT version, updated_at AS updatedAt, key_count AS keyCount, bytes, kv_key AS kvKey, envelope, cipher_sha256 AS cipherSha256, content_hash AS contentHash, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').get(user.id);
  if (!meta) return json({ version: null, encryptedEnvelope: null }, { origin });
  const encoded = meta.envelope ? String(meta.envelope) : '';
  if (encoded && meta.cipherSha256) {
    // 校验 SQLite 内密文完整性：不一致绝不把坏 blob 发给端侧。
    const actual = sha256Hex(encoded);
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

function handlePutLatest(request, db, origin) {
  const user = requireUser(request);
  if (!user) return json({ message: '未登录' }, { status: 401, origin });
  const body = readBody(request);
  const encryptedEnvelope = body.encryptedEnvelope || {};
  if (!encryptedEnvelope.ciphertext || encryptedEnvelope.source !== 'ai-dca-secure-sync') {
    return json({ message: '密文备份格式不合法' }, { status: 400, origin });
  }
  const current = db.prepare('SELECT version, kv_key AS kvKey, updated_at AS updatedAt, key_count AS keyCount, bytes, content_hash AS contentHash, envelope, cipher_sha256 AS cipherSha256, last_end_id AS lastEndId, last_end_type AS lastEndType FROM backups WHERE user_id = ?').get(user.id);
  const incomingHash = String(encryptedEnvelope?.meta?.contentHash || '');
  // 内容未变化：保持版本号不变，不重写存储，不报冲突。
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
  const cipherSha = sha256Hex(encoded);
  const updatedAt = nowIso();
  const keyCount = Number(encryptedEnvelope?.meta?.keyCount) || 0;
  // 强一致主存储：密文 BLOB + 完整性校验和 + 版本元数据写入同一 SQLite 行（单次原子写）。
  if (current) {
    archiveCurrentBackup(db, user, current);
    db.prepare('UPDATE backups SET version = ?, updated_at = ?, key_count = ?, bytes = ?, content_hash = ?, envelope = ?, cipher_sha256 = ?, last_end_id = ?, last_end_type = ? WHERE user_id = ?')
      .run(version, updatedAt, keyCount, encoded.length, incomingHash, encoded, cipherSha, endId, endType, user.id);
  } else {
    db.prepare('INSERT INTO backups (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256, last_end_id, last_end_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, version, kvKey, updatedAt, keyCount, encoded.length, incomingHash, encoded, cipherSha, endId, endType);
  }
  return json({ version, updatedAt, keyCount, bytes: encoded.length, contentHash: incomingHash, lastEndId: endId, lastEndType: endType, sameEnd }, { origin });
}


export function handleSyncRoute(db, method, url, body, headers = {}) {
  const routes = {
    '/api/sync/analytics/track': { POST: handleTrackAnalytics },
    '/api/sync/meta': { GET: handleMeta },
    '/api/sync/versions': { GET: handleGetBackupVersions },
    '/api/sync/versions/rollback': { POST: handleRollbackBackupVersion },
    '/api/sync/latest': { GET: handleGetLatest, PUT: handlePutLatest },
    '/api/sync/health': { GET: () => json({ ok: true, service: 'sync', at: nowIso() }) },
    '/api/sync/probe': { GET: () => ({ status: 200, body: PROBE_HTML, headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300'
    } }) }
  };
  const route = routes[url.pathname];
  if (!route) return null;
  if (!route[method]) return json({ message: 'not found' }, { status: 404 });
  const request = { url: url.href, urlObject: url, body, rawHeaders: headers, headers: new Headers(headers) };
  const origin = request.headers.get('origin') || '*';
  const result = withTransaction(db, () => route[method](request, db, origin));
  return { ...result, headers: { ...result.headers, 'Access-Control-Allow-Origin': origin } };
}
