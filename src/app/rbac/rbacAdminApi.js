// 权限管理接口客户端（services/auth /api/sync/auth/admin/*）。服务端每次请求都会按 token 重新校验 api:rbac-admin。
import { apiUrl } from '../apiBase.js';
import { loadCloudSession } from '../authSession.js';

async function request(method, path, body) {
  const token = loadCloudSession()?.accessToken || '';
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(apiUrl(`/api/sync/auth/admin${path}`), {
    method,
    headers,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || `请求失败：HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const enc = encodeURIComponent;

export const rbacAdminApi = {
  searchUsers: (q) => request('GET', `/users?q=${enc(q || '')}&limit=500`),
  // 分析事件存于 CF sync Worker 的 D1，游客聚合从 CF 接口读取。
  listGuests: async () => {
    const token = loadCloudSession()?.accessToken || '';
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(apiUrl('/api/sync/analytics/guests?limit=200'), {
      method: 'GET',
      headers,
      credentials: 'same-origin',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.message || `请求失败：HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  },
  grantRole: (userId, role, expiresAt) => request('POST', `/users/${enc(userId)}/roles`, { role, expiresAt: expiresAt || null }),
  revokeRole: (userId, role) => request('DELETE', `/users/${enc(userId)}/roles/${enc(role)}`, {}),
  listRoles: () => request('GET', '/roles'),
  createRole: (body) => request('POST', '/roles', body),
  updateRole: (code, body) => request('PATCH', `/roles/${enc(code)}`, body),
  deleteRole: (code) => request('DELETE', `/roles/${enc(code)}`, {}),
  setRolePermissions: (code, perms) => request('PUT', `/roles/${enc(code)}/permissions`, { perms }),
  listPermissions: () => request('GET', '/permissions'),
  createPermission: (body) => request('POST', '/permissions', body),
  listMenus: () => request('GET', '/menus'),
  createMenu: (body) => request('POST', '/menus', body),
  updateMenu: (key, body) => request('PATCH', `/menus/${enc(key)}`, body),
  deleteMenu: (key) => request('DELETE', `/menus/${enc(key)}`, {}),
  listAudit: ({ before = '', target = '', action = '' } = {}) => request('GET', `/audit?limit=50&before=${enc(before)}&target=${enc(target)}&action=${enc(action)}`),
};

/** 把日期输入（YYYY-MM-DD，按北京时间当天 23:59:59）转成 ISO；空值表示永久。 */
export function expiryInputToIso(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return new Date(`${text}T23:59:59+08:00`).toISOString();
}

/** 角色权限勾选模型：menus × (view, access) + api 权限；区分本级与继承。 */
export function buildPermissionMatrix({ role, roles = [], permissions = [], menus = [] }) {
  const own = new Set(role?.perms || []);
  const parent = roles.find((r) => r.code === role?.parent);
  const inherited = new Set(parent?.effectivePerms || []);
  const known = new Set(permissions.map((p) => p.code));
  const menuRows = menus.map((menu) => ({
    key: menu.key,
    label: menu.label,
    view: { code: `menu:${menu.key}:view`, own: own.has(`menu:${menu.key}:view`), inherited: inherited.has(`menu:${menu.key}:view`), exists: known.has(`menu:${menu.key}:view`) },
    access: { code: `menu:${menu.key}:access`, own: own.has(`menu:${menu.key}:access`), inherited: inherited.has(`menu:${menu.key}:access`), exists: known.has(`menu:${menu.key}:access`) },
  }));
  const apiRows = permissions.filter((p) => p.kind === 'api').map((p) => ({
    code: p.code, description: p.description, own: own.has(p.code), inherited: inherited.has(p.code),
  }));
  return { menuRows, apiRows };
}
