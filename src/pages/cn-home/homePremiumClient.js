// 首页长周期溢价数据：/api/etf-history/home-premium.json（nginx auth_request api:etf-history，SVIP）。
// 内存缓存 10 分钟（按会话），不写 localStorage（付费数据不落盘）。
import { apiUrl } from '../../app/apiBase.js';
import { loadCloudSession } from '../../app/authSession.js';

const TTL = 10 * 60 * 1000;
const memory = new Map();
let inflight = null;

export async function loadHomePremium({ refresh = false } = {}) {
  const s = loadCloudSession();
  const key = s?.userId || s?.username || 'guest';
  const hit = memory.get(key);
  if (!refresh && hit && Date.now() - hit.at < TTL) return hit.value;
  if (inflight) return inflight;
  const headers = { Accept: 'application/json' };
  if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;
  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(apiUrl('/api/etf-history/home-premium.json'), { headers, credentials: 'same-origin', redirect: 'manual', signal: controller.signal });
      if (res.status === 401) return { state: 'login' };
      if (res.status === 403) return { state: 'locked' };
      if (!res.ok) return { state: 'error', reason: `http_${res.status}` };
      const data = await res.json();
      if (!Array.isArray(data?.dates) || !Array.isArray(data?.funds)) return { state: 'error', reason: 'invalid_payload' };
      const value = { state: 'ready', data };
      memory.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      return { state: 'error', reason: e?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}
