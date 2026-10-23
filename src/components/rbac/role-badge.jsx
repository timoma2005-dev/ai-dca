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

/** 角色列表（下拉菜单内）：名称 + 到期日。 */
export function RoleList({ roles = [] }) {
  if (!roles.length) return null;
  return (
    <ul className="space-y-1.5" aria-label="我的角色">
      {roles.map((role) => (
        <li key={role.code} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
            <RoleBadge topRole={role} className="ring-0" />
            {role.name || role.code}
          </span>
          <span className="shrink-0 text-[11px] text-slate-500">
            {role.expiresAt ? `${String(role.expiresAt).slice(0, 10)} 到期` : '长期有效'}
          </span>
        </li>
      ))}
    </ul>
  );
}
