// 邀请注册：每个账号一个邀请码；好友用邀请码注册成功即双方各得 SVIP 天数（minActiveDays 可配置为观察期活跃要求）。
// 防滥用：与邀请人同 IP 注册、同一邀请人 30 天内同 IP 的第二个号都不算；每个邀请人每月奖励有上限。
import { randomInt } from 'node:crypto';
import { shanghaiDay } from './membership.js';

export const REFERRAL_RULES = Object.freeze({
  windowDays: 7,
  minActiveDays: Number(process.env.AUTH_REFERRAL_MIN_ACTIVE_DAYS || 0),
  rewardDays: Number(process.env.AUTH_REFERRAL_REWARD_DAYS || 7),
  monthlyCap: Number(process.env.AUTH_REFERRAL_MONTHLY_CAP || 5),
});
export const REFERRAL_GRANTOR = 'referral';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY_MS = 24 * 60 * 60 * 1000;

export function ensureReferralSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (user_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_signup_meta (user_id TEXT PRIMARY KEY, ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS referrals (
      referee_id TEXT PRIMARY KEY, inviter_id TEXT NOT NULL, code TEXT NOT NULL, register_ip TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS referrals_inviter ON referrals (inviter_id, status);
  `);
}

export function normalizeInviteCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

export function inviteCodeFor(db, userId, { now = new Date() } = {}) {
  const row = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(userId);
  if (row) return row.code;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const res = db.prepare('INSERT OR IGNORE INTO invite_codes (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, new Date(now).toISOString());
    if (res.changes) return code;
    const again = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(userId);
    if (again) return again.code;
  }
  throw new Error('invite code generation failed');
}

/** 注册成功后调用：记录注册 IP，并在邀请码有效时建立邀请关系（不立即发奖励）。 */
export function recordSignup(db, { userId, ip = '', inviteCode = '', now = new Date() }) {
  const iso = new Date(now).toISOString();
  const cleanIp = String(ip || '').slice(0, 64);
  db.prepare('INSERT OR IGNORE INTO user_signup_meta (user_id, ip, created_at) VALUES (?, ?, ?)').run(userId, cleanIp, iso);
  const code = normalizeInviteCode(inviteCode);
  if (!code) return { referral: null };
  const inviter = db.prepare('SELECT user_id FROM invite_codes WHERE code = ?').get(code);
  if (!inviter || inviter.user_id === userId) return { referral: null, error: 'invalid_code' };
  let status = 'pending';
  let reason = '';
  if (cleanIp) {
    const inviterIp = db.prepare('SELECT ip FROM user_signup_meta WHERE user_id = ?').get(inviter.user_id)?.ip || '';
    const since = new Date(new Date(now).getTime() - 30 * DAY_MS).toISOString();
    const sameIpPeer = db.prepare('SELECT 1 FROM referrals WHERE inviter_id = ? AND register_ip = ? AND created_at >= ? LIMIT 1').get(inviter.user_id, cleanIp, since);
    if (inviterIp === cleanIp || sameIpPeer) { status = 'rejected'; reason = 'same_ip'; }
  }
  db.prepare(`INSERT OR IGNORE INTO referrals (referee_id, inviter_id, code, register_ip, status, reason, created_at, settled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, inviter.user_id, code, cleanIp, status, reason, iso, status === 'pending' ? null : iso);
  return { referral: { inviterId: inviter.user_id, status, reason } };
}

/** 追加 SVIP 天数：永久 SVIP 不动；已有期限的从较晚的那天往后顺延。 */
export function grantSvipDays(db, userId, days, { now = new Date() } = {}) {
  const row = db.prepare("SELECT expires_at FROM user_roles WHERE user_id = ? AND role_code = 'svip'").get(userId);
  if (row && !row.expires_at) return null;
  const base = Math.max(new Date(now).getTime(), row?.expires_at ? Date.parse(row.expires_at) || 0 : 0);
  const expires = new Date(base + days * DAY_MS).toISOString();
  db.prepare(`INSERT INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES (?, 'svip', ?, ?, ?)
    ON CONFLICT(user_id, role_code) DO UPDATE SET expires_at = excluded.expires_at`).run(userId, expires, REFERRAL_GRANTOR, new Date(now).toISOString());
  return expires;
}

function activeDaysInWindow(db, userId, createdAt, rules) {
  const first = shanghaiDay(new Date(createdAt));
  const last = shanghaiDay(new Date(Date.parse(createdAt) + (rules.windowDays - 1) * DAY_MS));
  return db.prepare('SELECT COUNT(*) AS n FROM user_activity_days WHERE user_id = ? AND day >= ? AND day <= ?').get(userId, first, last).n;
}

/** 结算待定邀请：达标且未超月上限 → 双方发 SVIP；超出观察期未达标 → expired。 */
export function settleReferrals(db, { now = new Date(), rules = REFERRAL_RULES } = {}) {
  const pending = db.prepare("SELECT referee_id, inviter_id, created_at FROM referrals WHERE status = 'pending'").all();
  const nowMs = new Date(now).getTime();
  const iso = new Date(now).toISOString();
  const month = shanghaiDay(now).slice(0, 7);
  let rewarded = 0;
  for (const ref of pending) {
    const active = activeDaysInWindow(db, ref.referee_id, ref.created_at, rules);
    let status = '';
    let reason = '';
    if (active >= rules.minActiveDays) {
      const used = db.prepare("SELECT settled_at FROM referrals WHERE inviter_id = ? AND status = 'rewarded'").all(ref.inviter_id)
        .filter((row) => row.settled_at && shanghaiDay(new Date(row.settled_at)).slice(0, 7) === month).length;
      if (used >= rules.monthlyCap) { status = 'rejected'; reason = 'monthly_cap'; } else { status = 'rewarded'; }
    } else if (nowMs - Date.parse(ref.created_at) > rules.windowDays * DAY_MS) {
      status = 'expired';
    }
    if (!status) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (status === 'rewarded') {
        grantSvipDays(db, ref.inviter_id, rules.rewardDays, { now });
        grantSvipDays(db, ref.referee_id, rules.rewardDays, { now });
        rewarded += 1;
      }
      db.prepare('UPDATE referrals SET status = ?, reason = ?, settled_at = ? WHERE referee_id = ?').run(status, reason, iso, ref.referee_id);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }
  return { pending: pending.length, rewarded };
}

export function referralSummary(db, userId, { now = new Date(), rules = REFERRAL_RULES } = {}) {
  const rows = db.prepare('SELECT status, settled_at FROM referrals WHERE inviter_id = ?').all(userId);
  const month = shanghaiDay(now).slice(0, 7);
  const count = (status) => rows.filter((row) => row.status === status).length;
  return {
    code: inviteCodeFor(db, userId, { now }),
    rewardDays: rules.rewardDays,
    monthlyCap: rules.monthlyCap,
    minActiveDays: rules.minActiveDays,
    windowDays: rules.windowDays,
    pending: count('pending'),
    rewarded: count('rewarded'),
    total: rows.length,
    invitees: referralInvitees(db, userId, { rules }),
    rewardedThisMonth: rows.filter((row) => row.status === 'rewarded' && row.settled_at && shanghaiDay(new Date(row.settled_at)).slice(0, 7) === month).length,
  };
}

function maskName(name = '') {
  const value = String(name || '');
  if (!value) return '***';
  return value.length <= 2 ? `${value.slice(0, 1)}*` : `${value.slice(0, 2)}***`;
}

/** 邀请人可见的被邀请人明细：用户名打码，附观察期内活跃天数与结算状态。 */
export function referralInvitees(db, userId, { rules = REFERRAL_RULES } = {}) {
  const rows = db.prepare(`SELECT r.referee_id, r.status, r.reason, r.created_at, r.settled_at, u.username
    FROM referrals r LEFT JOIN users u ON u.id = r.referee_id
    WHERE r.inviter_id = ? ORDER BY r.created_at DESC LIMIT 100`).all(userId);
  return rows.map((row) => {
    let activeDays = 0;
    try { activeDays = activeDaysInWindow(db, row.referee_id, row.created_at, rules); } catch { activeDays = 0; }
    return {
      name: maskName(row.username),
      status: row.status,
      reason: row.reason || '',
      createdAt: row.created_at,
      settledAt: row.settled_at || '',
      windowEndsAt: new Date(Date.parse(row.created_at) + rules.windowDays * DAY_MS).toISOString(),
      activeDays: Math.min(activeDays, rules.windowDays),
    };
  });
}

/** 邀请落地页：公开校验邀请码，只返回打码后的邀请人名称与规则。 */
export function inviteCodeInfo(db, code, { rules = REFERRAL_RULES } = {}) {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return { valid: false };
  const row = db.prepare('SELECT u.username FROM invite_codes ic JOIN users u ON u.id = ic.user_id WHERE ic.code = ?').get(normalized);
  if (!row) return { valid: false };
  return { valid: true, code: normalized, inviter: maskName(row.username), rewardDays: rules.rewardDays, minActiveDays: rules.minActiveDays, windowDays: rules.windowDays };
}
