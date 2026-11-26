-- 邀请注册（运行时 ensureReferralSchema 也会建表，这里留档）。
CREATE TABLE IF NOT EXISTS invite_codes (user_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_signup_meta (user_id TEXT PRIMARY KEY, ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS referrals (
  referee_id TEXT PRIMARY KEY, inviter_id TEXT NOT NULL, code TEXT NOT NULL, register_ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, settled_at TEXT
);
CREATE INDEX IF NOT EXISTS referrals_inviter ON referrals (inviter_id, status);
