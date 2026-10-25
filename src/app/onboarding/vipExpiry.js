// 会员到期提醒：赠送 / 打赏开通的 VIP、SVIP 到期前 7 天在首页提醒一次（每个到期日可关闭一次）。
// 到期后切换提醒和通知会停止推送，这是续费最需要被看到的时刻。

export const VIP_EXPIRY_WARN_DAYS = 7;
export const VIP_EXPIRY_DISMISS_KEY = 'aiDcaVipExpiryNoticeDismissed';

const PAID_RANK = { vip: 1, svip: 2 };
const PERMANENT_RANK = { vip: 1, svip: 2, admin: 3, superadmin: 4 };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Array<{code:string,name?:string,expiresAt?:string|null}>} roles
 * @param {number} [now]
 * @returns {null | {code:string,name:string,expiresAt:string,daysLeft:number}}
 */
export function vipExpiryNotice(roles = [], now = Date.now()) {
  const list = Array.isArray(roles) ? roles : [];
  let best = null;
  for (const role of list) {
    const rank = PAID_RANK[role?.code];
    if (!rank || !role.expiresAt) continue;
    const at = Date.parse(role.expiresAt);
    if (!Number.isFinite(at) || at <= now) continue;
    if (!best || rank > best.rank || (rank === best.rank && at > best.at)) best = { rank, at, role };
  }
  if (!best) return null;
  // 同级或更高的永久角色（或更晚到期的同级以上角色）存在时，不提醒。
  const covered = list.some((role) => {
    const rank = PERMANENT_RANK[role?.code] || 0;
    if (rank < best.rank || role === best.role) return false;
    if (!role.expiresAt) return true;
    const at = Date.parse(role.expiresAt);
    return Number.isFinite(at) && at > best.at;
  });
  if (covered) return null;
  const left = best.at - now;
  if (left > VIP_EXPIRY_WARN_DAYS * DAY_MS) return null;
  return {
    code: best.role.code,
    name: best.role.name || best.role.code.toUpperCase(),
    expiresAt: best.role.expiresAt,
    daysLeft: Math.max(1, Math.ceil(left / DAY_MS))
  };
}

export function formatExpiryDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return month && day ? `${month}月${day}日` : '';
}
