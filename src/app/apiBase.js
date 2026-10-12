const API_ORIGIN = String(import.meta.env?.VITE_API_ORIGIN || '').replace(/\/$/, '');

// CF 冗余副本仅用于读取降级；写入始终走 cn 主机。
const DIRECT_API_ORIGIN = 'https://api.freebacktrack.tech';

// 可用于 CF 读取降级的用户相关路径前缀；/api/ocr 为精确匹配（仅 '/api/ocr' 与 '/api/ocr?...'），
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
  const base = API_ORIGIN || (typeof window === 'undefined' ? 'http://localhost' : window.location?.origin || 'http://localhost');
  const url = new URL(normalizedPath, base);

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  if (API_ORIGIN) return url.toString();
  return `${url.pathname}${url.search}`;
}

// 返回 CF 冗余副本的绝对 URL，供读取降级使用。
export function apiUrlDirect(path = '', query = {}) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
  const url = new URL(normalizedPath, DIRECT_API_ORIGIN);

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

export function apiUrlWithFallback(path = '', query = {}) {
  return { primary: apiUrl(path, query), fallback: apiUrlDirect(path, query) };
}

// Only GET may read the CF replica. HTTP errors remain Responses for caller handling.
export async function fetchWithFallback({ primary, fallback }, options = {}) {
  const canFallback = String(options.method || 'GET').toUpperCase() === 'GET' && Boolean(fallback);
  let response;
  try {
    response = await fetch(primary, options);
  } catch (error) {
    if (!canFallback || options.signal?.aborted || error?.name === 'AbortError') throw error;
    return fetch(fallback, options);
  }
  if (canFallback && response.status >= 500 && !options.signal?.aborted) {
    return fetch(fallback, options);
  }
  return response;
}

export function wsApiUrl(path = '') {
  const httpUrl = apiUrl(path);
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;

  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost';
  return `${protocol}//${host}${httpUrl}`;
}
