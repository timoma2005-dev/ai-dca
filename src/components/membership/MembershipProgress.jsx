import { ChevronRight, TrendingUp } from 'lucide-react';
import { openUpgradeQr } from '../../app/accountAuthEvents.js';
import { membershipMeter, membershipProgress } from '../../app/membership.js';

/** 账号菜单「升级进度」：注册天数 + 近 30 天活跃天数距下一级还差多少；点击打开会员体系说明。 */
export function MembershipProgress({ membership, effectiveTier = '', onOpened }) {
  const meter = membershipMeter(membership);
  if (!membership || !meter) return null;
  const open = () => { onOpened?.(); openUpgradeQr({ source: 'account-menu-progress' }); };
  // 付费 / 授权 SVIP（非自动等级）：不显示升级条，只显示活跃情况。
  const granted = effectiveTier && effectiveTier !== membership.tier && effectiveTier === 'svip';
  const hint = granted ? `近 ${membership.windowDays} 天活跃 ${membership.activeDays} 天` : membershipProgress(membership)?.text || '';
  return (
    <button type="button" className="block w-full rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-left transition-colors hover:bg-amber-50" onClick={open} data-testid="membership-progress-entry">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-900">
          <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
          {granted ? '会员等级 SVIP' : meter.upgrading ? `升级进度 ${meter.from} → ${meter.to}` : `保级进度 ${meter.to}`}
        </span>
        <span className="inline-flex items-center text-[11px] font-semibold text-amber-700">规则<ChevronRight className="h-3 w-3" aria-hidden="true" /></span>
      </div>
      {granted ? null : (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-amber-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter.percent} aria-label="会员升级进度">
            <div className="h-full rounded-full bg-amber-500 transition-[width]" style={{ width: `${meter.percent}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-amber-800">
            <span>近 {meter.windowDays} 天活跃 {Math.min(meter.activeDays, 999)}/{meter.activeGoal} 天</span>
            <span>注册 {Math.min(meter.registeredDays, meter.registeredGoal)}/{meter.registeredGoal} 天</span>
          </div>
        </>
      )}
      {hint ? <p className="mt-1 text-[11px] leading-4 text-amber-700">{hint}</p> : null}
    </button>
  );
}
