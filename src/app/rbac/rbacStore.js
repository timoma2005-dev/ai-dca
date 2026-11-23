// 当前用户的菜单 / 角色缓存。
// - 登录、注册响应自带 RBAC 载荷，直接写入；
// - 之后通过 GET /api/sync/auth/me（已登录）或 /api/sync/auth/menus（游客）刷新；
// - 菜单缓存按 permVersion：版本不变时不替换对象、不触发重渲染；
// - 服务端不可达时游客使用内置兜底菜单，已登录用户沿用上次缓存。
// - 自动刷新（授权 / 会员升级后不用重新登录）：切回前台、聚焦、联网、bfcache 恢复、页面可见时每 5 分钟；
//   任一同源响应带 X-Perm-Version 且与缓存不一致、付费接口返回 403、收到角色开通站内信时强制刷新。
// 这里的数据只决定「怎么展示」；所有权限仍由服务端每次请求重新计算。
import { apiUrl } from '../apiBase.js';
import { CLOUD_SYNC_SESSION_EVENT, loadCloudSession, updateCloudSessionAccess } from '../authSession.js';
import { showToast } from '../toast.js';
import { buildGuestFallback, buildUserFallback } from './menuModel.js';
import { normalizeMembership, sameMembership } from '../membership.js';

export const RBAC_STORE_KEY = 'aiDcaRbacMenus_v1';
export const RBAC_CHANGED_EVENT = 'rbac:changed';
const REFRESH_MIN_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8000;
export const AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
const DENIED_REFRESH_MIN_MS = 10_000;
export const PERM_VERSION_HEADER = 'x-perm-version';
export const RBAC_ROLE_NOTICE_EVENT = 'ai-dca-role-notice';
export const RBAC_UPGRADED_EVENT = 'rbac:upgraded';
const UPGRADE_ROLES = Object.freeze({ vip: 'VIP', svip: 'SVIP' });

let memoryState = null;
let inflight = null;
let lastFetchKey = '';
let lastFetchAt = 0;
let lastDeniedAt = 0;
let autoRefreshInstalled = false;

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
    // 游客 / 会话失效时不保留任何身份字段，避免退出后仍渲染缓存里的用户名。
    username: isLoggedIn ? String(payload.username || username || '') : '',
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
    // 会员进度（注册天数 / 近 30 天活跃）；游客为 null。
    membership: isLoggedIn ? normalizeMembership(payload.membership) : null,
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
  // 旧版本可能把残留 cookie 返回的会员菜单写进了 guest 缓存（带用户名）：视为污染，丢弃。
  const taintedGuestCache = key === 'guest' && Boolean(stored?.state?.username);
  if (stored && stored.key === key && stored.state?.permVersion && !taintedGuestCache) {
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
  const clientLoggedIn = loggedIn ?? Boolean(session?.accessToken);
  // 本地已是游客，但服务端仍凭残留的 httpOnly cookie 返回了登录用户的菜单：丢弃，避免游客看到会员菜单 / 用户名。
  if (!clientLoggedIn && (payload?.loggedIn || payload?.userId)) return false;
  const state = normalizeRbacPayload(payload, { loggedIn: clientLoggedIn, username: session?.username });
  const current = memoryState && memoryState.key === key ? memoryState.state : null;
  if (current && current.permVersion && current.permVersion === state.permVersion && sameMembership(current.membership, state.membership)) return false;
  const upgraded = detectUpgrade(current, state);
  memoryState = { key, state };
  if (clientLoggedIn) syncSessionAccess(session, state);
  const ls = storage();
  try {
    ls?.setItem(RBAC_STORE_KEY, JSON.stringify({ key, state, savedAt: new Date().toISOString() }));
  } catch {
    // localStorage 满或不可用时只保留内存态。
  }
  emit(state);
  if (upgraded) announceUpgrade(upgraded);
  return true;
}

/** 同一会话内新获得 VIP / SVIP（授权或会员自动升级）时返回新角色；首次加载、兜底菜单不算。 */
function detectUpgrade(previous, next) {
  if (!previous?.loggedIn || !next?.loggedIn) return null;
  if (!previous.permVersion || previous.permVersion === 'guest-fallback' || previous.source === 'fallback') return null;
  const before = new Set((previous.roles || []).map((role) => role.code));
  const gained = (next.roles || []).filter((role) => UPGRADE_ROLES[role.code] && !before.has(role.code));
  if (!gained.length) return null;
  return gained.find((role) => role.code === 'svip') || gained[0];
}

function announceUpgrade(role) {
  if (typeof window === 'undefined') return;
  const label = UPGRADE_ROLES[role.code] || role.name || role.code;
  window.dispatchEvent(new CustomEvent(RBAC_UPGRADED_EVENT, { detail: { role } }));
  try {
    showToast({ title: `已开通 ${label}`, description: '权限已生效，无需重新登录。', durationMs: 5000 });
  } catch {
    // toast 不可用时忽略
  }
}

/** 把最新角色写回本地会话（只用于展示 / 统计口径），不触发会话变化事件。 */
function syncSessionAccess(session, state) {
  try {
    updateCloudSessionAccess({ userId: session?.userId, username: session?.username, roles: state.roles, topRole: state.topRole, isAdmin: state.isAdmin });
  } catch {
    // ignore
  }
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

// 游客菜单请求不带 cookie：退出后若服务端 cookie 未清掉，也不能拿到上一个账号的菜单与用户名。
const GUEST_FETCH_OPTIONS = Object.freeze({ credentials: 'omit' });

async function fetchJson(path, token, { credentials = 'same-origin' } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(apiUrl(path), { headers, credentials, signal: controller?.signal });
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
          result = await fetchImpl('/api/sync/auth/menus', '', GUEST_FETCH_OPTIONS);
        }
      } else {
        result = await fetchImpl('/api/sync/auth/menus', '', GUEST_FETCH_OPTIONS);
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

/** 某个响应带回的权限版本与缓存不一致时强制刷新。返回是否触发了刷新。 */
export function notePermVersion(version, { session = loadCloudSession(), fetchImpl } = {}) {
  const value = String(version || '').trim();
  if (!value || !session?.accessToken) return false;
  const current = readRbacState(session);
  if (!current?.loggedIn || current.permVersion === value) return false;
  refreshRbac({ force: true, ...(fetchImpl ? { fetchImpl } : {}) });
  return true;
}

/** 付费接口返回 403：权限可能刚变（授权 / 升级 / 到期），强制刷新一次；10 秒内只刷一次。 */
export function notePermDenied({ now = Date.now(), fetchImpl } = {}) {
  const session = loadCloudSession();
  if (!session?.accessToken) return false;
  if (now - lastDeniedAt < DENIED_REFRESH_MIN_MS) return false;
  lastDeniedAt = now;
  refreshRbac({ force: true, ...(fetchImpl ? { fetchImpl } : {}) });
  return true;
}

function observeResponse(response) {
  try {
    const version = response?.headers?.get?.(PERM_VERSION_HEADER);
    if (version) notePermVersion(version);
  } catch {
    // ignore
  }
}

/**
 * 安装自动刷新（幂等）：切回前台 / 聚焦 / 联网 / bfcache 恢复 / 定时（仅页面可见时）走 60 秒去重的刷新；
 * 角色开通站内信强制刷新；包一层 window.fetch，读取同源响应的 X-Perm-Version。
 */
export function installRbacAutoRefresh({ win = typeof window !== 'undefined' ? window : null, intervalMs = AUTO_REFRESH_INTERVAL_MS } = {}) {
  if (!win || autoRefreshInstalled) return false;
  autoRefreshInstalled = true;
  const doc = win.document;
  const isVisible = () => !doc || doc.visibilityState !== 'hidden';
  const softRefresh = () => {
    if (isVisible()) refreshRbac();
  };
  doc?.addEventListener?.('visibilitychange', softRefresh);
  win.addEventListener('focus', softRefresh);
  win.addEventListener('online', softRefresh);
  win.addEventListener('pageshow', (event) => {
    if (event?.persisted) refreshRbac({ force: true });
  });
  win.addEventListener(RBAC_ROLE_NOTICE_EVENT, () => refreshRbac({ force: true }));
  if (intervalMs > 0 && typeof win.setInterval === 'function') win.setInterval(softRefresh, intervalMs);
  if (typeof win.fetch === 'function' && !win.fetch.__rbacObserved) {
    const originalFetch = win.fetch;
    const observedFetch = function observedFetch(...args) {
      return originalFetch.apply(this === undefined || this === observedFetch ? win : this, args).then((response) => {
        observeResponse(response);
        return response;
      });
    };
    observedFetch.__rbacObserved = true;
    win.fetch = observedFetch;
  }
  return true;
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
    lastDeniedAt = 0;
  },
  resetAutoRefresh() {
    autoRefreshInstalled = false;
  },
};
