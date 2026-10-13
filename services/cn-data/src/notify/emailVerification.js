// Email verification code flow for cn-data.
// Port of workers/notify/src/emailVerification.js to synchronous node:sqlite.
//
// Storage mapping (worker -> cn-data):
// - env.NOTIFY_STATE KV `email-verification:<userId>` -> notify_user_records
// (record_type='email-verification', record_id=userId)
// - env.NOTIFY_STATE KV `email-rate:*` -> notify_user_records
// (record_type='email-rate', record_id=<key>)
//
// Crypto: worker uses Web Crypto (crypto.subtle, crypto.getRandomValues);
// Node 18+ provides both via node:crypto (webcrypto.subtle) and global
// crypto.getRandomValues.
//
// Email sending: via Resend (same as testDelivery.js sendViaResend).
// Token from process.env.RESEND_TOKEN (supervisor env on cn host).

import { webcrypto, getRandomValues} from 'node:crypto';
import { HttpError } from '../authSession.js';

const subtle = webcrypto.subtle;

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_MAX_ATTEMPTS = 5;
const USER_COOLDOWN_MS = 2 * 60 * 1000;
const EMAIL_WINDOW_10M_MS = 10 * 60 * 1000;
const EMAIL_WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const IP_WINDOW_10M_MS = 10 * 60 * 1000;

const RESEND_FROM = 'notify@freebacktrack.tech';

function text(value = '', max = 5000) { return String(value?? '').trim().slice(0, max);}

export function normalizeEmailAddress(value = '') {
const email = String(value || '').trim().toLowerCase();
if (!email || email.length > 254) return '';
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
return email;
}

export function maskEmailAddress(value = '') {
const email = normalizeEmailAddress(value);
if (!email) return '';
const [local, domain] = email.split('@');
if (!local ||!domain) return '';
const visible = local.length <= 2? local.slice(0, 1): local.slice(0, 2);
return `${visible}${'*'.repeat(Math.min(Math.max(local.length - visible.length, 2), 6))}@${domain}`;
}

export function escapeEmailHtml(value = '') {
return String(value?? '')
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}

async function hashText(value = '') {
const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
}

export { hashText};

function randomDigits(length = 6) {
const bytes = getRandomValues(new Uint8Array(length));
return Array.from(bytes, (value) => String(value % 10)).join('');
}

function randomNonce(length = 16) {
const bytes = getRandomValues(new Uint8Array(length));
return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

// --- notify_user_records storage (replaces NOTIFY_STATE KV) ---

function upsertRecord(db, ownerUserId, recordType, recordId, value) {
const now = new Date().toISOString();
db.prepare(`INSERT INTO notify_user_records
(owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
VALUES (?,?,?,?, 1,?,?)
ON CONFLICT(owner_user_id, record_type, record_id) DO UPDATE SET
payload = excluded.payload, revision = notify_user_records.revision + 1, updated_at = excluded.updated_at`)
.run(ownerUserId, recordType, recordId, JSON.stringify(value), now, now);
}

function readRecord(db, ownerUserId, recordType, recordId) {
const row = db.prepare(`SELECT payload FROM notify_user_records
WHERE owner_user_id =? AND record_type =? AND record_id =?`)
.get(ownerUserId, recordType, recordId);
if (!row?.payload) return null;
try {
const data = JSON.parse(String(row.payload));
return data && typeof data === 'object'? data: null;
} catch {
return null;
}
}

function deleteRecord(db, ownerUserId, recordType, recordId) {
db.prepare(`DELETE FROM notify_user_records
WHERE owner_user_id =? AND record_type =? AND record_id =?`)
.run(ownerUserId, recordType, recordId);
}

function verificationRecordId(userId = '') {
return `email-verification:${String(userId || '').trim()}`;
}

// --- rate limiting (port of assertRateLimit/readRate/writeRate) ---

function readRateTimestamps(db, key) {
const data = readRecord(db, 'system', 'email-rate', key);
if (!data ||!Array.isArray(data.timestamps)) return [];
return data.timestamps.map(Number).filter(Number.isFinite);
}

function writeRateTimestamps(db, key, timestamps) {
// No TTL in SQLite; expired entries are filtered on read.
// Store under a system owner since rate limits span users (by email/IP hash).
upsertRecord(db, 'system', 'email-rate', key, { timestamps});
}

function assertRateLimit(db, key, { windowMs, max, now, message}) {
const previous = readRateTimestamps(db, key);
const active = previous.filter((value) => now - value < windowMs);
if (active.length >= max) {
throw new HttpError(429, 'RATE_LIMITED', message);
}
writeRateTimestamps(db, key, [...active, now]);
}

export function getRequestIp(headers = {}) {
const get = (name) => {
if (typeof headers.get === 'function') return headers.get(name);
return headers[name] || headers[name.toLowerCase()];
};
return String(get('cf-connecting-ip') || get('x-forwarded-for') || get('x-real-ip') || 'unknown')
.split(',')[0]
.trim()
.slice(0, 80);
}

export async function enforceEmailCodeRateLimits(db, { userId, email, ip, now = Date.now()} = {}) {
const normalizedUserId = String(userId || '').trim();
const normalizedEmail = normalizeEmailAddress(email);
if (!normalizedUserId ||!normalizedEmail) throw new HttpError(400, 'BAD_REQUEST', '邮箱验证参数无效。');
const emailHash = await hashText(normalizedEmail);
const ipHash = await hashText(ip || 'unknown');
const userHash = await hashText(normalizedUserId);

assertRateLimit(db, `email-rate:user:${userHash}`, {
windowMs: USER_COOLDOWN_MS, max: 1, now,
message: '验证码发送过于频繁，请 2 分钟后重试。'
});
assertRateLimit(db, `email-rate:email10m:${emailHash}`, {
windowMs: EMAIL_WINDOW_10M_MS, max: 3, now,
message: '该邮箱验证码发送过于频繁，请稍后重试。'
});
assertRateLimit(db, `email-rate:email24h:${emailHash}`, {
windowMs: EMAIL_WINDOW_24H_MS, max: 10, now,
message: '该邮箱今日验证码发送次数已达上限。'
});
assertRateLimit(db, `email-rate:ip10m:${ipHash}`, {
windowMs: IP_WINDOW_10M_MS, max: 10, now,
message: '当前网络验证码请求过于频繁，请稍后重试。'
});
}

// --- email sending via Resend ---

async function sendVerificationEmail(to, code) {
const token = String(process.env.RESEND_TOKEN || '').trim();
if (!token) {
throw new HttpError(500, 'EMAIL_NOT_CONFIGURED', 'cn 主机未配置 RESEND_TOKEN，无法发送验证码邮件。');
}
const safeEmail = escapeEmailHtml(to);
const resp = await fetch('https://api.resend.com/emails', {
method: 'POST',
headers: {
Authorization: `Bearer ${token}`,
'Content-Type': 'application/json'
},
body: JSON.stringify({
from: RESEND_FROM,
to: [to],
subject: `邮箱验证码 ${code}`,
text: `你正在绑定美股策略助手的邮件提醒。\n\n验证码：${code}\n\n10 分钟内有效。如果没有进行此操作，请忽略此邮件。`,
html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#111827"><h2 style="font-size:18px">邮箱验证</h2><p>你正在为 ${safeEmail} 绑定美股策略助手的邮件提醒。</p><div style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0">${code}</div><p>验证码 10 分钟内有效。如果没有进行此操作，请忽略此邮件。</p></div>`
})
});
if (!resp.ok) {
const body = await resp.text().catch(() => '');
throw new HttpError(502, 'EMAIL_SEND_FAILED', `验证码邮件发送失败（resend ${resp.status}）。`);
}
}

// --- public API (mirrors worker's exports) ---

export async function createEmailVerification(db, { userId, email, ip} = {}) {
const normalizedUserId = String(userId || '').trim();
const normalizedEmail = normalizeEmailAddress(email);
if (!normalizedUserId ||!normalizedEmail) {
throw new HttpError(400, 'BAD_REQUEST', '请输入有效的邮箱地址。');
}

await enforceEmailCodeRateLimits(db, { userId: normalizedUserId, email: normalizedEmail, ip});
const code = randomDigits(6);
const nonce = randomNonce(16);
const now = Date.now();
const expiresAt = now + EMAIL_CODE_TTL_MS;
const codeHash = await hashText(`${normalizedUserId}:${normalizedEmail}:${code}:${nonce}`);
const record = {
email: normalizedEmail,
nonce,
codeHash,
createdAt: new Date(now).toISOString(),
expiresAt: new Date(expiresAt).toISOString(),
attempts: 0,
verifiedAt: ''
};

upsertRecord(db, normalizedUserId, 'email-verification', verificationRecordId(normalizedUserId), record);

await sendVerificationEmail(normalizedEmail, code);

return { email: normalizedEmail, expiresAt: record.expiresAt};
}

function readVerificationRecord(db, userId = '') {
const normalizedUserId = String(userId || '').trim();
if (!normalizedUserId) return { recordId: '', record: null};
const recordId = verificationRecordId(normalizedUserId);
return { recordId, record: readRecord(db, normalizedUserId, 'email-verification', recordId)};
}

export async function verifyEmailCode(db, { userId, email, code, now = Date.now()} = {}) {
const normalizedUserId = String(userId || '').trim();
const normalizedEmail = normalizeEmailAddress(email);
const normalizedCode = String(code || '').trim();
if (!normalizedUserId ||!normalizedEmail ||!/^\d{6}$/.test(normalizedCode)) {
throw new HttpError(400, 'BAD_REQUEST', '邮箱或验证码格式不正确。');
}

const { recordId, record} = readVerificationRecord(db, normalizedUserId);
if (!record || record.email!== normalizedEmail) {
throw new HttpError(400, 'BAD_REQUEST', '验证码不存在或已失效，请重新发送。');
}
if (Date.parse(record.expiresAt || '') <= now) {
deleteRecord(db, normalizedUserId, 'email-verification', recordId);
throw new HttpError(400, 'BAD_REQUEST', '验证码已过期，请重新发送。');
}
if (Number(record.attempts || 0) >= EMAIL_MAX_ATTEMPTS) {
deleteRecord(db, normalizedUserId, 'email-verification', recordId);
throw new HttpError(429, 'RATE_LIMITED', '验证码错误次数过多，请重新发送。');
}

const candidateHash = await hashText(`${normalizedUserId}:${normalizedEmail}:${normalizedCode}:${record.nonce}`);
if (candidateHash!== record.codeHash) {
record.attempts = Number(record.attempts || 0) + 1;
if (record.attempts >= EMAIL_MAX_ATTEMPTS) {
deleteRecord(db, normalizedUserId, 'email-verification', recordId);
} else {
upsertRecord(db, normalizedUserId, 'email-verification', recordId, record);
}
throw new HttpError(record.attempts >= EMAIL_MAX_ATTEMPTS ? 429 : 400, record.attempts >= EMAIL_MAX_ATTEMPTS ? 'RATE_LIMITED' : 'BAD_REQUEST', record.attempts >= EMAIL_MAX_ATTEMPTS ? '验证码错误次数过多，请重新发送。' : '验证码错误。');
}

record.verifiedAt = record.verifiedAt || new Date(now).toISOString();
upsertRecord(db, normalizedUserId, 'email-verification', recordId, record);
return { email: normalizedEmail, verifiedAt: record.verifiedAt, expiresAt: record.expiresAt};
}

export function getVerifiedEmailVerification(db, { userId, email, now = Date.now()} = {}) {
const normalizedUserId = String(userId || '').trim();
const normalizedEmail = normalizeEmailAddress(email);
const { recordId, record} = readVerificationRecord(db, normalizedUserId);
if (!recordId ||!record || record.email!== normalizedEmail ||!record.verifiedAt) {
throw new HttpError(400, 'BAD_REQUEST', '邮箱尚未完成验证码验证，请重新验证。');
}
if (Date.parse(record.expiresAt || '') <= now) {
deleteRecord(db, normalizedUserId, 'email-verification', recordId);
throw new HttpError(400, 'BAD_REQUEST', '邮箱验证已过期，请重新发送验证码。');
}
return { email: normalizedEmail, verifiedAt: String(record.verifiedAt || '')};
}

export function clearEmailVerification(db, userId = '') {
const normalizedUserId = String(userId || '').trim();
if (!normalizedUserId) return;
deleteRecord(db, normalizedUserId, 'email-verification', verificationRecordId(normalizedUserId));
}
