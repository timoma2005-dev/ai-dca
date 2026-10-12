const API_ORIGIN = String(import.meta.env?.VITE_API_ORIGIN || '').replace(/\/$/, '');

// 用户相关请求直连 CF Worker（cn 主机 → CF 边缘的 TTFB 高达 16-18s）。
// 详见 docs/plan-frontend-direct-api.md。
const DIRECT_API_ORIGIN = 'https://api.freebacktrack.tech';

// 用户相关路径前缀走直连；/api/ocr 为精确匹配（仅 '/api/ocr' 与 '/api/ocr?...'），
// 避免误伤同前缀的其它路径。
const DIRECT_API_PREFIXES = ['/api/account/', '/api/sync/', '/api/notify/', '/api/holdings/', '/api/ocr'];

export function isDirectApiPath(path = '') {
  const p = String(path || '');
  return DIRECT_API_PREFIXES.some((prefix) =>
    prefix === '/api/ocr' ? p === '/api/ocr' || p.startsWith('/api/ocr?') : p.startsWith(prefix)
  );
}

export function apiUrl(path = '', query = {}) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
  const base = API_ORIGIN || (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  const url = new URL(normalizedPath, base);

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  if (API_ORIGIN) return url.toString();
  return `${url.pathname}${url.search}`;
}

// 用户相关请求用这个：始终返回直连 Worker 的绝对 URL，不再经 cn 主机 nginx 中转。
export function apiUrlDirect(path = '', query = {}) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
  const url = new URL(normalizedPath, DIRECT_API_ORIGIN);

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

export function wsApiUrl(path = '') {
  const httpUrl = isDirectApiPath(path) ? apiUrlDirect(path) : apiUrl(path);
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;

  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost';
  return `${protocol}//${host}${httpUrl}`;
}
