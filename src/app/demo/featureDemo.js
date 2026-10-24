// 付费功能「可交互演示」：在真实页面组件外面套一层沙箱，让未开通的用户先上手体验。
// - localStorage 写入只进内存覆盖层（不落盘、不同步），退出演示后丢弃；
// - fetch 拦截：命中 fixtures 的请求返回示例数据；写用户数据的接口（同步 / 账户 / 通知）一律拒绝；
//   其余请求（公开行情等）照常放行；
// - 每个功能每天可体验 DEMO_RUNS_PER_DAY 次、每次 durationSec 秒。

export const DEMO_RUNS_PER_DAY = 3;
export const DEMO_QUOTA_KEY = 'aiDcaFeatureDemoQuota';
export const DEMO_READONLY_CODE = 'DEMO_READONLY';
export const DEMO_READONLY_MESSAGE = '演示模式下不会保存，开通后即可正常使用';

// ready=false 的功能暂不提供演示（守卫页不显示体验按钮）。
export const DEMO_FEATURES = {
  markets: {
    ready: true,
    durationSec: 300,
    pitch: '实时行情、溢价与净值走势，多只基金同屏对比。',
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

export function createStorageSandbox(storage) {
  const overlay = new Map();
  let originals = null;
  let writes = 0;
  const proto = storage ? Object.getPrototypeOf(storage) : null;
  return {
    get writes() { return writes; },
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

/** 安装演示环境；dirty 表示演示期间有过本地写入或被拦截的写请求（退出时需刷新页面丢弃内存状态）。 */
export function installFeatureDemo(tab, { win = globalThis.window, onBlocked } = {}) {
  const feature = DEMO_FEATURES[tab] || { fixtures: {} };
  const sandbox = createStorageSandbox(win?.localStorage);
  const realFetch = win.fetch;
  let blocked = 0;
  sandbox.install();
  win.fetch = createDemoFetch({
    realFetch: realFetch.bind(win),
    fixtures: feature.fixtures,
    origin: win.location?.origin,
    onBlocked: (key) => { blocked += 1; onBlocked?.(key); },
  });
  return {
    get dirty() { return sandbox.writes > 0 || blocked > 0; },
    uninstall() {
      win.fetch = realFetch;
      sandbox.uninstall();
    },
  };
}
