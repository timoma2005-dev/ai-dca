import { createHash, randomBytes } from 'node:crypto';
import { enqueueEvent } from './outbox.js';
import { applyBootstrapGrants, buildAuthPayload } from './rbac.js';
import {
  hashPassword,
  verifyPassword,
  isPbkdf2Hash,
  legacyPasswordHash,
} from './password.js';

// Must stay in sync with workers/sync/src/index.js.
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export function normalizeUsername(username = '') {
  return String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 48);
}

/**
 * 兼容旧调用：是否为管理员改由 RBAC 计算（admin / superadmin 角色），不再写死用户名。
 * 需要 db 才能判断；无 db 时恒为 false。
 */
export function isAdminUser(db, user) {
  if (!db || !user?.id) return false;
  return Boolean(buildAuthPayload(db, user).isAdmin);
}

export function sha256Hex(text = '') {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 旧版单轮 SHA-256 凭证派生，保留给存量用户验证与既有调用方；
 * 新注册/轮转统一使用 password.js 的 PBKDF2 PHC。
 */
export function hashPasswordCredential(clientPasswordHash, salt) {
  return legacyPasswordHash(clientPasswordHash, salt);
}

export function randomId(prefix = '') {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Run fn inside a SQLite transaction. BEGIN IMMEDIATE takes the write lock
 * up front so concurrent writers queue on busy_timeout instead of failing.
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already rolled back or connection broken; surface the original error.
    }
    throw err;
  }
}

function validateCredentials(username, clientPasswordHash) {
  const normalized = normalizeUsername(username);
  if (normalized.length < 3) return { error: '用户名至少 3 位', status: 400 };
  if (String(clientPasswordHash || '').length < 32) return { error: '密码不合法', status: 400 };
  return { username: normalized };
}

function createSessionRow(db, user) {
  const accessToken = randomId('acc_');
  const refreshToken = randomId('ref_');
  const tokenHash = sha256Hex(accessToken);
  const createdAt = nowIso();
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(tokenHash, user.id, createdAt, expires);
  return {
    // 返回给调用方的 session；原始 token 只留在本进程，绝不进入同步事件。
    session: {
      userId: user.id,
      username: user.username,
      accessToken,
      refreshToken,
      expiresAt: expires,
    },
    // outbox payload.session：只含 token_hash 与建行时写入的真实时间戳，
    // 到期时间完全复用 INSERT 值，禁止重算 30 天。
    syncSession: { token_hash: tokenHash, user_id: user.id, created_at: createdAt, expires_at: expires },
  };
}

// 新注册赠送会员（2026-10-24 产品决定）：注册即送 3 个月 VIP，到期日为北京时间当天 23:59:59。
export const SIGNUP_GIFT = { role: 'vip', months: 3 };

export function signupGiftExpiresAt(now = new Date(), months = SIGNUP_GIFT.months) {
  const sh = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = sh.getUTCFullYear();
  const m = sh.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(sh.getUTCDate(), lastDay);
  return new Date(Date.UTC(y, m, day, 15, 59, 59)).toISOString();
}

function grantSignupGift(db, userId, now) {
  // 测试（以及临时关闭活动）可设置 AUTH_SIGNUP_GIFT=0。
  if (String(process.env.AUTH_SIGNUP_GIFT ?? '1') === '0') return;
  const hasRole = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roles'").get()
    && db.prepare('SELECT 1 FROM roles WHERE code = ?').get(SIGNUP_GIFT.role);
  if (!hasRole) return;
  db.prepare(
    `INSERT OR IGNORE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES (?, ?, ?, 'signup-gift', ?)`
  ).run(userId, SIGNUP_GIFT.role, signupGiftExpiresAt(new Date(now)), now);
}

export function registerUser(db, { username, clientPasswordHash }) {
  const validation = validateCredentials(username, clientPasswordHash);
  if (validation.error) return validation;

  const normalized = validation.username;
  const user = { id: randomId('usr_'), username: normalized };
  // PHC 自描述哈希内嵌随机盐；password_salt 列仅为兼容旧 schema 而留空。
  const storedHash = hashPassword(clientPasswordHash);
  const passwordSalt = '';
  const now = nowIso();

  const insertUser = db.prepare(
    'INSERT INTO users (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  let created;
  try {
    withTransaction(db, () => {
      insertUser.run(user.id, normalized, storedHash, passwordSalt, now, now);
      grantSignupGift(db, user.id, now);
      created = createSessionRow(db, user);
      enqueueEvent(db, 'user.register', {
        id: user.id,
        username: normalized,
        password_hash: storedHash,
        password_salt: passwordSalt,
        created_at: now,
        updated_at: now,
        session: created.syncSession,
      });
    });
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE constraint failed')) {
      return { error: '用户名已存在', status: 409 };
    }
    throw err;
  }
  return withAuthPayload(db, created.session);
}

/**
 * 在 session 上附加 RBAC 载荷（roles/topRole/menus/perms/permVersion/isAdmin）。
 * 必须在注册/登录事务提交之后调用：种子账号补发使用独立事务。
 */
export function withAuthPayload(db, session) {
  const user = { id: session.userId, username: session.username };
  applyBootstrapGrants(db, user);
  return { ...session, ...buildAuthPayload(db, user), status: 200 };
}

export function loginUser(db, { username, clientPasswordHash }) {
  const validation = validateCredentials(username, clientPasswordHash);
  if (validation.error) return validation;

  const normalized = validation.username;
  const row = db
    .prepare('SELECT id, username, password_hash, password_salt FROM users WHERE username = ?')
    .get(normalized);

  // 新 PHC 走 PBKDF2，存量 64 位 hex 走旧 SHA-256；用户不存在与密码错误返回完全一致。
  if (!row || !verifyPassword(clientPasswordHash, row.password_hash, row.password_salt || '')) {
    return { error: '用户名或密码不正确', status: 401 };
  }

  let created;
  withTransaction(db, () => {
    // 惰性升级：旧 SHA-256 用户验证通过后，在同一事务内轮转成 PBKDF2 PHC，
    // 并发出 user.credential_rotated 事件让 D1 灾备副本同步新凭证。
    if (!isPbkdf2Hash(row.password_hash)) {
      const rotatedHash = hashPassword(clientPasswordHash);
      const rotatedAt = nowIso();
      db.prepare(
        'UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?'
      ).run(rotatedHash, '', rotatedAt, row.id);
      enqueueEvent(db, 'user.credential_rotated', {
        id: row.id,
        username: row.username,
        password_hash: rotatedHash,
        password_salt: '',
        updated_at: rotatedAt,
      });
    }
    created = createSessionRow(db, row);
    enqueueEvent(db, 'user.login', {
      id: row.id,
      username: row.username,
      last_login_at: nowIso(),
      session: created.syncSession,
    });
  });
  return withAuthPayload(db, created.session);
}

export function verifySession(db, accessToken) {
  if (!accessToken) return null;
  const tokenHash = sha256Hex(accessToken);
  const row = db
    .prepare(
      `SELECT users.id, users.username
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
    )
    .get(tokenHash, nowIso());
  return row || null;
}
