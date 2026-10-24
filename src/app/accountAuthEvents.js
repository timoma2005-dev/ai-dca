export const ACCOUNT_AUTH_OPEN_EVENT = 'ai-dca:account-auth-open';
export const ACCOUNT_AUTH_INTENT_KEY = 'aiDcaAccountAuthIntent_v1';

function normalizeMode(mode = '') {
  return mode === 'login' ? 'login' : 'register';
}

export function openAccountAuth({ mode = 'register', source = '', trigger = '' } = {}) {
  if (typeof window === 'undefined') return;
  // 付费功能演示期间不弹注册 / 登录（演示条上的「注册」按钮除外）。
  if (window.__AI_DCA_FEATURE_DEMO__ && source !== 'feature-demo') return;
  const detail = {
    mode: normalizeMode(mode),
    source: String(source || '').slice(0, 80),
    trigger: String(trigger || '').slice(0, 120),
    createdAt: Date.now()
  };
  try {
    window.sessionStorage?.setItem(ACCOUNT_AUTH_INTENT_KEY, JSON.stringify(detail));
  } catch {
    // Ignore storage failures; the live event still opens an already mounted account menu.
  }
  window.dispatchEvent(new CustomEvent(ACCOUNT_AUTH_OPEN_EVENT, { detail }));
}

export function consumeAccountAuthIntent({ maxAgeMs = 30_000 } = {}) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage?.getItem(ACCOUNT_AUTH_INTENT_KEY);
    if (!raw) return null;
    window.sessionStorage?.removeItem(ACCOUNT_AUTH_INTENT_KEY);
    const parsed = JSON.parse(raw);
    const createdAt = Number(parsed?.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > maxAgeMs) return null;
    return {
      mode: normalizeMode(parsed?.mode),
      source: String(parsed?.source || ''),
      trigger: String(parsed?.trigger || '')
    };
  } catch {
    return null;
  }
}
