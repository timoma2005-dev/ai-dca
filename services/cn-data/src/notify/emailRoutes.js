// Email channel management routes for cn-data.
// Port of workers/notify/src/accountEmailRoutes.js handleFastEmailRoute
// to synchronous node:sqlite.
//
// Endpoints:
//   GET  /api/notify/email/status
//   POST /api/notify/email/send-code { email }
//   POST /api/notify/email/verify { email, code }
//   POST /api/notify/email/save { email, rebind? }
//   POST /api/notify/email/enable
//   POST /api/notify/email/disable
//
// Storage:
// - Channel config: notify_user_records (record_type='client-channel',
//   record_id='<clientId>::email') — same as other channels.
// - Cross-user binding guard: notify_channel_bindings table (migration 005).
// - Verification codes: notify_user_records (record_type='email-verification'),
//   see emailVerification.js.

import { HttpError } from '../authSession.js';
import { nowIso, withTransaction } from '../db.js';
import {
  clearEmailVerification,
  createEmailVerification,
  getRequestIp,
  getVerifiedEmailVerification,
  hashText,
  maskEmailAddress,
  normalizeEmailAddress,
  verifyEmailCode
} from './emailVerification.js';

function text(value = '', max = 240) { return String(value ?? '').trim().slice(0, max); }
function parse(value, fallback = {}) {
  try {
    const data = JSON.parse(String(value || ''));
    return data && typeof data === 'object' ? data : fallback;
  } catch { return fallback; }
}

function normalizeEmailConfig(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const address = normalizeEmailAddress(input.address || '');
  const verified = Boolean(address && input.verified);
  return {
    address,
    verified,
    verifiedAt: verified ? String(input.verifiedAt || '').trim() : '',
    enabled: Boolean(verified && input.enabled)
  };
}

function publicEmail(email = {}) {
  const value = normalizeEmailConfig(email);
  return {
    maskedAddress: maskEmailAddress(value.address),
    verified: value.verified,
    verifiedAt: value.verifiedAt,
    enabled: value.enabled
  };
}

function readEmail(db, account) {
  const row = db.prepare(`SELECT payload FROM notify_user_records
    WHERE owner_user_id = ? AND record_type = 'client-channel' AND record_id = ?`)
    .get(account.userId, `${account.clientId}::email`);
  return normalizeEmailConfig(parse(row?.payload)?.email || {});
}

function writeEmail(db, account, email, hash = '') {
  const now = nowIso();
  const payload = JSON.stringify({ clientId: account.clientId, email: normalizeEmailConfig(email) });
  db.prepare(`INSERT INTO notify_user_records
    (owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
    VALUES (?, 'client-channel', ?, ?, 1, ?, ?)
    ON CONFLICT(owner_user_id, record_type, record_id) DO UPDATE SET
    payload = excluded.payload, revision = notify_user_records.revision + 1, updated_at = excluded.updated_at`)
    .run(account.userId, `${account.clientId}::email`, payload, now, now);
  db.prepare(`DELETE FROM notify_channel_bindings WHERE owner_user_id = ? AND channel_type = 'email'`)
    .run(account.userId);
  if (hash) {
    db.prepare(`INSERT INTO notify_channel_bindings
      (channel_type, token_hash, owner_user_id, client_id, channel_identity, created_at, updated_at)
      VALUES ('email', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_type, token_hash) DO UPDATE SET
      owner_user_id = excluded.owner_user_id, client_id = excluded.client_id,
      channel_identity = excluded.channel_identity, updated_at = excluded.updated_at`)
      .run(hash, account.userId, account.clientId, maskEmailAddress(email.address), now, now);
  }
}

function emailBinding(account) {
  return { scope: 'account', accountClientId: account.clientId };
}

export function handleEmailStatus(db, account) {
  const email = readEmail(db, account);
  return { ok: true, binding: emailBinding(account), email: publicEmail(email) };
}

export async function handleEmailSendCode(db, account, body, headers) {
  const email = normalizeEmailAddress(body?.email);
  if (!email) {
    throw new HttpError(400, 'INVALID_EMAIL', '请输入有效的邮箱地址。');
  }
  const result = await createEmailVerification(db, {
    userId: account.userId,
    email,
    ip: getRequestIp(headers || {})
  });
  return { ok: true, maskedAddress: maskEmailAddress(result.email), expiresAt: result.expiresAt };
}

export async function handleEmailVerify(db, account, body) {
  const result = await verifyEmailCode(db, {
    userId: account.userId,
    email: body?.email,
    code: body?.code
  });
  return {
    ok: true,
    verified: true,
    pendingSave: true,
    maskedAddress: maskEmailAddress(result.email),
    verifiedAt: result.verifiedAt
  };
}

export async function handleEmailSave(db, account, body) {
  const email = normalizeEmailAddress(body?.email);
  if (!email) {
    throw new HttpError(400, 'INVALID_EMAIL', '请输入有效的邮箱地址。');
  }
  const verified = getVerifiedEmailVerification(db, { userId: account.userId, email });
  const tokenHash = await hashText(verified.email);
  const binding = db.prepare(`SELECT owner_user_id FROM notify_channel_bindings
    WHERE channel_type = 'email' AND token_hash = ?`).get(tokenHash);

  if (binding?.owner_user_id && binding.owner_user_id !== account.userId && body?.rebind !== true) {
    const error = new HttpError(409, 'EMAIL_REBIND_REQUIRED', '该邮箱已绑定其他账号，需要确认重新绑定。');
    error.canRebind = true;
    throw error;
  }
  if (binding?.owner_user_id && binding.owner_user_id !== account.userId) {
    // Rebind: remove the other user's channel record for this email address.
    db.prepare(`DELETE FROM notify_user_records
      WHERE owner_user_id = ? AND record_type = 'client-channel'
      AND record_id LIKE '%::email'`)
      .run(binding.owner_user_id);
  }
  const value = { address: verified.email, verified: true, verifiedAt: verified.verifiedAt, enabled: true };
  withTransaction(db, () => {
    writeEmail(db, account, value, tokenHash);
    clearEmailVerification(db, account.userId);
  });
  return { ok: true, binding: emailBinding(account), email: publicEmail(value) };
}

export function handleEmailToggle(db, account, enable) {
  const current = readEmail(db, account);
  if (enable && (!current.address || !current.verified)) {
    throw new HttpError(400, 'EMAIL_NOT_VERIFIED', '邮箱尚未完成验证。');
  }
  const value = { ...current, enabled: enable };
  const hashPromise = current.address ? hashText(current.address) : Promise.resolve('');
  return hashPromise.then((hash) => {
    withTransaction(db, () => {
      writeEmail(db, account, value, hash);
    });
    return { ok: true, email: publicEmail(value) };
  });
}
