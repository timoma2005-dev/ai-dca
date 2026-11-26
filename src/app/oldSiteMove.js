import { isRemoteAccountSessionActive } from './accountRuntimeStore.js';
import { trackFeatureEvent } from './analytics.js';

// 旧站 freebacktrack.tech 搬家：旧站横幅用 window.open 打开 fast 站并通过 postMessage 传来游客的本机数据。
export const OLD_SITE_ORIGIN = 'https://freebacktrack.tech';
export const OLD_SITE_MOVE_QUERY = 'from';
export const OLD_SITE_MOVE_VALUE = 'old-site';
const MAX_TOTAL_CHARS = 5 * 1024 * 1024;
const ALLOWED_KEY = /^(aiDca[A-Za-z0-9_]+|markets:[A-Za-z0-9:_.-]+|holdings:[A-Za-z0-9:_.-]+|fundSwitch:[A-Za-z0-9:_.-]+|react-fund-holdings-[a-z-]+)$/;
const BLOCKED_KEY = /^(aiDcaCloudSync|aiDcaSecureSync|aiDcaAnalytics|aiDcaAccountAuthIntent|aiDcaNotifyClientConfig|aiDcaNetworkTrace|aiDcaLastNetworkTrace|aiDcaPendingToasts|aiDcaConversion|markets:(danjuan-quotes|direct-quotes|direct-search|fund-metrics-snapshots|otc-watch-cache))/;

export function isOldSiteMoveKey(key = '') {
  const value = String(key || '');
  return ALLOWED_KEY.test(value) && !BLOCKED_KEY.test(value);
}

export function isOldSiteMoveRequest(location = globalThis.location) {
  try {
    return new URLSearchParams(String(location?.search || '')).get(OLD_SITE_MOVE_QUERY) === OLD_SITE_MOVE_VALUE;
  } catch {
    return false;
  }
}

/** 只写新站上还没有的键，不覆盖新站已有数据。 */
export function importOldSiteEntries(entries, storage = globalThis.localStorage) {
  const result = { imported: [], skipped: [] };
  if (!entries || typeof entries !== 'object' || !storage) return result;
  let total = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (!isOldSiteMoveKey(key) || typeof value !== 'string') { result.skipped.push(key); continue; }
    total += key.length + value.length;
    if (total > MAX_TOTAL_CHARS || storage.getItem(key) !== null) { result.skipped.push(key); continue; }
    try {
      storage.setItem(key, value);
      result.imported.push(key);
    } catch {
      result.skipped.push(key);
    }
  }
  return result;
}

export function startOldSiteMoveReceiver({ win = globalThis.window, timeoutMs = 20000 } = {}) {
  if (!win || !isOldSiteMoveRequest(win.location)) return false;
  const auto = new URLSearchParams(String(win.location.search || '')).get('auto') || '';
  trackFeatureEvent('site_move', 'arrive', { auto, opener: Boolean(win.opener) });
  const cleanUrl = () => {
    try {
      const url = new URL(win.location.href);
      url.searchParams.delete(OLD_SITE_MOVE_QUERY);
      url.searchParams.delete('auto');
      win.history.replaceState(win.history.state, '', url.toString());
    } catch { /* ignore */ }
  };
  if (!win.opener) {
    cleanUrl();
    return true;
  }
  if (isRemoteAccountSessionActive()) {
    try { win.opener.postMessage({ type: 'ai-dca-move-done', imported: 0, reason: 'logged-in' }, OLD_SITE_ORIGIN); } catch { /* ignore */ }
    trackFeatureEvent('site_move', 'import_skipped', { reason: 'logged-in' });
    cleanUrl();
    return true;
  }
  const onMessage = (event) => {
    if (event.origin !== OLD_SITE_ORIGIN || event.data?.type !== 'ai-dca-move-data') return;
    win.removeEventListener('message', onMessage);
    const result = importOldSiteEntries(event.data.entries, win.localStorage);
    try {
      event.source?.postMessage({ type: 'ai-dca-move-done', imported: result.imported.length, skipped: result.skipped.length }, OLD_SITE_ORIGIN);
    } catch { /* ignore */ }
    trackFeatureEvent('site_move', 'import', { imported: result.imported.length, skipped: result.skipped.length });
    cleanUrl();
    if (result.imported.length) win.location.reload();
  };
  win.addEventListener('message', onMessage);
  win.setTimeout(() => win.removeEventListener('message', onMessage), timeoutMs);
  try { win.opener.postMessage({ type: 'ai-dca-move-ready' }, OLD_SITE_ORIGIN); } catch { /* ignore */ }
  return true;
}
