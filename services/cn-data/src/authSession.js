import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from './account/store.js';
import { isAuthFailOpenEnabled } from './authPolicy.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.message = message || code;
  }
}

let warnedAuthUnavailable = false;

export function openAuthDb() {
  try {
    return new DatabaseSync(process.env.AUTH_DB_PATH || '/var/lib/ai-dca-auth/auth.sqlite', { readOnly: true });
  } catch {
    return null;
  }
}

function requireUserIdFromSession(db, headers) {
  const authorization = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? '';
  const token = typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', '请先登录账户');
  const row = db.prepare(`SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.username AS username
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256Hex(token));
  if (!row) throw new HttpError(401, 'UNAUTHORIZED', '登录状态已失效，请重新登录');
  if (Date.parse(row.expiresAt) <= Date.now()) throw new HttpError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
  return { id: String(row.userId), username: String(row.username || '') };
}

export function resolveUserId(url, body, headers) {
  const db = openAuthDb();
  if (db) {
    try {
      return requireUserIdFromSession(db, headers);
    } finally {
      db.close();
    }
  }
  // 默认 fail-closed：认证库打不开时拒绝请求，避免信任客户端自报 user_id 造成横向越权。
  // 仅在显式设置 CN_DATA_AUTH_FAIL_OPEN=1（本地开发/测试）时保留旧兜底。
  if (!isAuthFailOpenEnabled()) {
    throw new HttpError(503, 'AUTH_UNAVAILABLE', '认证服务暂不可用，请稍后重试');
  }
  if (!warnedAuthUnavailable) {
    warnedAuthUnavailable = true;
    console.warn('[cn-data] auth DB unavailable, CN_DATA_AUTH_FAIL_OPEN is on: trusting query/body user_id (dev/test only)');
  }
  const queryUser = url.searchParams.get('user_id');
  if (queryUser && body?.user_id && queryUser !== body.user_id) throw new HttpError(400, 'CONFLICTING_USER_ID', 'Conflicting user_id');
  const userId = String(body?.user_id ?? queryUser ?? '').trim();
  if (!userId) throw new HttpError(400, 'USER_ID_REQUIRED', 'user_id is required');
  return { id: userId, username: '' };
}

// Canonical account identity used by the v1 routes.
export function resolveUser(headers, url, body) {
  return resolveUserId(url, body, headers).id;
}
