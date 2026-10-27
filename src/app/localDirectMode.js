// 「本地直连」模式状态：markets / fundSwitch 两个 tab 各自记住是否切到
// 浏览器直连行情厂商接口（腾讯 qt.gtimg.cn、东财 push2his、蛋卷），
// 与 public/auction-board.html 的直连链路同源，不经过后端 / Cloudflare Worker。
// 纯函数 + window 守卫，便于 node:test 覆盖；组件侧用 useLocalDirectMode 订阅。

export const LOCAL_DIRECT_MODE_KEY = 'markets:localDirectMode:v1';
export const LOCAL_DIRECT_MODE_EVENT = 'ai-dca:local-direct-mode-changed';

export const LOCAL_DIRECT_SCOPES = Object.freeze({
  MARKETS: 'markets',
  FUND_SWITCH: 'fundSwitch',
});

const VALID_SCOPES = new Set(Object.values(LOCAL_DIRECT_SCOPES));

function storage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // 隐私模式 / 存储被禁用时静默降级为内存默认值。
    return null;
  }
}

/** 读取整个桶并做形状校验，非法值一律回退默认（两个 scope 都关闭）。 */
export function readLocalDirectModes(store = storage()) {
  const fallback = { [LOCAL_DIRECT_SCOPES.MARKETS]: false, [LOCAL_DIRECT_SCOPES.FUND_SWITCH]: false };
  if (!store) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(store.getItem(LOCAL_DIRECT_MODE_KEY) || 'null');
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const next = { ...fallback };
  for (const scope of VALID_SCOPES) {
    if (typeof parsed[scope] === 'boolean') next[scope] = parsed[scope];
  }
  return next;
}

export function isLocalDirectMode(scope, store = storage()) {
  if (!VALID_SCOPES.has(scope)) return false;
  return Boolean(readLocalDirectModes(store)[scope]);
}

/** 写入某个 scope 的开关，返回最新整桶；同步派发变更事件供 React 订阅。 */
export function setLocalDirectMode(scope, enabled, store = storage()) {
  if (!VALID_SCOPES.has(scope)) throw new Error(`unknown local-direct scope: ${scope}`);
  const next = { ...readLocalDirectModes(store), [scope]: Boolean(enabled) };
  if (store) {
    try {
      store.setItem(LOCAL_DIRECT_MODE_KEY, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }));
    } catch {
      // 写入失败不阻断内存语义。
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(LOCAL_DIRECT_MODE_EVENT, { detail: { scope, enabled: Boolean(enabled) } }));
    } catch {
      // CustomEvent 不可用时忽略订阅通知。
    }
  }
  return next;
}

export function toggleLocalDirectMode(scope, store = storage()) {
  return setLocalDirectMode(scope, !isLocalDirectMode(scope, store), store);
}

/** 订阅跨组件的模式变更（含其它标签页 storage 事件），返回退订函数。 */
export function subscribeLocalDirectMode(handler, win = (typeof window !== 'undefined' ? window : null)) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  const onCustom = (event) => handler(event?.detail || {});
  const onStorage = (event) => {
    if (event?.key === LOCAL_DIRECT_MODE_KEY) handler({ scope: '', storage: true });
  };
  win.addEventListener(LOCAL_DIRECT_MODE_EVENT, onCustom);
  win.addEventListener('storage', onStorage);
  return () => {
    win.removeEventListener(LOCAL_DIRECT_MODE_EVENT, onCustom);
    win.removeEventListener('storage', onStorage);
  };
}
