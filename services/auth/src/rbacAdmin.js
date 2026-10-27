// RBAC 管理操作：用户角色、角色 CRUD、角色权限、菜单 CRUD、审计查询。
// 调用方（server.js）负责先用 requirePerm 校验 api:rbac-admin；这里再做细粒度约束：
// - 任命/撤销「特权角色」（继承 admin 或含 api:rbac-admin / api:rbac-grant-admin）需要 api:rbac-grant-admin（superadmin）。
// - superadmin 角色不能通过接口授予或撤销（防止越权与自锁）。
// - 修改特权角色的权限、或给任意角色加/去特权权限，同样需要 superadmin。
import { nowIso, withTransaction } from './auth.js';
import { enqueueEvent } from './outbox.js';
import { listGuestActivity, userLastActiveDates } from './analyticsRead.js';
import {
  ADMIN_ROLE,
  BASE_ROLE,
  GUEST_ROLE,
  PERM_PATTERN,
  PRIVILEGED_PERMS,
  SUPERADMIN_ROLE,
  appendAudit,
  bumpRbacVersion,
  hasPerm,
  loadRoleGraph,
  permsForRoles,
  roleClosure,
} from './rbac.js';

export class RbacError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const MENU_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,47}$/;
const PROTECTED_MENUS = new Set(['adminRbac']);

function actorOf(access) {
  return access?.user || null;
}

function canGrantAdmin(access) {
  return hasPerm(access, 'api:rbac-grant-admin');
}

function text(value, max = 64) {
  return String(value ?? '').trim().slice(0, max);
}

function isPrivilegedRole(db, graph, code) {
  const closure = roleClosure(graph, [code]);
  if (closure.has(ADMIN_ROLE) || closure.has(SUPERADMIN_ROLE)) return true;
  const perms = permsForRoles(db, closure);
  for (const perm of PRIVILEGED_PERMS) if (perms.has(perm)) return true;
  return false;
}

function mutate(db, access, action, targetType, targetId, detail, fn) {
  return withTransaction(db, () => {
    const result = fn();
    appendAudit(db, actorOf(access), action, targetType, targetId, detail);
    bumpRbacVersion(db);
    if (process.env.AUTH_RBAC_SYNC_ENABLED === '1') {
      // D1 侧消费者尚未实现（见 docs/plan-rbac.md「D1 同步」），默认关闭，避免进入死信。
      enqueueEvent(db, 'rbac.change', { action, targetType, targetId, detail, at: nowIso() });
    }
    return result;
  });
}

function normalizeExpiresAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new RbacError(400, '到期时间格式不正确');
  if (ms <= Date.now()) throw new RbacError(400, '到期时间必须晚于当前时间');
  return new Date(ms).toISOString();
}

// ── 用户与角色 ──

/** 概览统计：注册总数 + 特权用户（拥有 VIP 之外的有效角色，如 SVIP / 管理员）。不受列表 limit 影响。 */
export function userStats(db) {
  const now = nowIso();
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n || 0);
  const privileged = Number(db.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n FROM user_roles
     WHERE role_code <> 'vip' AND (expires_at IS NULL OR expires_at > ?)`
  ).get(now)?.n || 0);
  return { total, privileged };
}

export function searchUsers(db, { q = '', limit = 20 } = {}) {
  const query = text(q, 48).toLowerCase();
  const max = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 500);
  const select = `SELECT u.id, u.username, u.created_at, s.last_session_at FROM users u
    LEFT JOIN (SELECT user_id, MAX(created_at) AS last_session_at FROM sessions GROUP BY user_id) s ON s.user_id = u.id`;
  let rows = query
    ? db.prepare(`${select} WHERE u.username LIKE ? ESCAPE '\\' OR u.id = ? ORDER BY u.username LIMIT ?`)
      .all(`%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, query, max)
    : db.prepare(`${select} ORDER BY u.username`).all();
  const activeDates = userLastActiveDates();
  rows = rows.map((row) => {
    const date = activeDates.get(row.id);
    const sessionAt = row.last_session_at;
    const lastActiveAt = date && (!sessionAt || Date.parse(date) > Date.parse(sessionAt)) ? date : sessionAt || null;
    return { ...row, lastActiveAt };
  });
  if (!query) {
    // 必须先合并分析日期再排序、截断，否则姓名靠后的活跃用户会被 LIMIT 遗漏。
    rows.sort((a, b) => {
      if (!a.lastActiveAt) return b.lastActiveAt ? 1 : 0;
      if (!b.lastActiveAt) return -1;
      return Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
    });
    rows = rows.slice(0, max);
  }
  const graph = loadRoleGraph(db);
  const now = nowIso();
  const roleStmt = db.prepare('SELECT role_code, expires_at, granted_by, created_at FROM user_roles WHERE user_id = ? ORDER BY created_at');
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    lastActiveAt: row.lastActiveAt,
    roles: roleStmt.all(row.id).map((r) => ({
      code: r.role_code,
      name: graph.get(r.role_code)?.name || r.role_code,
      expiresAt: r.expires_at || null,
      expired: Boolean(r.expires_at && r.expires_at <= now),
      grantedBy: r.granted_by || '',
      createdAt: r.created_at,
    })),
  }));
}

export function listGuests({ limit = 200 } = {}) {
  return listGuestActivity(limit);
}

function requireUser(db, userId) {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(String(userId || ''));
  if (!user) throw new RbacError(404, '用户不存在');
  return user;
}

function checkGrantable(db, access, graph, roleCode) {
  const role = graph.get(roleCode);
  if (!role) throw new RbacError(404, '角色不存在');
  if (role.isVirtual) throw new RbacError(400, '游客是虚拟角色，不能授予');
  if (roleCode === BASE_ROLE) throw new RbacError(400, '所有登录用户默认拥有普通用户角色');
  if (roleCode === SUPERADMIN_ROLE) throw new RbacError(403, '超级管理员不能通过接口任命或撤销');
  if (isPrivilegedRole(db, graph, roleCode) && !canGrantAdmin(access)) {
    throw new RbacError(403, '只有超级管理员可以任命或撤销管理员');
  }
  return role;
}

export function grantUserRole(db, access, { userId, role, expiresAt }) {
  const roleCode = text(role, 32);
  const graph = loadRoleGraph(db);
  checkGrantable(db, access, graph, roleCode);
  const user = requireUser(db, userId);
  const expires = normalizeExpiresAt(expiresAt);
  return mutate(db, access, 'role.grant', 'user', user.id, { username: user.username, role: roleCode, expiresAt: expires }, () => {
    db.prepare(
      `INSERT INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, role_code) DO UPDATE SET expires_at = excluded.expires_at, granted_by = excluded.granted_by`
    ).run(user.id, roleCode, expires, actorOf(access)?.username || '', nowIso());
    return { userId: user.id, role: roleCode, expiresAt: expires };
  });
}

export function revokeUserRole(db, access, { userId, role }) {
  const roleCode = text(role, 32);
  const graph = loadRoleGraph(db);
  checkGrantable(db, access, graph, roleCode);
  const user = requireUser(db, userId);
  return mutate(db, access, 'role.revoke', 'user', user.id, { username: user.username, role: roleCode }, () => {
    const info = db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_code = ?').run(user.id, roleCode);
    if (!info.changes) throw new RbacError(404, '该用户没有此角色');
    return { userId: user.id, role: roleCode };
  });
}

// ── 角色 ──

export function listRoles(db) {
  const graph = loadRoleGraph(db);
  const ownStmt = db.prepare('SELECT perm_code FROM role_permissions WHERE role_code = ? ORDER BY perm_code');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE role_code = ? AND (expires_at IS NULL OR expires_at > ?)');
  const now = nowIso();
  return [...graph.values()]
    .sort((a, b) => a.level - b.level || a.code.localeCompare(b.code))
    .map((role) => ({
      ...role,
      perms: ownStmt.all(role.code).map((r) => r.perm_code),
      effectivePerms: [...permsForRoles(db, roleClosure(graph, [role.code]))].sort(),
      userCount: role.code === BASE_ROLE ? null : Number(countStmt.get(role.code, now)?.n || 0),
      privileged: isPrivilegedRole(db, graph, role.code),
    }));
}

function checkParent(db, access, graph, code, parent) {
  if (!parent) return null;
  if (!graph.has(parent)) throw new RbacError(400, '父角色不存在');
  if (code && roleClosure(graph, [parent]).has(code)) throw new RbacError(400, '角色继承不能成环');
  if (isPrivilegedRole(db, graph, parent) && !canGrantAdmin(access)) {
    throw new RbacError(403, '只有超级管理员可以创建继承管理员的角色');
  }
  return parent;
}

function checkLevel(access, level) {
  const n = Number(level);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new RbacError(400, '角色等级需为 0-1000 的整数');
  if (n >= 90 && !canGrantAdmin(access)) throw new RbacError(403, '等级 ≥ 90 的角色只能由超级管理员设置');
  return n;
}

export function createRole(db, access, body = {}) {
  const code = text(body.code, 32);
  if (!ROLE_CODE_PATTERN.test(code)) throw new RbacError(400, '角色编码需为小写字母开头的 2-32 位字母/数字/_/-');
  const name = text(body.name, 32);
  if (!name) throw new RbacError(400, '请填写角色名称');
  const graph = loadRoleGraph(db);
  if (graph.has(code)) throw new RbacError(409, '角色编码已存在');
  const parent = checkParent(db, access, graph, code, text(body.parent, 32) || BASE_ROLE);
  const level = checkLevel(access, body.level ?? (graph.get(parent)?.level ?? 10) + 1);
  const description = text(body.description, 200);
  return mutate(db, access, 'role.create', 'role', code, { name, parent, level }, () => {
    const now = nowIso();
    db.prepare(
      `INSERT INTO roles (code, name, parent_code, level, is_system, is_virtual, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`
    ).run(code, name, parent, level, description, now, now);
    return { code };
  });
}

export function updateRole(db, access, code, body = {}) {
  const graph = loadRoleGraph(db);
  const role = graph.get(code);
  if (!role) throw new RbacError(404, '角色不存在');
  if (isPrivilegedRole(db, graph, code) && !canGrantAdmin(access)) {
    throw new RbacError(403, '只有超级管理员可以修改管理员相关角色');
  }
  const next = { name: role.name, parent: role.parent, level: role.level, description: role.description };
  if (body.name !== undefined) {
    next.name = text(body.name, 32);
    if (!next.name) throw new RbacError(400, '请填写角色名称');
  }
  if (body.description !== undefined) next.description = text(body.description, 200);
  if (body.parent !== undefined || body.level !== undefined) {
    if (role.isSystem) throw new RbacError(400, '系统角色的继承关系与等级不可修改');
    if (body.parent !== undefined) next.parent = checkParent(db, access, graph, code, text(body.parent, 32) || null);
    if (body.level !== undefined) next.level = checkLevel(access, body.level);
  }
  return mutate(db, access, 'role.update', 'role', code, next, () => {
    db.prepare('UPDATE roles SET name = ?, parent_code = ?, level = ?, description = ?, updated_at = ? WHERE code = ?')
      .run(next.name, next.parent, next.level, next.description, nowIso(), code);
    return { code };
  });
}

export function deleteRole(db, access, code) {
  const graph = loadRoleGraph(db);
  const role = graph.get(code);
  if (!role) throw new RbacError(404, '角色不存在');
  if (role.isSystem) throw new RbacError(400, '系统角色不能删除');
  if (isPrivilegedRole(db, graph, code) && !canGrantAdmin(access)) throw new RbacError(403, '只有超级管理员可以删除管理员相关角色');
  if ([...graph.values()].some((r) => r.parent === code)) throw new RbacError(400, '请先调整继承该角色的子角色');
  return mutate(db, access, 'role.delete', 'role', code, { name: role.name }, () => {
    const removed = db.prepare('DELETE FROM user_roles WHERE role_code = ?').run(code).changes;
    db.prepare('DELETE FROM role_permissions WHERE role_code = ?').run(code);
    db.prepare('DELETE FROM roles WHERE code = ?').run(code);
    return { code, removedAssignments: removed };
  });
}

export function setRolePermissions(db, access, code, perms) {
  if (!Array.isArray(perms)) throw new RbacError(400, 'perms 需为数组');
  const graph = loadRoleGraph(db);
  if (!graph.has(code)) throw new RbacError(404, '角色不存在');
  const wanted = [...new Set(perms.map((p) => String(p || '').trim()).filter(Boolean))].sort();
  if (wanted.length > 500) throw new RbacError(400, '权限数量过多');
  const known = new Set(db.prepare('SELECT code FROM permissions').all().map((r) => r.code));
  const unknown = wanted.filter((p) => !known.has(p));
  if (unknown.length) throw new RbacError(400, `未知权限：${unknown.slice(0, 5).join(', ')}`);
  const current = db.prepare('SELECT perm_code FROM role_permissions WHERE role_code = ?').all(code).map((r) => r.perm_code);
  const added = wanted.filter((p) => !current.includes(p));
  const removed = current.filter((p) => !wanted.includes(p));
  const touchesPrivilegedPerm = [...added, ...removed].some((p) => PRIVILEGED_PERMS.has(p));
  if ((touchesPrivilegedPerm || isPrivilegedRole(db, graph, code)) && !canGrantAdmin(access)) {
    throw new RbacError(403, '只有超级管理员可以修改管理员相关权限');
  }
  return mutate(db, access, 'role.permissions', 'role', code, { added, removed }, () => {
    db.prepare('DELETE FROM role_permissions WHERE role_code = ?').run(code);
    const insert = db.prepare('INSERT INTO role_permissions (role_code, perm_code) VALUES (?, ?)');
    for (const perm of wanted) insert.run(code, perm);
    return { code, perms: wanted, added, removed };
  });
}

export function listPermissions(db) {
  return db.prepare('SELECT code, kind, menu_key, description FROM permissions ORDER BY kind, code').all()
    .map((r) => ({ code: r.code, kind: r.kind, menuKey: r.menu_key || null, description: r.description || '' }));
}

export function createPermission(db, access, body = {}) {
  const code = text(body.code, 72);
  if (!code.startsWith('api:') || !PERM_PATTERN.test(code)) throw new RbacError(400, '只能新增 api:<name> 权限（小写字母/数字/._-）');
  if (db.prepare('SELECT 1 FROM permissions WHERE code = ?').get(code)) throw new RbacError(409, '权限已存在');
  const description = text(body.description, 200);
  return mutate(db, access, 'permission.create', 'permission', code, { description }, () => {
    db.prepare('INSERT INTO permissions (code, kind, menu_key, description, created_at) VALUES (?, ?, NULL, ?, ?)')
      .run(code, 'api', description, nowIso());
    return { code };
  });
}

// ── 菜单 ──

export function listMenus(db) {
  return db.prepare('SELECT key, label, tab, icon, group_name, sort, parent_key, subtitle, enabled FROM menus ORDER BY sort, key').all()
    .map((r) => ({ key: r.key, label: r.label, tab: r.tab, icon: r.icon, group: r.group_name, sort: r.sort, parentKey: r.parent_key || null, subtitle: r.subtitle, enabled: Boolean(r.enabled) }));
}

function menuFields(body, base = {}) {
  const out = { ...base };
  if (body.label !== undefined) out.label = text(body.label, 32);
  if (body.tab !== undefined) out.tab = text(body.tab, 48);
  if (body.icon !== undefined) out.icon = text(body.icon, 48);
  if (body.group !== undefined) out.group = text(body.group, 24) || 'primary';
  if (body.sort !== undefined) {
    out.sort = Number(body.sort);
    if (!Number.isInteger(out.sort)) throw new RbacError(400, '排序需为整数');
  }
  if (body.subtitle !== undefined) out.subtitle = text(body.subtitle, 80);
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (body.parentKey !== undefined) out.parentKey = text(body.parentKey, 48) || null;
  if (!out.label) throw new RbacError(400, '请填写菜单名称');
  return out;
}

function checkMenuParent(db, key, parentKey) {
  if (!parentKey) return;
  if (parentKey === key) throw new RbacError(400, '菜单不能以自己为父级');
  let cursor = parentKey;
  for (let i = 0; cursor && i < 16; i += 1) {
    const row = db.prepare('SELECT key, parent_key FROM menus WHERE key = ?').get(cursor);
    if (!row) throw new RbacError(400, '父菜单不存在');
    if (row.parent_key === key) throw new RbacError(400, '菜单层级不能成环');
    cursor = row.parent_key;
  }
}

export function createMenu(db, access, body = {}) {
  const key = text(body.key, 48);
  if (!MENU_KEY_PATTERN.test(key)) throw new RbacError(400, '菜单 key 需为字母开头的 2-48 位字母/数字/_/-');
  if (db.prepare('SELECT 1 FROM menus WHERE key = ?').get(key)) throw new RbacError(409, '菜单 key 已存在');
  const fields = menuFields(body, { tab: key, icon: '', group: 'primary', sort: 1000, subtitle: '', enabled: 1, parentKey: null });
  checkMenuParent(db, key, fields.parentKey);
  return mutate(db, access, 'menu.create', 'menu', key, fields, () => {
    const now = nowIso();
    db.prepare(
      `INSERT INTO menus (key, label, tab, icon, group_name, sort, parent_key, subtitle, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(key, fields.label, fields.tab || key, fields.icon, fields.group, fields.sort, fields.parentKey, fields.subtitle, fields.enabled, now, now);
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (code, kind, menu_key, description, created_at) VALUES (?, ?, ?, ?, ?)');
    insertPerm.run(`menu:${key}:view`, 'menu_view', key, `${fields.label}（可见）`, now);
    insertPerm.run(`menu:${key}:access`, 'menu_access', key, `${fields.label}（可访问）`, now);
    return { key };
  });
}

export function updateMenu(db, access, key, body = {}) {
  const row = db.prepare('SELECT key, label, tab, icon, group_name, sort, parent_key, subtitle, enabled FROM menus WHERE key = ?').get(key);
  if (!row) throw new RbacError(404, '菜单不存在');
  const fields = menuFields(body, {
    label: row.label, tab: row.tab, icon: row.icon, group: row.group_name, sort: row.sort,
    subtitle: row.subtitle, enabled: row.enabled, parentKey: row.parent_key || null,
  });
  if (PROTECTED_MENUS.has(key) && !fields.enabled) throw new RbacError(400, '权限管理菜单不能停用');
  checkMenuParent(db, key, fields.parentKey);
  return mutate(db, access, 'menu.update', 'menu', key, fields, () => {
    db.prepare(
      `UPDATE menus SET label = ?, tab = ?, icon = ?, group_name = ?, sort = ?, parent_key = ?, subtitle = ?, enabled = ?, updated_at = ? WHERE key = ?`
    ).run(fields.label, fields.tab || key, fields.icon, fields.group, fields.sort, fields.parentKey, fields.subtitle, fields.enabled, nowIso(), key);
    return { key };
  });
}

export function deleteMenu(db, access, key) {
  if (PROTECTED_MENUS.has(key)) throw new RbacError(400, '权限管理菜单不能删除');
  const row = db.prepare('SELECT key, label FROM menus WHERE key = ?').get(key);
  if (!row) throw new RbacError(404, '菜单不存在');
  return mutate(db, access, 'menu.delete', 'menu', key, { label: row.label }, () => {
    db.prepare('UPDATE menus SET parent_key = NULL WHERE parent_key = ?').run(key);
    const perms = [`menu:${key}:view`, `menu:${key}:access`];
    db.prepare('DELETE FROM role_permissions WHERE perm_code IN (?, ?)').run(...perms);
    db.prepare('DELETE FROM permissions WHERE code IN (?, ?)').run(...perms);
    db.prepare('DELETE FROM menus WHERE key = ?').run(key);
    return { key };
  });
}

// ── 审计 ──

export function listAudit(db, { limit = 50, before = '', action = '', target = '' } = {}) {
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = [];
  const args = [];
  const beforeId = Number(before);
  if (Number.isInteger(beforeId) && beforeId > 0) { where.push('id < ?'); args.push(beforeId); }
  if (action) { where.push('action = ?'); args.push(text(action, 48)); }
  if (target) { where.push('(target_id = ? OR actor_username = ?)'); args.push(text(target, 64), text(target, 64)); }
  const sql = `SELECT id, actor_id, actor_username, action, target_type, target_id, detail, created_at FROM audit_log
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, max).map((r) => {
    let detail = {};
    try { detail = JSON.parse(r.detail || '{}'); } catch { detail = {}; }
    return { id: r.id, actorId: r.actor_id, actorUsername: r.actor_username, action: r.action, targetType: r.target_type, targetId: r.target_id, detail, createdAt: r.created_at };
  });
}

export { GUEST_ROLE };
