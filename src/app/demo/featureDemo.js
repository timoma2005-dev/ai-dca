// 付费功能「可交互演示」：在真实页面组件外面套一层沙箱，让未开通的用户先上手体验。
// - localStorage 写入只进内存覆盖层（不落盘、不同步），退出演示后丢弃；
// - fetch 拦截：命中 fixtures 的请求返回示例数据；写用户数据的接口（同步 / 账户 / 通知）一律拒绝；
//   其余请求（公开行情等）照常放行；
// - 按数据类型限制（limit）：
//   time  持续刷新的数据（行情、竞价看板）：每次限时 durationSec 秒，每天 DEMO_RUNS_PER_DAY 次；
//   count 一次性数据（雷达）：不计时、不限次，只渲染前 visibleRows 条，其余用占位假行遮罩（见 rbac/demo-lock.jsx）；
//   save  需要保存的数据（持仓、计划、换基、通知、数据修复）：不计时、不限次，手动「结束演示」/ 离开 / 刷新即结束，
//         keeps=true 的演示内容按 keepKeys 保留 15 分钟并在注册/升级后带入。

export const DEMO_LIMITS = Object.freeze({ TIME: 'time', COUNT: 'count', SAVE: 'save' });
export const DEMO_RUNS_PER_DAY = 3;
export const DEMO_QUOTA_KEY = 'aiDcaFeatureDemoQuota';
export const DEMO_READONLY_CODE = 'DEMO_READONLY';
export const DEMO_READONLY_MESSAGE = '演示模式下不会保存，开通后即可正常使用';
// 演示中保存的内容（keepKeys）在演示结束后保留 15 分钟：期间注册 / 升级会自动带入账号，再次体验也会接着用。
export const DEMO_RETAIN_MS = 15 * 60 * 1000;
export const DEMO_SESSION_KEY = 'aiDcaFeatureDemoSession';
import { DEMO_ACCESS_TOKEN, DEMO_ACTIVE_FLAG, isFeatureDemoActive } from './demoMode.js';

export { DEMO_ACCESS_TOKEN, DEMO_ACTIVE_FLAG, isFeatureDemoActive };

// 演示功能注册表（轻量元数据）。重的 mock 数据在 src/app/demo/fixtures/<tab>.js，开始演示时才动态加载。
// fixtures 模块约定（default export，全部可选）：
//   keepKeys: string[]                         演示中保存、保留 15 分钟并在注册/升级后带入账号的 localStorage key
//   seed(): [key, string | null][]             演示开始时放进存储覆盖层的 mock 本地数据（不落盘；null 表示演示中视为不存在）
//   createFixtures({ state }): { routes, getState }
//       routes: { 'METHOD /path': body | ({ url, method, init, body }) => body }，按 pathname 匹配（忽略域名）
//       getState(): 可序列化的 mock 服务端状态（如演示中新建的通知规则），随演示内容一起保留 15 分钟
//   pruneKept(entries, { seed }): 演示结束时过滤要保留的 keepKeys 内容（返回空数组则不保留）
//   prepareImport(entries, { seed, storage }): 带入账号前过滤 keepKeys 内容（例如去掉 seed 的示例条目、并入账号现有数据）
//   importState(state, { fetch }): 升级后把 mock 服务端状态写到真实接口（可选）
// points: 守卫页介绍要点（2–3 条短句，每条一行）；旧的 pitch 字符串字段守卫页仍兼容。
// limit: 'time' | 'count' | 'save'（见文件头）；time 用 durationSec，count 用 visibleRows，keeps 表示演示内容会带入账号。
// ready=false 的功能暂不提供演示（守卫页不显示体验按钮）。
export const DEMO_FEATURES = {
  markets: {
    ready: true,
    limit: 'time',
    durationSec: 180,
    keeps: true,
    points: ['自选基金实时行情，涨跌溢价一眼看清', '净值、溢价走势图随手切换', '多只基金同屏对比，强弱立判'],
    load: async () => ({ default: { keepKeys: ['markets:watchlist:v1'] } }),
  },
  fundSwitch: {
    ready: true,
    limit: 'save',
    keeps: true,
    points: ['实时对比各只纳指 ETF 的溢价差', '设好切出、切回阈值，命中就提醒', '回测找最优阈值，一键生成方案'],
    // mock 方案配置与快照 GET；保存 / 测试 / 自动填充等写入由演示框架拦截。回测生成的换基偏好保留并在注册/升级后带入。
    load: () => import('./fixtures/fundSwitch.js'),
  },
  notify: {
    ready: true,
    limit: 'save',
    points: ['Bark、Server酱、邮件多渠道推送', '换基信号、溢价预警、每日持仓摘要', '推送记录随时可查'],
    // mock 渠道状态、推送记录、持仓规则与换基方案 GET；保存 / 启停 / 测试 / 同步等写入由演示框架拦截。
    load: () => import('./fixtures/notify.js'),
  },
  adminRadar: {
    ready: true,
    limit: 'count',
    visibleRows: 3,
    points: ['12 只纳指 QDII ETF 溢价一张表', '找出当前最划算的切换组合', '历史分位判断现在贵不贵'],
    // 只读演示：mock 雷达快照 GET，计算按钮仍仅管理员可见（POST 被演示框架拦截）。
    load: () => import('./fixtures/adminRadar.js'),
  },
  adminAuction: {
    ready: true,
    limit: 'time',
    durationSec: 180,
    points: ['开盘前看各 ETF 相对纳指期货的偏离', '自动提示卖哪只、买哪只', '溢价过高提前预警停牌'],
    // 演示 tab 内 iframe 改指 /auction-board-demo.html（与正式页同一渲染逻辑的模拟行情 / 时钟，不请求真实行情，localStorage 用 demo_ 前缀）。
  },
  holdings: {
    ready: true,
    limit: 'save',
    keeps: true,
    points: ['ETF 和场外基金，市值收益一屏看清', '换基配对逐笔追踪，每轮赚多少一目了然', '收益曲线和今日换基信号'],
    // 游客读 seed 的本地账本；已登录走 mock 交易行 / 资金配置接口。演示中不推送；新增的自洽交易保留并在注册/升级后并入账号。
    load: () => import('./fixtures/holdings.js'),
  },
  tradePlans: {
    ready: true,
    limit: 'save',
    keeps: true,
    points: ['按回撤分档加仓，到价提醒', '定期或智能定投，高位少投低位多投', '计划和持仓自动对齐'],
    // 本地 seed 加仓 / 定投计划，mock 账号计划资源与通知状态 GET；演示中不云同步。新建的计划保留并在注册/升级后按 id 带入。
    load: () => import('./fixtures/tradePlans.js'),
  },
  dataRepair: {
    ready: true,
    limit: 'save',
    points: ['一键扫描持仓记录里的错误', '清理错位、重复的记录', '补全基金名称和类别'],
    // 演示账本（同持仓演示）混入待修复问题，mock 基金字典与云端交易行 GET；修复只改演示本地底账，退出即丢弃，云端写入由演示框架 403。
    load: () => import('./fixtures/dataRepair.js'),
  },
};

export async function loadDemoModule(tab) {
  const feature = DEMO_FEATURES[tab];
  if (!feature?.load) return {};
  const mod = await feature.load();
  return (mod && (mod.default || mod)) || {};
}

// 演示期间禁止写入的用户数据接口（GET 照常放行，命中 fixtures 的除外）。
const WRITE_BLOCKED_PREFIXES = ['/api/sync', '/sync', '/api/account', '/api/notify', '/api/holdings/ocr', '/api/ocr'];
const WRITE_ALLOWED_PREFIXES = ['/api/sync/analytics/', '/api/sync/auth/'];

export function demoFeatureFor(tab) {
  const feature = DEMO_FEATURES[tab];
  return feature && feature.ready ? feature : null;
}

/** 演示限制方式：{ limit, timed, durationSec（仅 time）, visibleRows（仅 count）, keeps, perDay（Infinity 表示不限次） }。 */
export function demoLimitOf(tab) {
  const feature = DEMO_FEATURES[tab] || {};
  const limit = Object.values(DEMO_LIMITS).includes(feature.limit) ? feature.limit : DEMO_LIMITS.TIME;
  const timed = limit === DEMO_LIMITS.TIME;
  return {
    limit,
    timed,
    durationSec: timed ? Math.max(1, Number(feature.durationSec) || 180) : null,
    visibleRows: limit === DEMO_LIMITS.COUNT ? Math.max(0, Number(feature.visibleRows) || 3) : Infinity,
    keeps: Boolean(feature.keeps),
    perDay: timed ? DEMO_RUNS_PER_DAY : Infinity,
  };
}

/** 横幅第二行：按限制方式说明（time 限时、count 部分数据、save 演示数据去留）。 */
export function demoBannerNote(limit, { guest = false, roleLabel = 'VIP' } = {}) {
  const limitInfo = typeof limit === 'string' ? demoLimitOf(limit) : limit;
  const cta = guest ? '注册' : '升级';
  if (limitInfo.limit === 'count') return `演示仅展示部分数据，${guest ? '注册' : `升级 ${roleLabel} `}后查看全部`;
  if (limitInfo.limit === 'save') return limitInfo.keeps ? `演示数据，结束演示后删除；${cta}后可保留你新增的内容` : '演示数据，结束演示后删除';
  return limitInfo.keeps ? `演示内容保留 ${Math.round(DEMO_RETAIN_MS / 60000)} 分钟，请尽快${cta}后保留数据` : '模拟数据，到时自动结束演示';
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

// 次数只限 time 类（持续刷新的行情要靠限时 + 限次控制）；count / save 类不计次（unlimited）。
export function demoQuotaFor(tab, { storage = globalThis.localStorage, now = Date.now(), perDay = demoLimitOf(tab).perDay } = {}) {
  if (!Number.isFinite(perDay)) return { used: 0, remaining: Infinity, perDay, unlimited: true };
  const quota = readQuota(storage, shanghaiDay(now));
  const used = Math.max(0, Number(quota.used[tab]) || 0);
  return { used, remaining: Math.max(0, perDay - used), perDay };
}

export function consumeDemoQuota(tab, { storage = globalThis.localStorage, now = Date.now(), perDay = demoLimitOf(tab).perDay } = {}) {
  if (!Number.isFinite(perDay)) return true;
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

/** 路由匹配：先精确 "METHOD /path"，再前缀 "METHOD /path/*"（取最长前缀）。 */
export function matchFixture(fixtures, method, pathname) {
  const exact = fixtures[`${method} ${pathname}`];
  if (exact !== undefined) return exact;
  let best;
  let bestLen = -1;
  for (const key of Object.keys(fixtures)) {
    if (!key.endsWith('*') || !key.startsWith(`${method} `)) continue;
    const prefix = key.slice(method.length + 1, -1);
    if (pathname.startsWith(prefix) && prefix.length > bestLen) {
      best = fixtures[key];
      bestLen = prefix.length;
    }
  }
  return best;
}

function carriesDemoToken(input, init) {
  try {
    const headers = new Headers(init?.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
    return String(headers.get('authorization') || '').includes(DEMO_ACCESS_TOKEN);
  } catch {
    return false;
  }
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
    const fixture = matchFixture(fixtures, method, url.pathname);
    if (fixture !== undefined) {
      let body = typeof init?.body === 'string' ? init.body : null;
      if (body == null && typeof Request !== 'undefined' && input instanceof Request) body = await input.clone().text().catch(() => null);
      const value = typeof fixture === 'function' ? await fixture({ url, method, init, body }) : fixture;
      const payload = value && typeof value === 'object' && typeof value.file === 'string' ? await loadFile(value.file) : value;
      if (payload instanceof Response) return payload;
      return payload == null ? jsonResponse({ ok: false, error: '示例数据暂不可用' }, 503) : jsonResponse(payload);
    }
    if (carriesDemoToken(input, init)) {
      // 游客演示的占位令牌：没有 mock 的请求一律不发到真实服务器。
      if (method === 'GET' || method === 'HEAD') return jsonResponse({ ok: false, code: 'DEMO_NO_FIXTURE', error: '演示数据暂不可用' }, 503);
      onBlocked?.(`${method} ${url.pathname}`);
      return jsonResponse({ ok: false, code: DEMO_READONLY_CODE, error: DEMO_READONLY_MESSAGE }, 403);
    }
    if (isDemoBlockedWrite(method, url.pathname)) {
      onBlocked?.(`${method} ${url.pathname}`);
      return jsonResponse({ ok: false, code: DEMO_READONLY_CODE, error: DEMO_READONLY_MESSAGE }, 403);
    }
    return realFetch(input, init);
  };
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

function hasContent(item) {
  return (Array.isArray(item?.entries) && item.entries.length > 0) || (item?.state != null);
}

/** 未过期的演示内容：{ entries, state, expiresAt } 或 null。 */
export function readDemoSession(tab, { storage = globalThis.localStorage, now = Date.now() } = {}) {
  const item = readSessions(storage)[tab];
  if (!item || !(Number(item.expiresAt) > now) || !hasContent(item)) return null;
  return { entries: Array.isArray(item.entries) ? item.entries : [], state: item.state ?? null, expiresAt: Number(item.expiresAt) };
}

export function saveDemoSession(tab, entries, { state = null, storage = globalThis.localStorage, now = Date.now() } = {}) {
  const sessions = readSessions(storage);
  for (const [key, item] of Object.entries(sessions)) if (!(Number(item?.expiresAt) > now)) delete sessions[key];
  const item = { entries, state: state ?? null, expiresAt: now + DEMO_RETAIN_MS };
  if (hasContent(item)) sessions[tab] = item;
  else delete sessions[tab];
  writeSessions(storage, sessions);
}

/**
 * 注册 / 升级后：把有权限的功能的演示内容写回真实存储（经由正常的 setItem，云同步会照常推送），并清掉已过期的。
 * 返回 [{ tab, state }]：state 为 mock 服务端状态，由调用方再交给 importDemoState 写到真实接口。
 */
export async function importDemoSessions({ canAccess, storage = globalThis.localStorage, now = Date.now(), fetchImpl } = {}) {
  const sessions = readSessions(storage);
  const imported = [];
  for (const [tab, item] of Object.entries(sessions)) {
    if (!(Number(item?.expiresAt) > now)) { delete sessions[tab]; continue; }
    if (!canAccess?.(tab)) continue;
    delete sessions[tab];
    imported.push({ tab, item });
  }
  writeSessions(storage, sessions);
  const done = [];
  for (const { tab, item } of imported) {
    let mod = {};
    try { mod = await loadDemoModule(tab); } catch { mod = {}; }
    const keep = mod.keepKeys || [];
    let entries = (item.entries || []).filter(([key, value]) => keep.includes(key) && typeof value === 'string');
    if (typeof mod.prepareImport === 'function') {
      try { entries = mod.prepareImport(entries, { seed: typeof mod.seed === 'function' ? mod.seed() : [], storage }) || []; } catch { entries = []; }
    }
    for (const [key, value] of entries) {
      try { storage.setItem(key, value); } catch { /* ignore */ }
    }
    if (item.state != null && typeof mod.importState === 'function') {
      try { await mod.importState(item.state, { fetch: fetchImpl || globalThis.fetch?.bind(globalThis) }); } catch { /* 写入失败不影响本地内容 */ }
    }
    done.push(tab);
  }
  return done;
}

/** 安装演示环境（module 为 loadDemoModule 的结果）；dirty 表示演示期间有过本地写入或被拦截的写请求（退出时需刷新页面丢弃内存状态）。 */
export function installFeatureDemo(tab, { win = globalThis.window, onBlocked, module: mod = {} } = {}) {
  const keepKeys = mod.keepKeys || [];
  const resumed = readDemoSession(tab, { storage: win?.localStorage });
  const seeded = typeof mod.seed === 'function' ? (mod.seed() || []) : [];
  const initial = new Map(seeded);
  for (const [key, value] of resumed?.entries || []) if (keepKeys.includes(key)) initial.set(key, value);
  const sandbox = createStorageSandbox(win?.localStorage, [...initial.entries()]);
  const created = typeof mod.createFixtures === 'function' ? (mod.createFixtures({ state: resumed?.state ?? null }) || {}) : {};
  const routes = created.routes || {};
  const realFetch = win.fetch;
  let blocked = 0;
  sandbox.install();
  win[DEMO_ACTIVE_FLAG] = tab;
  win.fetch = createDemoFetch({
    realFetch: realFetch.bind(win),
    fixtures: routes,
    origin: win.location?.origin,
    onBlocked: (key) => { blocked += 1; onBlocked?.(key); },
  });
  const seedMap = new Map(seeded);
  let done = false;
  return {
    resumed: Boolean(resumed),
    get dirty() { return sandbox.writes > 0 || blocked > 0; },
    /** 卸载沙箱，并把用户改动过的 keepKeys 内容与 mock 服务端状态保存 15 分钟（写在真实存储的 DEMO_SESSION_KEY 里）。 */
    uninstall() {
      if (done) return;
      done = true;
      let kept = sandbox.entries(keepKeys).filter(([key, value]) => seedMap.get(key) !== value);
      if (typeof mod.pruneKept === 'function') { try { kept = mod.pruneKept(kept, { seed: seeded }) || []; } catch { kept = []; } }
      let state = null;
      try { state = typeof created.getState === 'function' ? created.getState() : null; } catch { state = null; }
      win.fetch = realFetch;
      sandbox.uninstall();
      delete win[DEMO_ACTIVE_FLAG];
      if (kept.length || state != null || resumed) saveDemoSession(tab, kept, { state, storage: win?.localStorage });
    },
  };
}
