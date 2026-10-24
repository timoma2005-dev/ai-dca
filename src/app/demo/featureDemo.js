// 付费功能「可交互演示」：在真实页面组件外面套一层沙箱，让未开通的用户先上手体验。
// - localStorage 写入只进内存覆盖层（不落盘、不同步），退出演示后丢弃；
// - fetch 拦截：命中 fixtures 的请求返回示例数据；写用户数据的接口（同步 / 账户 / 通知）一律拒绝；
//   其余请求（公开行情等）照常放行；
// - 每个功能每天可体验 DEMO_RUNS_PER_DAY 次、每次 durationSec 秒。

export const DEMO_RUNS_PER_DAY = 3;
export const DEMO_QUOTA_KEY = 'aiDcaFeatureDemoQuota';
export const DEMO_READONLY_CODE = 'DEMO_READONLY';
export const DEMO_READONLY_MESSAGE = '演示模式下不会保存，开通后即可正常使用';
// 演示中保存的内容（keepKeys）在演示结束后保留 15 分钟：期间注册 / 升级会自动带入账号，再次体验也会接着用。
export const DEMO_RETAIN_MS = 15 * 60 * 1000;
export const DEMO_SESSION_KEY = 'aiDcaFeatureDemoSession';
export const DEMO_ACTIVE_FLAG = '__AI_DCA_FEATURE_DEMO__';

// ready=false 的功能暂不提供演示（守卫页不显示体验按钮）。
export const DEMO_FEATURES = {
  markets: {
    ready: true,
    durationSec: 300,
    pitch: '实时行情、溢价与净值走势，多只基金同屏对比。',
    keepKeys: ['markets:watchlist:v1'],
    fixtures: {},
  },
  fundSwitch: { ready: false, durationSec: 300, pitch: '', fixtures: {} },
  notify: { ready: false, durationSec: 300, pitch: '', fixtures: {} },
  adminRadar: { ready: false, durationSec: 300, pitch: '', fixtures: {} },
  adminAuction: { ready: false, durationSec: 300, pitch: '', fixtures: {} },
};

// 演示期间禁止写入的用户数据接口（GET 照常放行，命中 fixtures 的除外）。
const WRITE_BLOCKED_PREFIXES = ['/api/sync', '/sync', '/api/account', '/api/notify', '/api/holdings/ocr', '/api/ocr'];
const WRITE_ALLOWED_PREFIXES = ['/api/sync/analytics/', '/api/sync/auth/'];

export function demoFeatureFor(tab) {
  const feature = DEMO_FEATURES[tab];
  return feature && feature.ready ? feature : null;
}

function shanghaiDay(now) {
  return new Date(Number(now) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function readQuota(storage, day) {
  try {
    const parsed = JSON.parse(storage?.getItem(DEMO_QUOTA_KEY) || 'null');
    return parsed && parsed.day === day && parsed.used && typeof parsed.used === 'object' ? parsed : { day, used: {} };
  } catch {
    return { day, used: {} };
  }
}

export function demoQuotaFor(tab, { storage = globalThis.localStorage, now = Date.now(), perDay = DEMO_RUNS_PER_DAY } = {}) {
  const quota = readQuota(storage, shanghaiDay(now));
  const used = Math.max(0, Number(quota.used[tab]) || 0);
  return { used, remaining: Math.max(0, perDay - used), perDay };
}

export function consumeDemoQuota(tab, { storage = globalThis.localStorage, now = Date.now(), perDay = DEMO_RUNS_PER_DAY } = {}) {
  const day = shanghaiDay(now);
  const quota = readQuota(storage, day);
  const used = Math.max(0, Number(quota.used[tab]) || 0);
  if (used >= perDay) return false;
  quota.used[tab] = used + 1;
  try { storage?.setItem(DEMO_QUOTA_KEY, JSON.stringify(quota)); } catch { /* 存储不可用时不限次 */ }
  return true;
}

export function createStorageSandbox(storage, initial = []) {
  const overlay = new Map(initial);
  let originals = null;
  let writes = 0;
  const proto = storage ? Object.getPrototypeOf(storage) : null;
  return {
    get writes() { return writes; },
    entries(keys) {
      return [...overlay.entries()].filter(([k, v]) => v !== null && (!keys || keys.includes(k)));
    },
    install() {
      if (originals || !proto) return;
      originals = { getItem: proto.getItem, setItem: proto.setItem, removeItem: proto.removeItem, clear: proto.clear };
      const o = originals;
      proto.getItem = function getItem(key) {
        if (this !== storage) return o.getItem.call(this, key);
        const k = String(key);
        return overlay.has(k) ? overlay.get(k) : o.getItem.call(this, k);
      };
      proto.setItem = function setItem(key, value) {
        if (this !== storage) return o.setItem.call(this, key, value);
        writes += 1;
        overlay.set(String(key), String(value));
      };
      proto.removeItem = function removeItem(key) {
        if (this !== storage) return o.removeItem.call(this, key);
        writes += 1;
        overlay.set(String(key), null);
      };
      proto.clear = function clear() {
        if (this !== storage) return o.clear.call(this);
        writes += 1;
        for (let i = 0; i < storage.length; i += 1) overlay.set(storage.key(i), null);
      };
    },
    uninstall() {
      if (!originals || !proto) return;
      Object.assign(proto, originals);
      originals = null;
      overlay.clear();
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-demo': '1' } });
}

function requestParts(input, init, origin) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const rawUrl = isRequest ? input.url : String(input instanceof URL ? input.href : input);
  const url = new URL(rawUrl, origin);
  const method = String(init?.method || (isRequest ? input.method : '') || 'GET').toUpperCase();
  return { url, method };
}

export function isDemoBlockedWrite(method, pathname) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (WRITE_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return WRITE_BLOCKED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`));
}

/**
 * fixtures：{ 'GET /api/notify/switch/config': body | (ctx) => body | { file: '/demo/x.json' } }
 * 按 pathname 匹配（忽略域名，兼容 apiUrlWithFallback 的备用域名）。
 */
export function createDemoFetch({ realFetch, fixtures = {}, onBlocked, origin = globalThis.location?.origin || 'http://localhost' }) {
  const fileCache = new Map();
  async function loadFile(file) {
    if (!fileCache.has(file)) {
      fileCache.set(file, realFetch(file, { cache: 'force-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    }
    return fileCache.get(file);
  }
  return async function demoFetch(input, init) {
    let parts;
    try { parts = requestParts(input, init, origin); } catch { return realFetch(input, init); }
    const { url, method } = parts;
    const fixture = fixtures[`${method} ${url.pathname}`];
    if (fixture !== undefined) {
      const value = typeof fixture === 'function' ? await fixture({ url, method, init }) : fixture;
      const body = value && typeof value === 'object' && typeof value.file === 'string' ? await loadFile(value.file) : value;
      return body == null ? jsonResponse({ ok: false, error: '示例数据暂不可用' }, 503) : jsonResponse(body);
    }
    if (isDemoBlockedWrite(method, url.pathname)) {
      onBlocked?.(`${method} ${url.pathname}`);
      return jsonResponse({ ok: false, code: DEMO_READONLY_CODE, error: DEMO_READONLY_MESSAGE }, 403);
    }
    return realFetch(input, init);
  };
}

export function isFeatureDemoActive(win = globalThis.window) {
  return Boolean(win && win[DEMO_ACTIVE_FLAG]);
}

function readSessions(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(DEMO_SESSION_KEY) || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSessions(storage, sessions) {
  try {
    if (Object.keys(sessions).length) storage?.setItem(DEMO_SESSION_KEY, JSON.stringify(sessions));
    else storage?.removeItem(DEMO_SESSION_KEY);
  } catch { /* ignore */ }
}

/** 未过期的演示内容：{ entries, expiresAt } 或 null。 */
export function readDemoSession(tab, { storage = globalThis.localStorage, now = Date.now() } = {}) {
  const item = readSessions(storage)[tab];
  if (!item || !(Number(item.expiresAt) > now) || !Array.isArray(item.entries) || !item.entries.length) return null;
  return { entries: item.entries, expiresAt: Number(item.expiresAt) };
}

export function saveDemoSession(tab, entries, { storage = globalThis.localStorage, now = Date.now() } = {}) {
  const sessions = readSessions(storage);
  for (const [key, item] of Object.entries(sessions)) if (!(Number(item?.expiresAt) > now)) delete sessions[key];
  if (entries.length) sessions[tab] = { entries, expiresAt: now + DEMO_RETAIN_MS };
  else delete sessions[tab];
  writeSessions(storage, sessions);
}

/**
 * 注册 / 升级后：把有权限的功能的演示内容写回真实存储（经由正常的 setItem，云同步会照常推送），并清掉已过期的。
 * 返回带入的功能 tab 列表。
 */
export function importDemoSessions({ canAccess, storage = globalThis.localStorage, now = Date.now() } = {}) {
  const sessions = readSessions(storage);
  const imported = [];
  for (const [tab, item] of Object.entries(sessions)) {
    if (!(Number(item?.expiresAt) > now)) { delete sessions[tab]; continue; }
    if (!canAccess?.(tab)) continue;
    const keep = DEMO_FEATURES[tab]?.keepKeys || [];
    for (const [key, value] of item.entries || []) {
      if (keep.includes(key) && typeof value === 'string') {
        try { storage.setItem(key, value); } catch { /* ignore */ }
      }
    }
    delete sessions[tab];
    imported.push(tab);
  }
  writeSessions(storage, sessions);
  return imported;
}

/** 安装演示环境；dirty 表示演示期间有过本地写入或被拦截的写请求（退出时需刷新页面丢弃内存状态）。 */
export function installFeatureDemo(tab, { win = globalThis.window, onBlocked } = {}) {
  const feature = DEMO_FEATURES[tab] || { fixtures: {} };
  const keepKeys = feature.keepKeys || [];
  const resumed = readDemoSession(tab, { storage: win?.localStorage });
  const sandbox = createStorageSandbox(win?.localStorage, resumed ? resumed.entries.filter(([k]) => keepKeys.includes(k)) : []);
  const realFetch = win.fetch;
  let blocked = 0;
  sandbox.install();
  win[DEMO_ACTIVE_FLAG] = tab;
  win.fetch = createDemoFetch({
    realFetch: realFetch.bind(win),
    fixtures: feature.fixtures,
    origin: win.location?.origin,
    onBlocked: (key) => { blocked += 1; onBlocked?.(key); },
  });
  let done = false;
  return {
    resumed: Boolean(resumed),
    get dirty() { return sandbox.writes > 0 || blocked > 0; },
    /** 卸载沙箱，并把 keepKeys 内容保存 15 分钟（写在真实存储里，不进任何业务 key）。 */
    uninstall() {
      if (done) return;
      done = true;
      const kept = sandbox.entries(keepKeys);
      win.fetch = realFetch;
      sandbox.uninstall();
      delete win[DEMO_ACTIVE_FLAG];
      if (kept.length || resumed) saveDemoSession(tab, kept, { storage: win?.localStorage });
    },
  };
}
