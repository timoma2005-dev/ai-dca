// RBAC 核心：角色继承、过期、权限并集、菜单树与可复用的鉴权函数 requirePerm。
//
// 安全约束：
// - 每次请求都只根据 token（Authorization: Bearer 或 httpOnly 会话 cookie）在服务端重新计算，
//   从不读取客户端提交的 roles / perms / locked / isAdmin 字段。
// - 过期的 user_roles 行在计算时自动忽略（保留用于审计）。
// - 所有登录用户隐式拥有 user 角色；未登录时使用虚拟角色 guest。
import { createHash } from 'node:crypto';
import { nowIso, sha256Hex, withTransaction } from './auth.js';

export const SESSION_COOKIE_NAME = 'aidca_session';
export const GUEST_ROLE = 'guest';
export const BASE_ROLE = 'user';
export const ADMIN_ROLE = 'admin';
export const SUPERADMIN_ROLE = 'superadmin';
export const PRIVILEGED_PERMS = new Set(['api:rbac-admin', 'api:rbac-grant-admin']);
export const PERM_PATTERN = /^(menu:[A-Za-z0-9_-]{1,48}:(view|access)|api:[a-z0-9][a-z0-9._-]{0,63})$/;

// 种子账号：迁移时已存在的账号由 002-rbac.sql 授予；之后才同步到本地库的账号在注册/登录时补一次。
// sync_state 记录 rbac_bootstrap:<username>，保证只发放一次，撤销后不会被重新授予。
export const BOOTSTRAP_GRANTS = Object.freeze({
  lovexl: 'superadmin',
  wanghao0902: 'admin',
  de88903: 'admin',
  '551668745qq.com': 'auction_viewer',
});

const readyCache = new WeakMap();

/** RBAC 表是否已迁移（cn-data 等只读消费者在旧库上会是 false）。 */
export function rbacReady(db) {
  if (readyCache.has(db)) return readyCache.get(db);
  let ready = false;
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('roles','user_roles','role_permissions','menus')").get();
    ready = Number(row?.n) === 4;
  } catch {
    ready = false;
  }
  if (ready) readyCache.set(db, true);
  return ready;
}

export function getRbacVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM sync_state WHERE key = 'rbac_version'").get();
    return String(row?.value || '0');
  } catch {
    return '0';
  }
}

export function bumpRbacVersion(db) {
  const next = String(Number(getRbacVersion(db)) + 1);
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('rbac_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(next);
  return next;
}

export function loadRoleGraph(db) {
  const rows = db.prepare('SELECT code, name, parent_code, level, is_system, is_virtual, description FROM roles').all();
  const graph = new Map();
  for (const row of rows) {
    graph.set(row.code, {
      code: row.code,
      name: row.name,
      parent: row.parent_code || null,
      level: Number(row.level) || 0,
      isSystem: Boolean(row.is_system),
      isVirtual: Boolean(row.is_virtual),
      description: row.description || '',
    });
  }
  return graph;
}

/** 角色继承闭包（含自身与所有祖先），防环、限深。 */
export function roleClosure(graph, codes) {
  const out = new Set();
  for (const start of codes) {
    let code = start;
    let depth = 0;
    while (code && graph.has(code) && !out.has(code) && depth < 16) {
      out.add(code);
      code = graph.get(code).parent;
      depth += 1;
    }
  }
  return out;
}

function isActive(expiresAt, now) {
  return !expiresAt || String(expiresAt) > now;
}

/** 用户直接拥有的有效角色（含隐式 user），按 level 降序。 */
export function directRolesForUser(db, userId, { now = nowIso(), graph = loadRoleGraph(db) } = {}) {
  const rows = userId
    ? db.prepare('SELECT role_code, expires_at FROM user_roles WHERE user_id = ?').all(String(userId))
    : [];
  const byCode = new Map();
  if (userId && graph.has(BASE_ROLE)) byCode.set(BASE_ROLE, null);
  for (const row of rows) {
    const role = graph.get(row.role_code);
    if (!role || role.isVirtual) continue;
    if (!isActive(row.expires_at, now)) continue;
    byCode.set(row.role_code, row.expires_at || null);
  }
  return [...byCode.entries()]
    .map(([code, expiresAt]) => ({ code, name: graph.get(code).name, level: graph.get(code).level, expiresAt }))
    .sort((a, b) => b.level - a.level || a.code.localeCompare(b.code));
}

export function permsForRoles(db, closure) {
  const codes = [...closure];
  if (!codes.length) return new Set();
  const placeholders = codes.map(() => '?').join(',');
  const rows = db.prepare(`SELECT DISTINCT perm_code FROM role_permissions WHERE role_code IN (${placeholders})`).all(...codes);
  return new Set(rows.map((row) => row.perm_code));
}

/**
 * 计算一个主体（user 为 null 表示游客）的有效权限。
 * 返回值只在服务端使用；输出给客户端时由 buildAuthPayload 序列化。
 */
export function computeAccess(db, user, { now = nowIso() } = {}) {
  const graph = loadRoleGraph(db);
  const direct = user ? directRolesForUser(db, user.id, { now, graph }) : [];
  const assigned = user ? direct.map((role) => role.code) : [GUEST_ROLE];
  const closure = roleClosure(graph, assigned);
  const perms = permsForRoles(db, closure);
  const top = user
    ? direct[0] || { code: BASE_ROLE, name: graph.get(BASE_ROLE)?.name || BASE_ROLE, level: 10, expiresAt: null }
    : { code: GUEST_ROLE, name: graph.get(GUEST_ROLE)?.name || GUEST_ROLE, level: 0, expiresAt: null };
  const isAdmin = closure.has(ADMIN_ROLE) || closure.has(SUPERADMIN_ROLE);
  const isSuperadmin = closure.has(SUPERADMIN_ROLE);
  const sortedPerms = [...perms].sort();
  const permVersion = createHash('sha256')
    .update(`${getRbacVersion(db)}|${direct.map((r) => `${r.code}@${r.expiresAt || ''}`).join(',')}|${sortedPerms.join(',')}`)
    .digest('hex')
    .slice(0, 16);
  return {
    user: user ? { id: user.id, username: user.username } : null,
    graph,
    roles: direct,
    closure,
    perms,
    topRole: { code: top.code, name: top.name },
    isAdmin,
    isSuperadmin,
    permVersion,
  };
}

export function hasPerm(access, perm) {
  return Boolean(access?.perms?.has(perm));
}

/** 访问某菜单所需的最低系统角色（用于 locked 菜单提示「需要 VIP」）。 */
function requiredRoleFor(db, graph, menuKey, cache) {
  if (cache.has(menuKey)) return cache.get(menuKey);
  const perm = `menu:${menuKey}:access`;
  const systemRoles = [...graph.values()].filter((role) => role.isSystem).sort((a, b) => a.level - b.level);
  let found = null;
  for (const role of systemRoles) {
    const perms = permsForRoles(db, roleClosure(graph, [role.code]));
    if (perms.has(perm)) {
      found = { code: role.code, name: role.name };
      break;
    }
  }
  cache.set(menuKey, found);
  return found;
}

/** 可见菜单树：有 view 才出现；没有 access 的标记 locked 并给出 requiredRole。 */
export function buildMenuTree(db, access) {
  const rows = db
    .prepare('SELECT key, label, tab, icon, group_name, sort, parent_key, subtitle FROM menus WHERE enabled = 1 ORDER BY sort ASC, key ASC')
    .all();
  const cache = new Map();
  const items = new Map();
  for (const row of rows) {
    if (!access.perms.has(`menu:${row.key}:view`)) continue;
    const locked = !access.perms.has(`menu:${row.key}:access`);
    items.set(row.key, {
      key: row.key,
      label: row.label,
      tab: row.tab || row.key,
      icon: row.icon || '',
      group: row.group_name || 'primary',
      sort: Number(row.sort) || 0,
      subtitle: row.subtitle || '',
      parentKey: row.parent_key || null,
      locked,
      requiredRole: locked ? requiredRoleFor(db, access.graph, row.key, cache) : null,
      children: [],
    });
  }
  const roots = [];
  for (const item of items.values()) {
    const parent = item.parentKey ? items.get(item.parentKey) : null;
    if (parent) parent.children.push(item);
    else roots.push(item);
  }
  return roots;
}

/** 输出给客户端的权限载荷（登录/注册/me/menus 共用）。 */
export function buildAuthPayload(db, user, { now = nowIso() } = {}) {
  if (!rbacReady(db)) {
    return { roles: [], topRole: null, menus: [], perms: [], permVersion: '', isAdmin: false };
  }
  const access = computeAccess(db, user, { now });
  return {
    roles: access.roles.map((role) => ({ code: role.code, name: role.name, expiresAt: role.expiresAt })),
    topRole: access.topRole,
    menus: buildMenuTree(db, access),
    perms: [...access.perms].sort(),
    permVersion: access.permVersion,
    isAdmin: access.isAdmin,
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value.join('; ') : String(value ?? '');
  }
  return '';
}

export function parseCookies(cookieHeader = '') {
  const out = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

/** 读取请求 token：Authorization: Bearer 优先，其次 httpOnly 会话 cookie。 */
export function readRequestToken(headers) {
  const authorization = headerValue(headers, 'authorization');
  if (/^bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^bearer\s+/i, '').trim();
    if (token) return token;
  }
  const cookie = parseCookies(headerValue(headers, 'cookie'))[SESSION_COOKIE_NAME];
  return cookie ? String(cookie).trim() : '';
}

export function findSessionUser(db, token, now = nowIso()) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT users.id AS id, users.username AS username
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
    )
    .get(sha256Hex(token), now);
  return row ? { id: String(row.id), username: String(row.username) } : null;
}

/** 认证请求：返回 { token, user }，token 存在但无效时 user 为 null。 */
export function authenticateRequest(db, headers, { now = nowIso() } = {}) {
  const token = readRequestToken(headers);
  return { token, user: token ? findSessionUser(db, token, now) : null };
}

/**
 * 可复用鉴权：requirePerm(db, headers, perm)
 *   → { ok: true, user, access }
 *   → { ok: false, status: 401 | 403, message, user, access }
 * 未登录且游客也没有该权限 → 401；token 无效/过期 → 401；已登录但权限不足 → 403。
 */
export function requirePerm(db, headers, perm, { now = nowIso() } = {}) {
  if (!PERM_PATTERN.test(String(perm || ''))) {
    return { ok: false, status: 400, message: '权限编码不合法' };
  }
  const { token, user } = authenticateRequest(db, headers, { now });
  if (token && !user) return { ok: false, status: 401, message: '登录状态已失效，请重新登录' };
  if (!rbacReady(db)) {
    // 未迁移的库：保持旧行为——登录即可，游客拒绝。
    return user ? { ok: true, user, access: null } : { ok: false, status: 401, message: '请先登录' };
  }
  const access = computeAccess(db, user, { now });
  if (access.perms.has(perm)) return { ok: true, user, access };
  if (!user) return { ok: false, status: 401, message: '请先登录', user, access };
  return { ok: false, status: 403, message: '权限不足', user, access };
}

/** Node http 风格的中间件包装：withPerm(db, perm, handler)(req, res)。 */
export function withPerm(db, perm, handler, { onDenied } = {}) {
  return async (req, res, ...rest) => {
    const result = requirePerm(db, req.headers, perm);
    if (!result.ok) {
      if (onDenied) return onDenied(req, res, result);
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: result.message, perm }));
      return undefined;
    }
    req.auth = result;
    return handler(req, res, ...rest);
  };
}

export function appendAudit(db, actor, action, targetType, targetId, detail = {}) {
  db.prepare(
    `INSERT INTO audit_log (actor_id, actor_username, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor?.id || null,
    actor?.username || 'system',
    String(action),
    String(targetType || ''),
    String(targetId || ''),
    JSON.stringify(detail ?? {}),
    nowIso()
  );
}

/** 种子账号补发：只发一次（sync_state 标记），失败不影响登录。 */
export function applyBootstrapGrants(db, user) {
  if (!user?.id || !rbacReady(db)) return false;
  const username = String(user.username || '').toLowerCase();
  const role = BOOTSTRAP_GRANTS[username];
  if (!role) return false;
  const marker = `rbac_bootstrap:${username}`;
  try {
    return withTransaction(db, () => {
      if (db.prepare('SELECT 1 FROM sync_state WHERE key = ?').get(marker)) return false;
      if (!db.prepare('SELECT 1 FROM roles WHERE code = ?').get(role)) return false;
      db.prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at)
         VALUES (?, ?, NULL, 'bootstrap', ?)`
      ).run(user.id, role, nowIso());
      db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(marker, nowIso());
      appendAudit(db, null, 'role.bootstrap', 'user', user.id, { username, role });
      bumpRbacVersion(db);
      return true;
    });
  } catch (err) {
    console.error('[auth-service] rbac bootstrap failed:', err?.message || err);
    return false;
  }
}

export function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
