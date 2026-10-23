// 当前用户的菜单 / 角色缓存。
// - 登录、注册响应自带 RBAC 载荷，直接写入；
// - 之后通过 GET /api/sync/auth/me（已登录）或 /api/sync/auth/menus（游客）刷新；
// - 菜单缓存按 permVersion：版本不变时不替换对象、不触发重渲染；
// - 服务端不可达时游客使用内置兜底菜单，已登录用户沿用上次缓存。
// 这里的数据只决定「怎么展示」；所有权限仍由服务端每次请求重新计算。
import { apiUrl } from '../apiBase.js';
import { CLOUD_SYNC_SESSION_EVENT, loadCloudSession } from '../authSession.js';
import { buildGuestFallback, buildUserFallback } from './menuModel.js';

export const RBAC_STORE_KEY = 'aiDcaRbacMenus_v1';
export const RBAC_CHANGED_EVENT = 'rbac:changed';
const REFRESH_MIN_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8000;

let memoryState = null;
let inflight = null;
let lastFetchKey = '';
let lastFetchAt = 0;

function storage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function sessionKey(session) {
  return session?.accessToken ? `user:${session.userId || session.username}` : 'guest';
}

export function normalizeRbacPayload(payload = {}, { loggedIn, username = '' } = {}) {
  const isLoggedIn = loggedIn ?? Boolean(payload.loggedIn ?? payload.userId);
  return {
    loggedIn: Boolean(isLoggedIn),
    username: String(payload.username || username || ''),
    roles: Array.isArray(payload.roles) ? payload.roles.map((role) => ({
      code: String(role?.code || ''),
      name: String(role?.name || role?.code || ''),
      expiresAt: role?.expiresAt || null,
    })).filter((role) => role.code) : [],
    topRole: payload.topRole && payload.topRole.code ? { code: String(payload.topRole.code), name: String(payload.topRole.name || payload.topRole.code) } : null,
    menus: Array.isArray(payload.menus) ? payload.menus : [],
    perms: Array.isArray(payload.perms) ? payload.perms.map(String) : [],
    permVersion: String(payload.permVersion || ''),
    isAdmin: Boolean(payload.isAdmin),
    source: payload.source || 'server',
  };
}

function readStored() {
  const ls = storage();
  if (!ls) return null;
  try {
    const parsed = JSON.parse(ls.getItem(RBAC_STORE_KEY) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function emit(state) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(RBAC_CHANGED_EVENT, { detail: { state } }));
}

/** 当前会话可用的 RBAC 状态（同步读取，用于首屏渲染）。 */
export function readRbacState(session = loadCloudSession()) {
  const key = sessionKey(session);
  if (memoryState && memoryState.key === key) return memoryState.state;
  const stored = readStored();
  if (stored && stored.key === key && stored.state?.permVersion) {
    const loggedIn = Boolean(session?.accessToken) && stored.state.loggedIn !== false;
    memoryState = { key, state: normalizeRbacPayload(stored.state, { loggedIn, username: session?.username }) };
    return memoryState.state;
  }
  if (session?.accessToken) {
    // 已登录但尚无缓存：按 user 角色（或登录响应写入的 isAdmin）兜底展示，菜单待服务端刷新。
    const fallback = buildUserFallback({ isAdmin: Boolean(session.isAdmin) });
    return normalizeRbacPayload({
      ...fallback,
      roles: Array.isArray(session.roles) && session.roles.length ? session.roles : fallback.roles,
      topRole: session.topRole || fallback.topRole,
    }, { loggedIn: true, username: session.username });
  }
  return buildGuestFallback();
}

/** 写入服务端返回的 RBAC 载荷；permVersion 未变化时不触发更新。返回是否有变化。 */
export function applyRbacPayload(payload, { session = loadCloudSession(), loggedIn } = {}) {
  const key = sessionKey(session);
  const state = normalizeRbacPayload(payload, { loggedIn: loggedIn ?? Boolean(session?.accessToken), username: session?.username });
  const current = memoryState && memoryState.key === key ? memoryState.state : null;
  if (current && current.permVersion && current.permVersion === state.permVersion) return false;
  memoryState = { key, state };
  const ls = storage();
  try {
    ls?.setItem(RBAC_STORE_KEY, JSON.stringify({ key, state, savedAt: new Date().toISOString() }));
  } catch {
    // localStorage 满或不可用时只保留内存态。
  }
  emit(state);
  return true;
}

export function clearRbacState() {
  memoryState = null;
  lastFetchKey = '';
  lastFetchAt = 0;
  try {
    storage()?.removeItem(RBAC_STORE_KEY);
  } catch {
    // ignore
  }
  emit(buildGuestFallback());
}

async function fetchJson(path, token) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(apiUrl(path), { headers, credentials: 'same-origin', signal: controller?.signal });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 从服务端刷新。已登录走 /me（401 时退回 /menus 拿游客菜单，不擅自清除登录态）；游客走 /menus。
 * 60 秒内同一会话不重复请求（force 跳过）；并发调用共享同一个 inflight。
 */
export function refreshRbac({ force = false, fetchImpl = fetchJson } = {}) {
  const session = loadCloudSession();
  const key = sessionKey(session);
  if (!force && lastFetchKey === key && Date.now() - lastFetchAt < REFRESH_MIN_INTERVAL_MS) {
    return Promise.resolve(readRbacState(session));
  }
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = (async () => {
    try {
      let result = null;
      let loggedIn = Boolean(session?.accessToken);
      if (session?.accessToken) {
        result = await fetchImpl('/api/sync/auth/me', session.accessToken);
        if (result.status === 401) {
          // token 已失效：按游客展示（锁住的菜单点击会弹登录），登录态由账户模块自行处理。
          loggedIn = false;
          result = await fetchImpl('/api/sync/auth/menus', '');
        }
      } else {
        result = await fetchImpl('/api/sync/auth/menus', '');
      }
      if (result?.ok && Array.isArray(result.data?.menus)) {
        lastFetchKey = key;
        lastFetchAt = Date.now();
        applyRbacPayload(result.data, { session, loggedIn });
      }
    } catch {
      // 网络失败：保留缓存 / 兜底菜单。
    } finally {
      if (inflight?.promise === promise) inflight = null;
    }
    return readRbacState(session);
  })();
  inflight = { key, promise };
  return promise;
}

/** 登出时通知服务端清除 httpOnly 会话 cookie（尽力而为）。 */
export function notifyServerLogout(token) {
  try {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    return fetch(apiUrl('/api/sync/auth/logout'), { method: 'POST', headers, credentials: 'same-origin', keepalive: true }).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(CLOUD_SYNC_SESSION_EVENT, () => {
    memoryState = null;
    lastFetchKey = '';
    emit(readRbacState());
  });
}

export const __rbacStoreInternals = {
  reset() {
    memoryState = null;
    inflight = null;
    lastFetchKey = '';
    lastFetchAt = 0;
  },
};
