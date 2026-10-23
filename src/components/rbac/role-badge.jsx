import { Crown, Gem, Shield } from 'lucide-react';
import { roleBadgeFor } from '../../app/rbac/menuModel.js';

const TONES = {
  gold: 'bg-amber-400 text-white ring-amber-100',
  violet: 'bg-violet-500 text-white ring-violet-100',
  indigo: 'bg-indigo-600 text-white ring-indigo-100',
};

const ICONS = { crown: Crown, diamond: Gem, shield: Shield };

/** 头像右下角的最高角色角标：VIP 金色皇冠、SVIP 钻石、管理员盾牌；普通用户不显示。 */
export function RoleBadge({ topRole, className = '' }) {
  const badge = roleBadgeFor(topRole);
  if (!badge) return null;
  const Icon = ICONS[badge.kind];
  return (
    <span
      className={`pointer-events-none inline-flex h-4 w-4 items-center justify-center rounded-full ring-2 ${TONES[badge.tone]} ${className}`}
      title={badge.label}
      aria-label={badge.label}
      data-role-badge={badge.kind}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={2.4} aria-hidden="true" />
    </span>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const ROLE_EXPIRY_WARN_DAYS = 7;

/** 角色有效期文案：长期有效 / MM-DD 到期（7 天内追加剩余天数并标记 warn）。 */
export function describeRoleExpiry(expiresAt, now = Date.now()) {
  if (!expiresAt) return { text: '长期有效', warn: false };
  const date = String(expiresAt).slice(0, 10);
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return { text: `${date} 到期`, warn: false };
  const daysLeft = Math.ceil((ts - now) / DAY_MS);
  if (daysLeft <= 0) return { text: `${date} 已到期`, warn: true };
  if (daysLeft <= ROLE_EXPIRY_WARN_DAYS) return { text: `${date} 到期 · 剩 ${daysLeft} 天`, warn: true };
  return { text: `${date} 到期`, warn: false };
}

/** 角色列表（下拉菜单内）：名称 + 到期日，临近到期标橙。 */
export function RoleList({ roles = [], now }) {
  if (!roles.length) return null;
  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200" aria-label="我的角色">
      {roles.map((role) => {
        const expiry = describeRoleExpiry(role.expiresAt, now);
        return (
          <li key={role.code} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
            <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-slate-800">
              <RoleBadge topRole={role} className="ring-0" />
              <span className="truncate">{role.name || role.code}</span>
            </span>
            <span className={`shrink-0 text-[11px] ${expiry.warn ? 'font-semibold text-orange-600' : 'text-slate-500'}`} data-role-expiry-warn={expiry.warn ? 'true' : undefined}>
              {expiry.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
