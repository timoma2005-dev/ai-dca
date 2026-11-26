import { apiUrl } from '../../app/apiBase.js';
import { loadCloudSession } from '../../app/authSession.js';

export function authHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  const s = loadCloudSession();
  if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;
  return headers;
}

export async function getSeries(day, codes, signal) {
  const qs = new URLSearchParams({ day, codes: codes.join(',') });
  const res = await fetch(apiUrl(`/api/rotator/series?${qs}`), {
    method: 'GET', headers: authHeaders(), credentials: 'same-origin', redirect: 'manual', signal, cache: 'no-store'
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(json?.message || `读取失败（HTTP ${res.status}）`);
  return json?.series || {};
}

// 券商成交截图识别（ocr-proxy 的 /api/ocr，返回 rows: {date, code, type, price, shares, amount}）
export async function recognizeTrades(file) {
  if (!file || !String(file.type || '').startsWith('image/')) throw Error('请选择截图图片');
  if (file.size > 10 * 1024 * 1024) throw Error('图片请控制在 10MB 内');
  const body = new FormData();
  body.append('file', file, file.name || 'trades.jpg');
  const res = await fetch(apiUrl('/api/ocr'), { method: 'POST', headers: authHeaders(), body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(json?.error || `识别失败（HTTP ${res.status}）`);
  return { rows: Array.isArray(json?.rows) ? json.rows : [], warnings: Array.isArray(json?.warnings) ? json.warnings : [] };
}
