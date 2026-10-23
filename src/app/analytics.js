import { trackEvent as trackPostHogEvent, trackPageView as trackPostHogPageView } from './posthog.js';
import { apiUrl } from './apiBase.js';

const STORE_KEY = 'aiDcaAnalyticsEvents_v1';
const PENDING_STORE_KEY = 'aiDcaAnalyticsPendingEvents_v1';
const VISITOR_KEY = 'aiDcaAnalyticsVisitorId_v1';
const SESSION_KEY = 'aiDcaAnalyticsSessionId_v1';
const CLOUD_SESSION_KEY = 'aiDcaCloudSyncSession';
const MAX_EVENTS = 5000;
const MAX_PENDING_EVENTS = 1000;
const ANALYTICS_BATCH_SIZE = 20;
const ANALYTICS_FLUSH_INTERVAL_MS = 30_000;
// 管理员 / 竞价看板权限改由服务端 RBAC 决定（见 docs/plan-rbac.md），这里不再写死用户名。
const RBAC_STORE_KEY = 'aiDcaRbacMenus_v1';
const PRIVILEGED_ROLE_CODES = new Set(['admin', 'superadmin']);
const SESSION_START_KEY = 'aiDcaAnalyticsSessionStarted_v1';
const OPT_OUT_KEY = 'aiDcaAnalyticsOptOut_v1';
const EVENT_STORE_RETRY_LIMITS = [MAX_EVENTS, 1000, 250, 50];
const PENDING_STORE_RETRY_LIMITS = [MAX_PENDING_EVENTS, 250, 50, 10];
const SENSITIVE_META_KEYS = new Set([
  'amount',
  'baseUrl',
  'connectionType',
  'content',
  'cpuCores',
  'deviceMemory',
  'devicePixelRatio',
  'password',
  'hardwareConcurrency',
  'languages',
  'maxTouchPoints',
  'memoryGb',
  'price',
  'platform',
  'raw',
  'remotePath',
  'saveData',
  'screenHeight',
  'screenWidth',
  'sendKey',
  'shares',
  'text',
  'touchPoints',
  'token',
  'uid',
  'url',
  'userAgent',
  'viewportHeight',
  'viewportWidth',
  'username'
]);

let analyticsFlushTimer = null;
let analyticsFlushInFlight = null;
let analyticsFlushHooksInstalled = false;

function safeStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage || null;
  } catch (_error) {
    return null;
  }
}

function safeSessionStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage || null;
  } catch (_error) {
    return null;
  }
}

function storageGetItem(storage, key) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch (_error) {
    return null;
  }
}

function storageSetItem(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch (_error) {
    return false;
  }
}

function storageRemoveItem(storage, key) {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch (_error) {
    return false;
  }
}

function getAnalyticsBase() {
  if (typeof window !== 'undefined' && window.__AI_DCA_SYNC_BASE__) {
    return String(window.__AI_DCA_SYNC_BASE__).replace(/\/$/, '');
  }
  return apiUrl('/api/sync');
}

function getAnalyticsEndpoint() {
  if (typeof window !== 'undefined' && window.__AI_DCA_ANALYTICS_ENDPOINT__) {
    return String(window.__AI_DCA_ANALYTICS_ENDPOINT__);
  }
  return `${getAnalyticsBase()}/analytics/track`;
}

function getAnalyticsFlushDelay() {
  if (typeof window === 'undefined') return ANALYTICS_FLUSH_INTERVAL_MS;
  const raw = Number(window.__AI_DCA_ANALYTICS_FLUSH_MS__);
  return Number.isFinite(raw) && raw >= 0 ? raw : ANALYTICS_FLUSH_INTERVAL_MS;
}

function randomId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function normalizeMetaValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 240);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => normalizeMetaValue(item, depth + 1));
  if (typeof value !== 'object' || depth >= 3) return String(value).slice(0, 240);
  const next = {};
  Object.entries(value).slice(0, 60).forEach(([key, entryValue]) => {
    if (SENSITIVE_META_KEYS.has(String(key))) return;
    next[key] = normalizeMetaValue(entryValue, depth + 1);
  });
  return next;
}

function sanitizeMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return {};
  return normalizeMetaValue(meta) || {};
}

export function isDoNotTrackEnabled() {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator || {};
  const raw = nav.doNotTrack || window.doNotTrack || nav.msDoNotTrack;
  const value = String(raw == null ? '' : raw).toLowerCase();
  return value === '1' || value === 'yes';
}

export function getAnalyticsOptOut() {
  const ls = safeStorage();
  if (!ls) return false;
  return storageGetItem(ls, OPT_OUT_KEY) === '1';
}

export function setAnalyticsOptOut(optedOut) {
  const ls = safeStorage();
  if (!ls) return;
  if (optedOut) {
    storageSetItem(ls, OPT_OUT_KEY, '1');
    storageRemoveItem(ls, PENDING_STORE_KEY);
  } else {
    storageRemoveItem(ls, OPT_OUT_KEY);
  }
  try {
    window.dispatchEvent(new CustomEvent('analytics:opt-out-changed', { detail: { optedOut: Boolean(optedOut) } }));
  } catch (_error) {
    // ignore
  }
}

export function isAnalyticsCollectionDisabled() {
  return getAnalyticsOptOut() || isDoNotTrackEnabled();
}

function coarseUserAgent(ua = '') {
  const value = String(ua);
  const os = /Windows/i.test(value) ? 'Windows'
    : /iPhone|iPad|iPod/i.test(value) ? 'iOS'
    : /Android/i.test(value) ? 'Android'
    : /Mac OS X|Macintosh/i.test(value) ? 'macOS'
    : /CrOS/i.test(value) ? 'ChromeOS'
    : /Linux/i.test(value) ? 'Linux'
    : 'Other';
  const browser = /Edg\//i.test(value) ? 'Edge'
    : /OPR\/|Opera/i.test(value) ? 'Opera'
    : /Firefox\//i.test(value) ? 'Firefox'
    : /Chrome\//i.test(value) ? 'Chrome'
    : /Safari\//i.test(value) ? 'Safari'
    : 'Other';
  return `${browser} / ${os}`;
}

function getDeviceContext() {
  if (typeof window === 'undefined') return {};
  const nav = window.navigator || {};
  const standalone = Boolean(
    nav.standalone ||
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: fullscreen)')?.matches
  );
  const ua = String(nav.userAgent || '');
  const viewportWidth = Number(window.innerWidth || 0);
  const deviceClass = /iPad|Tablet/i.test(ua) || (viewportWidth >= 768 && viewportWidth <= 1180 && Number(nav.maxTouchPoints || 0) > 0)
    ? 'tablet'
    : /Mobi|Android|iPhone|iPod/i.test(ua) || (viewportWidth > 0 && viewportWidth < 768)
      ? 'mobile'
      : 'desktop';
  return {
    deviceClass,
    language: String(nav.language || '').slice(0, 32),
    timezone: Intl.DateTimeFormat?.().resolvedOptions?.().timeZone || '',
    online: Boolean(nav.onLine),
    standalone
  };
}

function getRouteContext() {
  if (typeof window === 'undefined') return {};
  const hash = String(window.location.hash || '');
  const query = new URLSearchParams(window.location.search || '');
  return {
    hash: hash.slice(0, 120),
    tabQuery: String(query.get('tab') || ''),
    routeDepth: hash ? hash.split('/').filter(Boolean).length : 0
  };
}

const ATTRIBUTION_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

function getAttributionContext() {
  if (typeof window === 'undefined') return {};
  const out = {};
  const referrer = String((typeof document !== 'undefined' && document.referrer) || '').trim();
  if (referrer) out.referrer = referrer.slice(0, 240);
  try {
    const query = new URLSearchParams(window.location.search || '');
    const utm = {};
    for (const key of ATTRIBUTION_UTM_KEYS) {
      const value = String(query.get(key) || '').trim();
      if (value) utm[key] = value.slice(0, 120);
    }
    if (Object.keys(utm).length) out.utm = utm;
  } catch {
    // 查询参数解析失败时仅保留 referrer。
  }
  return out;
}

export function getAnalyticsVisitorId() {
  const ls = safeStorage();
  if (!ls) return 'server';
  if (isAnalyticsCollectionDisabled()) return 'visitor:disabled';
  let id = storageGetItem(ls, VISITOR_KEY);
  if (!id) {
    id = randomId('visitor');
    storageSetItem(ls, VISITOR_KEY, id);
  }
  return id;
}

export function getAnalyticsSessionId() {
  const storage = safeSessionStorage();
  if (!storage) return 'server-session';
  if (isAnalyticsCollectionDisabled()) return 'session:disabled';
  let id = storageGetItem(storage, SESSION_KEY);
  if (!id) {
    id = randomId('session');
    storageSetItem(storage, SESSION_KEY, id);
  }
  return id;
}

function readEvents() {
  return readStoredEventArray(STORE_KEY);
}

function readStoredEventArray(key) {
  const ls = safeStorage();
  if (!ls) return [];
  try {
    const parsed = JSON.parse(storageGetItem(ls, key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeStoredEventArray(key, events, limits) {
  const ls = safeStorage();
  if (!ls) return false;
  const cleaned = Array.isArray(events) ? events.filter((event) => event && typeof event === 'object') : [];
  if (!cleaned.length) {
    storageRemoveItem(ls, key);
    return true;
  }
  const retryLimits = Array.from(new Set(limits.filter((limit) => Number.isFinite(limit) && limit > 0))).sort((a, b) => b - a);
  for (const limit of retryLimits) {
    const value = JSON.stringify(cleaned.slice(-limit));
    if (storageSetItem(ls, key, value)) return true;
    storageRemoveItem(ls, key);
  }
  storageRemoveItem(ls, key);
  return false;
}

function writeEvents(events) {
  writeStoredEventArray(STORE_KEY, events, EVENT_STORE_RETRY_LIMITS);
}

function readPendingEvents() {
  return readStoredEventArray(PENDING_STORE_KEY);
}

function writePendingEvents(events) {
  writeStoredEventArray(PENDING_STORE_KEY, events, PENDING_STORE_RETRY_LIMITS);
}

function removePendingEvents(sentEvents) {
  const sentIds = new Set(sentEvents.map((event) => event?.id).filter(Boolean));
  if (!sentIds.size) return;
  writePendingEvents(readPendingEvents().filter((event) => !sentIds.has(event?.id)));
}

function enqueuePendingEvent(event) {
  if (!event) return;
  const pending = readPendingEvents();
  pending.push(event);
  writePendingEvents(pending);
  scheduleAnalyticsFlush({ immediate: pending.length >= ANALYTICS_BATCH_SIZE });
}

function installAnalyticsFlushHooks() {
  if (analyticsFlushHooksInstalled || typeof window === 'undefined' || !window.addEventListener) return;
  analyticsFlushHooksInstalled = true;
  window.addEventListener('online', () => scheduleAnalyticsFlush({ immediate: true }));
  window.addEventListener('pagehide', () => {
    flushAnalyticsEvents({ useBeacon: true });
  });
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAnalyticsEvents({ useBeacon: true });
    });
  }
}

function scheduleAnalyticsFlush({ immediate = false } = {}) {
  if (typeof window === 'undefined' || isAnalyticsCollectionDisabled()) return;
  installAnalyticsFlushHooks();
  if (analyticsFlushInFlight || !readPendingEvents().length) return;
  if (analyticsFlushTimer) {
    if (!immediate) return;
    window.clearTimeout?.(analyticsFlushTimer);
    analyticsFlushTimer = null;
  }
  const delay = immediate ? 0 : getAnalyticsFlushDelay();
  if (typeof window.setTimeout === 'function') {
    analyticsFlushTimer = window.setTimeout(() => {
      analyticsFlushTimer = null;
      flushAnalyticsEvents();
    }, delay);
  } else if (immediate) {
    flushAnalyticsEvents();
  }
}

export async function flushAnalyticsEvents({ useBeacon = false } = {}) {
  if (typeof window === 'undefined') return { ok: false, sent: 0 };
  if (analyticsFlushTimer) {
    window.clearTimeout?.(analyticsFlushTimer);
    analyticsFlushTimer = null;
  }
  if (isAnalyticsCollectionDisabled()) {
    writePendingEvents([]);
    return { ok: false, sent: 0 };
  }
  if (analyticsFlushInFlight) return analyticsFlushInFlight;
  const batch = readPendingEvents().slice(0, ANALYTICS_BATCH_SIZE);
  if (!batch.length) return { ok: true, sent: 0 };

  const payload = JSON.stringify({ events: batch });
  const endpoint = getAnalyticsEndpoint();
  const nav = window.navigator || {};
  if (useBeacon && nav.sendBeacon) {
    const ok = nav.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' }));
    if (ok) removePendingEvents(batch);
    return { ok, sent: ok ? batch.length : 0 };
  }
  if (typeof fetch !== 'function') return { ok: false, sent: 0 };

  analyticsFlushInFlight = fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    keepalive: true
  }).then((response) => {
    if (!response?.ok) return { ok: false, sent: 0 };
    removePendingEvents(batch);
    return { ok: true, sent: batch.length };
  }).catch(() => ({ ok: false, sent: 0 })).finally(() => {
    analyticsFlushInFlight = null;
    if (readPendingEvents().length) scheduleAnalyticsFlush();
  });
  return analyticsFlushInFlight;
}

export function readAnalyticsSession() {
  const ls = safeStorage();
  if (!ls) return null;
  try {
    const parsed = JSON.parse(storageGetItem(ls, CLOUD_SESSION_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

// 读取菜单缓存里与当前会话匹配的 RBAC 状态（只用于前端展示，服务端会再次校验）。
function readRbacSnapshot(session) {
  if (!session?.accessToken && !session?.userId && !session?.username) return null;
  const ls = safeStorage();
  if (!ls) return null;
  try {
    const parsed = JSON.parse(storageGetItem(ls, RBAC_STORE_KEY) || 'null');
    const key = `user:${session.userId || session.username}`;
    return parsed?.key === key ? parsed.state || null : null;
  } catch (_error) {
    return null;
  }
}

function roleCodesOf(value) {
  return (Array.isArray(value?.roles) ? value.roles : []).map((role) => String(role?.code || ''));
}

export function isAnalyticsAdmin(session = readAnalyticsSession()) {
  if (!session) return false;
  if (session.isAdmin) return true;
  if (roleCodesOf(session).some((code) => PRIVILEGED_ROLE_CODES.has(code))) return true;
  if (PRIVILEGED_ROLE_CODES.has(String(session.topRole?.code || ''))) return true;
  const snapshot = readRbacSnapshot(session);
  return Boolean(snapshot?.isAdmin) || roleCodesOf(snapshot).some((code) => PRIVILEGED_ROLE_CODES.has(code));
}

/** 是否可访问某个菜单（menu:<key>:access）；perms 优先取传入对象，其次取菜单缓存。 */
export function canAccessMenuFromSession(session = readAnalyticsSession(), menuKey = '') {
  if (!session || !menuKey) return false;
  const perm = `menu:${menuKey}:access`;
  if (Array.isArray(session.perms) && session.perms.includes(perm)) return true;
  const snapshot = readRbacSnapshot(session);
  return Array.isArray(snapshot?.perms) && snapshot.perms.includes(perm);
}

export function canAccessAdminAuction(session = readAnalyticsSession()) {
  if (isAnalyticsAdmin(session)) return true;
  return canAccessMenuFromSession(session, 'adminAuction');
}

export function trackAnalyticsEvent(type, meta = {}) {
  if (!type || typeof window === 'undefined') return null;
  if (isAnalyticsCollectionDisabled()) return null;
  const session = readAnalyticsSession();
  const safeMeta = sanitizeMeta(meta);
  const nav = window.navigator || {};
  const event = {
    id: randomId('event'),
    type: String(type),
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    visitorId: getAnalyticsVisitorId(),
    sessionId: getAnalyticsSessionId(),
    userId: String(session?.userId || ''),
    username: String(session?.username || ''),
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    referrer: document.referrer || '',
    userAgent: coarseUserAgent(nav.userAgent || ''),
    meta: {
      ...safeMeta,
      context: {
        ...getRouteContext(),
        ...getAttributionContext(),
        ...getDeviceContext(),
        ...(safeMeta.context && typeof safeMeta.context === 'object' ? safeMeta.context : {})
      }
    }
  };
  const events = readEvents();
  events.push(event);
  writeEvents(events);

  try {
    window.dispatchEvent(new CustomEvent('analytics:changed', { detail: { event } }));
  } catch (_error) {
    // ignore
  }

  // 同步到 PostHog
  try {
    trackPostHogEvent(type, {
      ...safeMeta,
      visitorId: event.visitorId,
      sessionId: event.sessionId,
      userId: event.userId,
      username: event.username,
      path: event.path
    });
  } catch (error) {
    // PostHog 错误不应影响核心埋点
  }

  enqueuePendingEvent(event);

  return event;
}

export function trackPageView(tab) {
  // 同步到 PostHog
  try {
    trackPostHogPageView({ tab: tab || '' });
  } catch (error) {
    // ignore
  }

  return trackAnalyticsEvent('page_view', { tab: tab || '', feature: 'navigation', action: 'page_view' });
}

function normalizeAdSlotMeta(meta = {}) {
  return {
    slotId: String(meta.slotId || '').slice(0, 80),
    pageTab: String(meta.pageTab || '').slice(0, 40),
    position: String(meta.position || '').slice(0, 80),
    adProvider: String(meta.adProvider || meta.provider || '').slice(0, 60),
    isMobile: Boolean(meta.isMobile),
    visibleMs: Math.max(0, Math.round(Number(meta.visibleMs) || 0)),
    viewport: String(meta.viewport || '').slice(0, 40)
  };
}

export function trackAdSlotView(meta = {}) {
  const payload = normalizeAdSlotMeta(meta);
  if (!payload.slotId) return null;
  return trackAnalyticsEvent('ad_slot_view', {
    feature: 'ads',
    action: 'slot_view',
    ...payload
  });
}

export function trackAdSlotClick(meta = {}) {
  const payload = normalizeAdSlotMeta(meta);
  if (!payload.slotId) return null;
  return trackAnalyticsEvent('ad_slot_click', {
    feature: 'ads',
    action: 'slot_click',
    ...payload
  });
}

export function trackSessionStart(meta = {}) {
  if (typeof window === 'undefined') return null;
  const storage = safeSessionStorage();
  const sessionId = getAnalyticsSessionId();
  if (storageGetItem(storage, SESSION_START_KEY) === sessionId) return null;
  storageSetItem(storage, SESSION_START_KEY, sessionId);
  return trackAnalyticsEvent('session_start', {
    feature: 'session',
    action: 'start',
    ...meta
  });
}

export function trackSessionHeartbeat(meta = {}) {
  return trackAnalyticsEvent('session_heartbeat', {
    feature: 'session',
    action: 'heartbeat',
    ...meta
  });
}

export function trackPageEngagement(meta = {}) {
  return trackAnalyticsEvent('page_engagement', {
    feature: 'engagement',
    action: 'page_engagement',
    tab: String(meta.tab || '').slice(0, 40),
    durationMs: Math.max(0, Math.round(Number(meta.durationMs) || 0)),
    activeTimeMs: Math.max(0, Math.round(Number(meta.activeTimeMs) || 0)),
    maxScrollPct: Math.max(0, Math.min(100, Math.round(Number(meta.maxScrollPct) || 0))),
    visibilityChanges: Math.max(0, Math.round(Number(meta.visibilityChanges) || 0))
  });
}

export function trackFeatureEvent(feature, action, meta = {}) {
  return trackAnalyticsEvent(`${feature}_${action}`, {
    feature,
    action,
    ...meta
  });
}

export function trackActionResult(feature, action, status, meta = {}) {
  return trackFeatureEvent(feature, action, {
    status,
    ok: status === 'success',
    ...meta
  });
}

export async function withAnalyticsTiming(feature, action, fn, meta = {}) {
  const startedAt = Date.now();
  trackFeatureEvent(feature, `${action}_start`, meta);
  try {
    const result = await fn();
    trackActionResult(feature, action, 'success', {
      ...meta,
      durationMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    trackActionResult(feature, action, 'error', {
      ...meta,
      durationMs: Date.now() - startedAt,
      errorName: error?.name || '',
      errorMessage: String(error?.message || error || '').slice(0, 160)
    });
    throw error;
  }
}

export { STORE_KEY as ANALYTICS_STORE_KEY };
