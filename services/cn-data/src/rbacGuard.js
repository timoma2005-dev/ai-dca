// cn-data（8081）接口权限校验：共享 auth SQLite（只读），按 token 在服务端重新计算权限。
//
// 与 services/auth/src/rbac.js 的 computeAccess 口径一致（test/rbac-guard.test.mjs 做一致性校验）：
// - 登录用户隐式拥有 user 角色；user_roles 过期行忽略；角色按 parent_code 继承；权限取并集。
// - cn-data 部署在 /opt/ai-dca-cn-data，不能跨目录 import auth 服务源码，所以这里保留一份最小实现。
//
// 失败语义：
// - 没有 token / token 无效 → 交给原路由（它们会返回 401），这里不抢先处理。
// - auth 库不可用或尚未执行 002-rbac 迁移 → 默认 fail-closed 抛 503；仅当显式设置
//   CN_DATA_AUTH_FAIL_OPEN=1（本地开发/测试）时才放行并打印一次告警。
// - token 有效但缺少权限 → 403。
import { HttpError, openAuthDb } from './authSession.js';
import { isAuthFailOpenEnabled } from './authPolicy.js';
import { sha256Hex } from './account/store.js';

export const SESSION_COOKIE_NAME = 'aidca_session';

// 顺序匹配，第一个命中生效；perm 为 null 表示公开。
export const ROUTE_PERMISSIONS = [
  [/^\/api\/geo$/, null],
  [/^\/api\/account(\/|$)/, 'api:account'],
  [/^\/api\/notify\/health$/, null],
  [/^\/api\/notify\/switch\//, 'api:fund-switch'],
  [/^\/api\/notify(\/|$)/, 'api:notify'],
  [/^\/api\/sync\/(health|probe|analytics\/track)$/, null],
  [/^\/api\/sync\/backup$/, 'api:sync'],
  [/^\/(api\/)?sync(\/|$)/, 'api:sync'],
];

let warnedNotMigrated = false;

export function requiredPermFor(pathname = '') {
  for (const [pattern, perm] of ROUTE_PERMISSIONS) {
    if (pattern.test(pathname)) return perm;
  }
  return null;
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value.join('; ') : String(value ?? '');
  }
  return '';
}

export function readToken(headers) {
  const authorization = headerValue(headers, 'authorization');
  if (/^bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^bearer\s+/i, '').trim();
    if (token) return token;
  }
  for (const part of headerValue(headers, 'cookie').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE_NAME) {
      const raw = part.slice(index + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return '';
}

function rbacReady(auth) {
  const row = auth.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('roles','user_roles','role_permissions')").get();
  return Number(row?.n) === 3;
}

/** 计算用户有效权限集合（与 auth 服务 computeAccess 同口径）。 */
export function computeUserPerms(auth, userId, now = new Date().toISOString()) {
  const parents = new Map(auth.prepare('SELECT code, parent_code, is_virtual FROM roles').all()
    .map((row) => [row.code, { parent: row.parent_code || null, virtual: Boolean(row.is_virtual) }]));
  const assigned = new Set(parents.has('user') ? ['user'] : []);
  for (const row of auth.prepare('SELECT role_code, expires_at FROM user_roles WHERE user_id = ?').all(String(userId))) {
    const role = parents.get(row.role_code);
    if (!role || role.virtual) continue;
    if (row.expires_at && String(row.expires_at) <= now) continue;
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
  const codes = [...closure];
  if (!codes.length) return new Set();
  const rows = auth.prepare(`SELECT DISTINCT perm_code FROM role_permissions WHERE role_code IN (${codes.map(() => '?').join(',')})`).all(...codes);
  return new Set(rows.map((row) => row.perm_code));
}

/**
 * 返回 null 表示放行（或交给原路由处理认证），否则抛出 HttpError(403)。
 * openDb 可注入（测试用）。
 */
export function enforceRoutePermission(headers, pathname, { openDb = openAuthDb, now = new Date().toISOString() } = {}) {
  const perm = requiredPermFor(pathname);
  if (!perm) return null;
  const token = readToken(headers);
  if (!token) return null;
  const auth = openDb();
  if (!auth) {
    // 默认 fail-closed：认证依赖不可用时，带 token 的请求也不得放行。
    // 仅 CN_DATA_AUTH_FAIL_OPEN=1（本地开发/测试）时保留旧的放行行为。
    if (isAuthFailOpenEnabled()) return null;
    throw new HttpError(503, 'AUTH_UNAVAILABLE', '认证服务暂不可用，请稍后重试');
  }
  try {
    const session = auth.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256Hex(token));
    if (!session || String(session.expires_at) <= now) return null;
    if (!rbacReady(auth)) {
      if (isAuthFailOpenEnabled()) {
        if (!warnedNotMigrated) {
          warnedNotMigrated = true;
          console.warn('[cn-data] auth DB has no RBAC tables yet (002-rbac.sql); permission checks skipped (fail-open enabled)');
        }
        return null;
      }
      throw new HttpError(503, 'AUTH_UNAVAILABLE', '权限数据尚未就绪，请稍后重试');
    }
    const perms = computeUserPerms(auth, session.user_id, now);
    if (perms.has(perm)) return null;
    throw new HttpError(403, 'FORBIDDEN', `权限不足（需要 ${perm}）`);
  } finally {
    auth.close();
  }
}
