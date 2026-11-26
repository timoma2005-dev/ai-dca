// 注册/绑定邮箱验证码：新用户注册必须验证邮箱；老用户可在账号菜单补绑。
// 邮件经 Resend 发送（RESEND_TOKEN，与 cn-data 通知同一发件域）。
import { createHash, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const EMAIL_CODE_RULES = Object.freeze({
  ttlMs: 10 * 60 * 1000,
  maxAttempts: 5,
  cooldownMs: 60 * 1000,
  perEmailDaily: 10,
  perIpHourly: 20,
});
const HOUR_MS = 60 * 60 * 1000;

export class EmailCodeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeEmail(value = '') {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

let disposableDomains = null;
function loadDisposableDomains() {
  if (!disposableDomains) {
    try {
      const text = readFileSync(new URL('./disposableEmailDomains.txt', import.meta.url), 'utf8');
      disposableDomains = new Set(text.split('\n').map((line) => line.trim().toLowerCase()).filter((line) => line && !line.startsWith('#')));
    } catch {
      disposableDomains = new Set();
    }
  }
  return disposableDomains;
}

/** 临时/一次性邮箱（含其子域名）不允许用于注册和绑定。 */
export function isDisposableEmail(value = '') {
  const email = normalizeEmail(value);
  if (!email) return false;
  const domains = loadDisposableDomains();
  const parts = email.split('@')[1].split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (domains.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

const DISPOSABLE_MESSAGE = '不支持临时邮箱，请换一个常用邮箱';

export function maskEmail(value = '') {
  const email = normalizeEmail(value);
  if (!email) return '';
  const [local, domain] = email.split('@');
  const head = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${head}***@${domain}`;
}

export function ensureSignupEmailSchema(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (cols.length && !cols.some((col) => col.name === 'email')) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email <> '';
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (email, purpose)
    );
    CREATE TABLE IF NOT EXISTS email_code_sends (
      email TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      sent_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_code_sends_email ON email_code_sends(email, sent_at);
    CREATE INDEX IF NOT EXISTS idx_email_code_sends_ip ON email_code_sends(ip, sent_at);
  `);
}

function codeHash(email, code) {
  return createHash('sha256').update(`${email}:${String(code || '').trim()}`).digest('hex');
}

export function userEmail(db, userId) {
  return db.prepare('SELECT email FROM users WHERE id = ?').get(userId)?.email || '';
}

function assertEmailFree(db, email, userId = '') {
  const owner = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (owner && owner.id !== userId) {
    throw new EmailCodeError(409, userId ? '该邮箱已绑定其他账号' : '该邮箱已注册，请直接登录');
  }
}

export async function deliverViaResend({ to, code }) {
  const token = process.env.RESEND_TOKEN || '';
  if (!token) throw new Error('邮件服务未配置');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'AI-DCA <notify@freebacktrack.tech>',
      to: [to],
      subject: `AI-DCA 验证码 ${code}`,
      text: `你的 AI-DCA 邮箱验证码是 ${code}，10 分钟内有效。\n\n验证后这个邮箱也会用来接收提醒。如果不是你本人操作，请忽略这封邮件。`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}`);
}

export async function sendEmailCode(db, { email, purpose = 'register', userId = '', ip = '', now = Date.now(), deliver = deliverViaResend, rules = EMAIL_CODE_RULES } = {}) {
  const address = normalizeEmail(email);
  if (!address) throw new EmailCodeError(400, '请输入有效的邮箱地址');
  if (isDisposableEmail(address)) throw new EmailCodeError(400, DISPOSABLE_MESSAGE);
  assertEmailFree(db, address, userId);
  const last = db.prepare('SELECT MAX(sent_at) AS t FROM email_code_sends WHERE email = ?').get(address)?.t || 0;
  if (now - last < rules.cooldownMs) {
    throw new EmailCodeError(429, `发送太频繁，请 ${Math.ceil((rules.cooldownMs - (now - last)) / 1000)} 秒后再试`);
  }
  const daily = db.prepare('SELECT COUNT(*) AS n FROM email_code_sends WHERE email = ? AND sent_at > ?').get(address, now - 24 * HOUR_MS).n;
  if (daily >= rules.perEmailDaily) throw new EmailCodeError(429, '该邮箱今天的验证码次数已用完，请明天再试');
  if (ip) {
    const hourly = db.prepare('SELECT COUNT(*) AS n FROM email_code_sends WHERE ip = ? AND sent_at > ?').get(ip, now - HOUR_MS).n;
    if (hourly >= rules.perIpHourly) throw new EmailCodeError(429, '请求太频繁，请稍后再试');
  }
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  try {
    await deliver({ to: address, code });
  } catch (err) {
    console.error('[signup-email] send failed', err?.message || err);
    throw new EmailCodeError(502, '验证码发送失败，请稍后重试');
  }
  db.prepare(`INSERT INTO email_codes (email, purpose, code_hash, attempts, expires_at) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(email, purpose) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at`)
    .run(address, purpose, codeHash(address, code), now + rules.ttlMs);
  db.prepare('INSERT INTO email_code_sends (email, ip, sent_at) VALUES (?, ?, ?)').run(address, ip, now);
  db.prepare('DELETE FROM email_code_sends WHERE sent_at < ?').run(now - 2 * 24 * HOUR_MS);
  return { ok: true, maskedAddress: maskEmail(address), cooldownSeconds: Math.round(rules.cooldownMs / 1000), expiresInSeconds: Math.round(rules.ttlMs / 1000) };
}

/** 校验验证码；正确时返回规范化邮箱（不删除，调用方成功后再 consumeEmailCode）。 */
export function checkEmailCode(db, { email, code, purpose = 'register', userId = '', now = Date.now(), rules = EMAIL_CODE_RULES } = {}) {
  const address = normalizeEmail(email);
  if (!address) throw new EmailCodeError(400, '请输入有效的邮箱地址');
  if (isDisposableEmail(address)) throw new EmailCodeError(400, DISPOSABLE_MESSAGE);
  if (!/^\d{6}$/.test(String(code || '').trim())) throw new EmailCodeError(400, '请输入 6 位邮箱验证码');
  assertEmailFree(db, address, userId);
  const row = db.prepare('SELECT code_hash, attempts, expires_at FROM email_codes WHERE email = ? AND purpose = ?').get(address, purpose);
  if (!row || row.expires_at < now) throw new EmailCodeError(400, '验证码已过期，请重新获取');
  if (row.attempts >= rules.maxAttempts) throw new EmailCodeError(429, '验证码错误次数过多，请重新获取');
  if (row.code_hash !== codeHash(address, code)) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?').run(address, purpose);
    throw new EmailCodeError(400, '邮箱验证码不正确');
  }
  return address;
}

export function consumeEmailCode(db, { email, purpose = 'register' } = {}) {
  db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').run(normalizeEmail(email), purpose);
}

export function setUserEmail(db, userId, email) {
  db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(normalizeEmail(email), new Date().toISOString(), userId);
}
