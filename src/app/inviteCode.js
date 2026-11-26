// 邀请码：从链接 ?invite=XXXX 记下邀请码（本地保存 30 天），注册时自动带上。
const KEY = 'ai-dca:invite-code';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INVITE_BASE_URL = 'https://fast.freebacktrack.tech/';

export function normalizeInviteCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

export function inviteLink(code, base = INVITE_BASE_URL) {
  const url = new URL(base);
  url.searchParams.set('invite', normalizeInviteCode(code));
  url.searchParams.set('utm_source', 'invite');
  return url.toString();
}

export function captureInviteFromUrl(href = typeof location === 'undefined' ? '' : location.href, storage = typeof localStorage === 'undefined' ? null : localStorage, now = Date.now()) {
  try {
    const code = normalizeInviteCode(new URL(href).searchParams.get('invite'));
    if (code && storage) storage.setItem(KEY, JSON.stringify({ code, at: now }));
    return code;
  } catch {
    return '';
  }
}

export function pendingInviteCode(storage = typeof localStorage === 'undefined' ? null : localStorage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) || 'null');
    if (!saved?.code || now - Number(saved.at || 0) > TTL_MS) return '';
    return normalizeInviteCode(saved.code);
  } catch {
    return '';
  }
}

export function clearPendingInvite(storage = typeof localStorage === 'undefined' ? null : localStorage) {
  try { storage?.removeItem(KEY); } catch { /* ignore */ }
}

captureInviteFromUrl();
