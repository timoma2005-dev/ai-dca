// 邮件通知每日配额：按用户当日（Asia/Shanghai）已发送的邮件条数限流。
// 普通用户 10 条、VIP 20 条、SVIP（及继承 SVIP 的管理员）50 条。
// 角色从共享 auth SQLite（只读）读取，口径与 rbacGuard.computeUserPerms 一致：过期角色忽略、按 parent_code 继承。
import { openAuthDb } from '../authSession.js';

export const EMAIL_DAILY_LIMITS = { user: 10, vip: 20, svip: 50 };

export function shanghaiDate(now = Date.now()) {
  return new Date(Number(now) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function roleClosureFor(auth, userId, nowIso = new Date().toISOString()) {
  const parents = new Map(auth.prepare('SELECT code, parent_code, is_virtual FROM roles').all()
    .map((row) => [row.code, { parent: row.parent_code || null, virtual: Boolean(row.is_virtual) }]));
  const assigned = new Set(parents.has('user') ? ['user'] : []);
  for (const row of auth.prepare('SELECT role_code, expires_at FROM user_roles WHERE user_id = ?').all(String(userId))) {
    const role = parents.get(row.role_code);
    if (!role || role.virtual) continue;
    if (row.expires_at && String(row.expires_at) <= nowIso) continue;
    assigned.add(row.role_code);
  }
  const closure = new Set();
  for (const start of assigned) {
    let code = start;
    let depth = 0;
    while (code && parents.has(code) && !closure.has(code) && depth < 16) {
      closure.add(code);
      code = parents.get(code).parent;
      depth += 1;
    }
  }
  return closure;
}

export function emailLimitForRoles(closure) {
  if (closure?.has('svip')) return EMAIL_DAILY_LIMITS.svip;
  if (closure?.has('vip')) return EMAIL_DAILY_LIMITS.vip;
  return EMAIL_DAILY_LIMITS.user;
}

export function emailDailyLimitFor(userId, { openDb } = {}) {
  openDb = openDb || openAuthDb;
  const auth = openDb();
  if (!auth) return EMAIL_DAILY_LIMITS.user;
  try {
    return emailLimitForRoles(roleClosureFor(auth, userId));
  } catch {
    return EMAIL_DAILY_LIMITS.user;
  } finally {
    try { auth.close(); } catch { /* ignore */ }
  }
}

function ensureQuotaTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS notify_email_quota (
    owner_user_id TEXT NOT NULL,
    quota_date TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, quota_date)
  )`);
}

export function emailSentToday(db, userId, date = shanghaiDate()) {
  ensureQuotaTable(db);
  const row = db.prepare('SELECT sent FROM notify_email_quota WHERE owner_user_id = ? AND quota_date = ?').get(String(userId), date);
  return Number(row?.sent) || 0;
}

export function recordEmailSent(db, userId, date = shanghaiDate()) {
  ensureQuotaTable(db);
  db.prepare(`INSERT INTO notify_email_quota (owner_user_id, quota_date, sent, updated_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(owner_user_id, quota_date) DO UPDATE SET sent = sent + 1, updated_at = excluded.updated_at`)
    .run(String(userId), date, new Date().toISOString());
}
