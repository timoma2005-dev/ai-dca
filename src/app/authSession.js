import { clearAccountRuntimeStore, installAccountRemoteReadGuard } from './accountRuntimeStore.js';

installAccountRemoteReadGuard();

const SESSION_KEY = 'aiDcaCloudSyncSession';
const SESSION_EVENT = 'cloud-sync:session-changed';
const ACCOUNT_RUNTIME_META_KEYS = ['aiDcaAccountSyncState', 'aiDcaHoldingTransactionSyncState'];

function clearAccountRuntimeMetadata(ls) {
  for (const key of ACCOUNT_RUNTIME_META_KEYS) ls?.removeItem(key);
}

function safeStorage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function notifyCloudSessionChanged(session) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { session: session || null } }));
}

export function loadCloudSession() {
  const ls = safeStorage();
  if (!ls) return null;
  try {
    const parsed = JSON.parse(ls.getItem(SESSION_KEY) || 'null');
    if (!parsed?.accessToken || !parsed?.username) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCloudSession(session) {
  const ls = safeStorage();
  if (!ls) return null;
  const previous = loadCloudSession();
  const payload = {
    userId: String(session?.userId || ''),
    username: String(session?.username || ''),
    accessToken: String(session?.accessToken || ''),
    refreshToken: String(session?.refreshToken || ''),
    isAdmin: Boolean(session?.isAdmin),
    // 仅用于展示（头像角标等）；权限以服务端每次请求重新计算为准。
    roles: Array.isArray(session?.roles) ? session.roles.map((role) => ({
      code: String(role?.code || ''),
      name: String(role?.name || ''),
      expiresAt: role?.expiresAt || null
    })).filter((role) => role.code) : [],
    topRole: session?.topRole?.code ? { code: String(session.topRole.code), name: String(session.topRole.name || '') } : null,
    savedAt: new Date().toISOString()
  };
  if (previous?.userId !== payload.userId || previous?.username !== payload.username) {
    clearAccountRuntimeStore();
    clearAccountRuntimeMetadata(ls);
  }
  ls.setItem(SESSION_KEY, JSON.stringify(payload));
  notifyCloudSessionChanged(payload);
  return payload;
}

/**
 * RBAC 刷新后把最新角色写回本地会话（仅展示 / 统计用），不触发会话变化事件、不清运行时数据。
 * 只更新同一账号的会话；账号不一致时不动。
 */
export function updateCloudSessionAccess({ userId = '', username = '', roles = [], topRole = null, isAdmin = false } = {}) {
  const ls = safeStorage();
  const current = loadCloudSession();
  if (!ls || !current) return null;
  if ((userId && current.userId && String(userId) !== current.userId) || (username && String(username) !== current.username)) return null;
  const next = {
    ...current,
    isAdmin: Boolean(isAdmin),
    roles: Array.isArray(roles) ? roles.map((role) => ({
      code: String(role?.code || ''),
      name: String(role?.name || ''),
      expiresAt: role?.expiresAt || null
    })).filter((role) => role.code) : [],
    topRole: topRole?.code ? { code: String(topRole.code), name: String(topRole.name || '') } : null
  };
  ls.setItem(SESSION_KEY, JSON.stringify(next));
  return next;
}

export function clearCloudSession() {
  const ls = safeStorage();
  if (!ls) return;
  clearAccountRuntimeStore();
  clearAccountRuntimeMetadata(ls);
  ls.removeItem(SESSION_KEY);
  notifyCloudSessionChanged(null);
}

export const CLOUD_SYNC_SESSION_KEY = SESSION_KEY;
export const CLOUD_SYNC_SESSION_EVENT = SESSION_EVENT;
