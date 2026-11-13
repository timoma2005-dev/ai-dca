import { useEffect } from 'react';
import { Crown, X } from 'lucide-react';
import { MEMBERSHIP_DEFAULT_RULES, MEMBERSHIP_WINDOW_DAYS, membershipProgress, tierName } from '../../app/membership.js';

const HEADLINES = {
  up: (m) => `恭喜，已升级为 ${tierName(m.tier)}`,
  down: (m) => (m.tier ? `会员等级调整为 ${tierName(m.tier)}` : '会员等级已调整为普通用户'),
};

/**
 * 会员体系说明。membership 为空时（游客）只讲规则；reason = intro | up | down | ''（手动打开）。
 * displayTier：管理员等继承了 SVIP 的账号按实际展示。
 */
export function MembershipDialog({ open, onClose, membership = null, reason = '', displayTier = '', loggedIn = false, onLogin }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const m = membership;
  const windowDays = m?.windowDays || MEMBERSHIP_WINDOW_DAYS;
  const rules = m?.rules?.length ? m.rules : MEMBERSHIP_DEFAULT_RULES;
  const svip = rules.find((r) => r.role === 'svip');
  const vip = rules.find((r) => r.role === 'vip');
  const tier = displayTier || m?.tier || '';
  const progress = !displayTier && m ? membershipProgress(m) : null;
  const headline = m && HEADLINES[reason] ? HEADLINES[reason](m) : '会员不售卖，常来就升级';
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-label="会员体系" onClick={onClose} data-testid="membership-info" data-auto-prompt="membership">
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="关闭" className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-amber-600">
          <Crown className="h-3.5 w-3.5" aria-hidden="true" />会员体系
        </div>
        <h3 className="mt-1 pr-8 text-lg font-bold text-slate-900" data-testid="membership-headline">{headline}</h3>
        {reason === 'down' ? (
          <p className="mt-1 text-sm leading-6 text-slate-500">近 {windowDays} 天的活跃天数没到原等级的保级线。重新活跃起来，达标当天就会自动恢复。</p>
        ) : null}

        {loggedIn && m ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3" data-testid="membership-status">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-amber-800">当前等级</span>
              <span className="text-base font-extrabold text-amber-900">{tierName(tier)}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-center">
              <div className="rounded-lg bg-white px-2 py-1.5">
                <div className="text-lg font-extrabold text-slate-900">{m.registeredDays}</div>
                <div className="text-[11px] text-slate-500">注册天数</div>
              </div>
              <div className="rounded-lg bg-white px-2 py-1.5">
                <div className="text-lg font-extrabold text-slate-900">{m.activeDays}</div>
                <div className="text-[11px] text-slate-500">近 {windowDays} 天活跃</div>
              </div>
            </div>
            {progress ? <p className="mt-2 text-xs leading-5 text-amber-800" data-testid="membership-progress">{progress.text}</p> : null}
          </div>
        ) : null}

        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-400">
              <th className="py-1.5 font-medium">等级</th>
              <th className="py-1.5 font-medium">条件</th>
            </tr>
          </thead>
          <tbody className="text-slate-700">
            {svip ? (
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-bold text-slate-900">SVIP</td>
                <td className="py-2">注册满 {svip.minRegisteredDays} 天，近 {windowDays} 天活跃 ≥ {svip.minActiveDays} 天</td>
              </tr>
            ) : null}
            {vip ? (
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-bold text-slate-900">VIP</td>
                <td className="py-2">注册满 {vip.minRegisteredDays} 天，近 {windowDays} 天活跃 ≥ {vip.minActiveDays} 天</td>
              </tr>
            ) : null}
            <tr>
              <td className="py-2 pr-3 font-bold text-slate-900">普通</td>
              <td className="py-2">注册即是</td>
            </tr>
          </tbody>
        </table>

        <ul className="mt-4 space-y-1.5 text-xs leading-5 text-slate-500">
          <li>· 活跃一天：当天登录状态下打开过网站，一天只算一次。</li>
          <li>· 每小时按最近 {windowDays} 天重算：达标当天自动升级，不再满足条件就自动降级。</li>
          <li>· 会员不提供付费购买，也不再随注册赠送。</li>
        </ul>

        <div className="mt-5 flex justify-end gap-2">
          {!loggedIn && onLogin ? (
            <button type="button" className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50" onClick={() => { onClose?.(); onLogin(); }}>
              登录 / 注册
            </button>
          ) : null}
          <button type="button" className="rounded-xl bg-amber-500 px-5 py-2 text-sm font-bold text-white shadow-sm hover:bg-amber-600" onClick={onClose} data-testid="membership-ok">
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
