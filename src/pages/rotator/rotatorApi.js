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
