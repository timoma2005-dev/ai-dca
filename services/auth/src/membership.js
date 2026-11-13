// 会员等级：按注册天数 + 近 30 天活跃天数自动升降级（2026-11-13 产品决定，取代注册赠送 / 手动售卖）。
// - 活跃日：登录状态下访问网站（/me、/menus、/check 带有效会话）的北京时间自然日，每天最多记一次；
// - 每次新记一天时立即重算该用户（达标当天升级），另外服务每小时全量重算一次（不达标自动降级）；
// - 只管理 granted_by = 'system:activity' 的 vip/svip 行；管理员手动授予的角色不受影响。
export const MEMBERSHIP_RULES = Object.freeze({
  windowDays: 30,
  tiers: Object.freeze([
    Object.freeze({ role: 'svip', name: 'SVIP', minRegisteredDays: 30, minActiveDays: 20 }),
    Object.freeze({ role: 'vip', name: 'VIP', minRegisteredDays: 30, minActiveDays: 10 }),
  ]),
});
export const AUTO_GRANTOR = 'system:activity';
const DAY_MS = 24 * 60 * 60 * 1000;
const SH_OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiDay(input = new Date()) {
  const ms = input instanceof Date ? input.getTime() : Date.parse(String(input));
  return new Date(ms + SH_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function ensureMembershipSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_activity_days (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS membership_state (
    user_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT '',
    prev_tier TEXT NOT NULL DEFAULT '',
    changed_at TEXT
  )`);
}

function rbacReady(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_roles'").get());
}

/** 按注册天数与活跃天数给出目标等级（'svip' | 'vip' | ''）。 */
export function targetTier(registeredDays, activeDays, rules = MEMBERSHIP_RULES) {
  for (const tier of rules.tiers) {
    if (registeredDays >= tier.minRegisteredDays && activeDays >= tier.minActiveDays) return tier.role;
  }
  return '';
}

export function registeredDaysOf(createdAt, now = new Date()) {
  const start = Date.parse(String(createdAt || ''));
  if (!Number.isFinite(start)) return 0;
  // 按北京时间自然日计：注册当天为第 0 天。
  const diff = Date.parse(`${shanghaiDay(now)}T00:00:00Z`) - Date.parse(`${shanghaiDay(new Date(start))}T00:00:00Z`);
  return Math.max(0, Math.round(diff / DAY_MS));
}

/** 近 windowDays 天（含今天）的活跃天数。 */
export function activeDaysOf(db, userId, now = new Date(), windowDays = MEMBERSHIP_RULES.windowDays) {
  const today = shanghaiDay(now);
  const from = addDays(today, -(windowDays - 1));
  return Number(db.prepare('SELECT COUNT(*) AS n FROM user_activity_days WHERE user_id = ? AND day >= ? AND day <= ?')
    .get(userId, from, today)?.n || 0);
}

function currentAutoTier(db, userId) {
  const rows = db.prepare(`SELECT role_code FROM user_roles WHERE user_id = ? AND granted_by = ? AND role_code IN ('vip', 'svip')`)
    .all(userId, AUTO_GRANTOR).map((row) => row.role_code);
  if (rows.includes('svip')) return 'svip';
  return rows.includes('vip') ? 'vip' : '';
}

/** 重算单个用户的自动等级；有变化时改写 user_roles 并记录 membership_state。返回 { changed, tier, prevTier }。 */
export function evaluateUser(db, userId, { now = new Date() } = {}) {
  if (!rbacReady(db)) return { changed: false, tier: '', prevTier: '' };
  const user = db.prepare('SELECT id, created_at FROM users WHERE id = ?').get(userId);
  if (!user) return { changed: false, tier: '', prevTier: '' };
  const target = targetTier(registeredDaysOf(user.created_at, now), activeDaysOf(db, userId, now));
  const current = currentAutoTier(db, userId);
  // 管理员已手动授予同级角色（主键冲突无法再插自动行）：视为已达标，不反复改写。
  const manualHeld = target && !current && db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = ? AND (granted_by IS NULL OR granted_by <> ?)').get(userId, target, AUTO_GRANTOR);
  if (target === current || manualHeld) return { changed: false, tier: current, prevTier: current };
  const iso = new Date(now).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND granted_by = ? AND role_code IN ('vip', 'svip')`).run(userId, AUTO_GRANTOR);
    if (target) {
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES (?, ?, NULL, ?, ?)')
        .run(userId, target, AUTO_GRANTOR, iso);
    }
    db.prepare(`INSERT INTO membership_state (user_id, tier, prev_tier, changed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, prev_tier = excluded.prev_tier, changed_at = excluded.changed_at`)
      .run(userId, target, current, iso);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  return { changed: true, tier: target, prevTier: current };
}

export function recomputeAll(db, { now = new Date() } = {}) {
  if (!rbacReady(db)) return { users: 0, changed: 0 };
  const ids = db.prepare('SELECT id FROM users').all().map((row) => row.id);
  let changed = 0;
  for (const id of ids) {
    try {
      if (evaluateUser(db, id, { now }).changed) changed += 1;
    } catch (err) {
      console.error('[membership] evaluate failed', id, err?.message || err);
    }
  }
  return { users: ids.length, changed };
}

// 同一进程内每个用户每天只写一次活跃日。
const recorded = new Map();

/** 记一次活跃；当天首次记录时立即重算该用户。任何失败都不影响请求本身。 */
export function recordActivity(db, userId, { now = new Date() } = {}) {
  if (!userId) return false;
  const day = shanghaiDay(now);
  if (recorded.get(userId) === day) return false;
  try {
    const res = db.prepare('INSERT OR IGNORE INTO user_activity_days (user_id, day) VALUES (?, ?)').run(userId, day);
    recorded.set(userId, day);
    if (Number(res?.changes || 0) > 0) evaluateUser(db, userId, { now });
    return Number(res?.changes || 0) > 0;
  } catch (err) {
    console.error('[membership] record failed', err?.message || err);
    return false;
  }
}

export function resetActivityCache() {
  recorded.clear();
}

/** 前端弹窗用的会员进度。 */
export function membershipSummary(db, userId, { now = new Date() } = {}) {
  const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const registeredDays = registeredDaysOf(user.created_at, now);
  const activeDays = activeDaysOf(db, userId, now);
  const state = db.prepare('SELECT tier, prev_tier, changed_at FROM membership_state WHERE user_id = ?').get(userId);
  return {
    tier: currentAutoTier(db, userId),
    registeredDays,
    activeDays,
    windowDays: MEMBERSHIP_RULES.windowDays,
    prevTier: state?.prev_tier || '',
    changedAt: state?.changed_at || null,
    rules: MEMBERSHIP_RULES.tiers.map((tier) => ({ ...tier })),
  };
}
