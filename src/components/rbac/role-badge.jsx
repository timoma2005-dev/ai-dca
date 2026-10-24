import { Crown, Gem, Shield } from 'lucide-react';
import { roleBadgeFor, roleRingFor } from '../../app/rbac/menuModel.js';

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

const RING_STYLES = {
  vip: {
    ring: 'conic-gradient(from 200deg, #f59e0b, #fde68a, #d97706, #fbbf24, #f59e0b)',
    glow: '0 0 8px rgba(245, 158, 11, 0.45)',
    chip: 'linear-gradient(90deg, #f59e0b, #d97706)',
    chipText: 'VIP',
  },
  svip: {
    ring: 'conic-gradient(from 180deg, #8b5cf6, #ec4899, #f0abfc, #6366f1, #8b5cf6)',
    glow: '0 0 10px rgba(168, 85, 247, 0.45)',
    chip: 'linear-gradient(90deg, #8b5cf6, #ec4899)',
    chipText: 'SVIP',
    spin: true,
  },
  admin: {
    ring: 'conic-gradient(from 210deg, #2563eb, #38bdf8, #1d4ed8, #60a5fa, #2563eb)',
    glow: '0 0 8px rgba(59, 130, 246, 0.4)',
    chip: '#2563eb',
    chipText: '管理员',
  },
  superadmin: {
    ring: 'conic-gradient(#4285f4 0 25%, #ea4335 0 50%, #fbbc05 0 75%, #34a853 0 100%)',
    glow: '0 0 10px rgba(66, 133, 244, 0.4)',
    chip: 'linear-gradient(90deg, #4285f4, #ea4335, #fbbc05, #34a853)',
    chipText: '超管',
  },
};

const AVATAR_SIZES = {
  sm: { outer: 30, ring: 2, gap: 2, font: 12 },
  lg: { outer: 48, ring: 3, gap: 2, font: 17 },
};

/**
 * 带角色光圈的首字母头像：普通用户细灰描边；VIP/SVIP/管理员/超级管理员各有渐变光圈与外发光。
 * SVIP 光圈缓慢流转（减少动态效果时停止）；lg 尺寸可在右下角显示角色胶囊。
 */
export function RoleAvatar({ topRole, initial = '', size = 'sm', showChip = false, className = '' }) {
  const ring = roleRingFor(topRole);
  const tone = ring ? RING_STYLES[ring.tier] : null;
  const dim = AVATAR_SIZES[size] || AVATAR_SIZES.sm;
  const inner = dim.outer - (dim.ring + dim.gap) * 2;
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: dim.outer, height: dim.outer, boxShadow: tone?.glow }}
      data-role-ring={ring?.tier || 'none'}
      title={ring?.label}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-0 rounded-full ${tone?.spin ? 'animate-spin motion-reduce:animate-none' : ''}`}
        style={{ background: tone?.ring || '#e2e8f0', animationDuration: tone?.spin ? '6s' : undefined }}
      />
      <span className="absolute rounded-full bg-white" style={{ inset: dim.ring }} aria-hidden="true" />
      <span
        className="relative inline-flex items-center justify-center rounded-full bg-teal-700 font-bold leading-none text-white"
        style={{ width: inner, height: inner, fontSize: dim.font }}
      >
        {initial}
      </span>
      {showChip && tone ? (
        <span
          className="pointer-events-none absolute -bottom-1 -right-2 whitespace-nowrap rounded-full border-2 border-white px-1.5 py-px text-[9px] font-bold leading-tight text-white"
          style={{ background: tone.chip }}
          data-role-chip={ring.tier}
        >
          {tone.chipText}
        </span>
      ) : null}
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
