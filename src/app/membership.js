// 会员体系（2026-11-13 起）：不售卖，按注册天数 + 近 30 天活跃天数自动升降级。
// 服务端 /api/sync/auth/me、/menus 返回 membership（见 services/auth/src/membership.js），这里只做展示。

export const MEMBERSHIP_DEFAULT_RULES = [
  { role: 'svip', name: 'SVIP', minRegisteredDays: 30, minActiveDays: 20 },
  { role: 'vip', name: 'VIP', minRegisteredDays: 30, minActiveDays: 10 },
];
export const MEMBERSHIP_WINDOW_DAYS = 30;
export const MEMBERSHIP_SEEN_KEY = 'aiDcaMembershipSeen:v1';

const TIER_NAMES = { svip: 'SVIP', vip: 'VIP', '': '普通用户' };
const TIER_RANK = { '': 0, vip: 1, svip: 2 };

export function tierName(tier) {
  return TIER_NAMES[tier || ''] || String(tier || '').toUpperCase();
}

export function normalizeMembership(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  const tier = ['vip', 'svip'].includes(raw.tier) ? raw.tier : '';
  const prevTier = ['vip', 'svip'].includes(raw.prevTier) ? raw.prevTier : '';
  const rules = Array.isArray(raw.rules) && raw.rules.length
    ? raw.rules.map((r) => ({ role: String(r.role || ''), name: String(r.name || tierName(r.role)), minRegisteredDays: num(r.minRegisteredDays), minActiveDays: num(r.minActiveDays) }))
    : MEMBERSHIP_DEFAULT_RULES;
  return {
    tier,
    prevTier,
    changedAt: raw.changedAt || null,
    registeredDays: num(raw.registeredDays),
    activeDays: num(raw.activeDays),
    windowDays: num(raw.windowDays) || MEMBERSHIP_WINDOW_DAYS,
    rules,
  };
}

export function sameMembership(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.tier === b.tier && a.prevTier === b.prevTier && a.registeredDays === b.registeredDays
    && a.activeDays === b.activeDays && a.changedAt === b.changedAt;
}

/** 下一级还差什么；已是最高级时返回保级提示。 */
export function membershipProgress(m) {
  if (!m) return null;
  const rules = [...m.rules].sort((x, y) => (TIER_RANK[x.role] || 0) - (TIER_RANK[y.role] || 0));
  const next = rules.find((r) => (TIER_RANK[r.role] || 0) > (TIER_RANK[m.tier] || 0));
  const current = rules.find((r) => r.role === m.tier);
  if (next) {
    const needReg = Math.max(0, next.minRegisteredDays - m.registeredDays);
    const needActive = Math.max(0, next.minActiveDays - m.activeDays);
    const parts = [];
    if (needReg) parts.push(`注册再满 ${needReg} 天`);
    if (needActive) parts.push(`近 ${m.windowDays} 天再活跃 ${needActive} 天`);
    return { kind: 'next', target: next.name, text: parts.length ? `${parts.join('，')}即可升级 ${next.name}` : `已达到 ${next.name} 条件，下次刷新后生效` };
  }
  if (current) {
    const margin = m.activeDays - current.minActiveDays;
    return { kind: 'keep', target: current.name, text: margin > 0 ? `近 ${m.windowDays} 天活跃比保级线多 ${margin} 天` : `近 ${m.windowDays} 天活跃刚好在保级线上，少来一天就会降级` };
  }
  return null;
}

function readSeen() {
  try { return JSON.parse(window.localStorage.getItem(MEMBERSHIP_SEEN_KEY) || '{}') || {}; } catch { return {}; }
}

/**
 * 是否自动弹出：每个账号首次看到会员体系时弹一次；之后等级变化（升级 / 降级）再弹一次。
 * 返回 null（不弹）或 { reason: 'intro' | 'up' | 'down' }。
 */
export function membershipAutoReason(userKey, m, seen = readSeen()) {
  if (!userKey || !m) return null;
  const entry = seen?.[userKey];
  if (!entry) return { reason: 'intro' };
  const last = String(entry.tier ?? '');
  if (last === m.tier) return null;
  return { reason: (TIER_RANK[m.tier] || 0) > (TIER_RANK[last] || 0) ? 'up' : 'down', from: last };
}

export function markMembershipSeen(userKey, m) {
  if (!userKey || !m) return;
  try {
    const seen = readSeen();
    seen[userKey] = { tier: m.tier, at: new Date().toISOString() };
    window.localStorage.setItem(MEMBERSHIP_SEEN_KEY, JSON.stringify(seen));
  } catch { /* 隐私模式：本次会话内不再弹由组件状态保证 */ }
}
