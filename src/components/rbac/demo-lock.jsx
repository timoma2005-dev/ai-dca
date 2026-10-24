import { createContext, useContext } from 'react';
import { Lock } from 'lucide-react';
import { isFeatureDemoActive } from '../../app/demo/demoMode.js';
import { findMenu, requiredRoleLabel } from '../../app/rbac/menuModel.js';
import { readRbacState } from '../../app/rbac/rbacStore.js';

/**
 * 演示上下文（FeatureDemo 提供）：{ tab, limit, visibleRows, guest, roleLabel, onUpgrade }。不在演示中时为 null。
 * count 类演示（一次性数据）只渲染前 visibleRows 条真实行，其余用 DemoLockedRows 占位假行 + 遮罩，真实值不进 DOM。
 */
export const FeatureDemoContext = createContext(null);

export function useFeatureDemo() {
  return useContext(FeatureDemoContext);
}

/** 是否处于功能演示：演示上下文或全局沙箱 flag 任一成立（页面组件一律用它判断，不要只读全局 flag）。 */
export function useDemoActive() {
  return Boolean(useFeatureDemo()) || isFeatureDemoActive();
}

/** 菜单所需角色名（与服务端 requiredRole 一致）；演示中用上下文的 roleLabel，否则读 RBAC 菜单缓存，最后用 fallback。 */
export function useRequiredRoleLabel(menuKey, fallback = 'VIP') {
  const demo = useFeatureDemo();
  if (demo?.roleLabel) return demo.roleLabel;
  try {
    const role = findMenu(readRbacState()?.menus, menuKey)?.requiredRole;
    return role ? requiredRoleLabel(role) : fallback;
  } catch {
    return fallback;
  }
}

/** 当前演示允许渲染的真实条数；不在 count 类演示中时为 Infinity。 */
export function useDemoVisibleRows() {
  const demo = useFeatureDemo();
  return demo?.limit === 'count' ? demo.visibleRows : Infinity;
}

export function demoUnlockLabel(demo) {
  return demo?.guest ? '注册查看全部' : `升级 ${demo?.roleLabel || 'VIP'} 查看全部`;
}

/** 遮罩 CTA：「注册/升级 VIP 查看全部」+ 按钮（打开注册 / 打赏开通）。 */
export function DemoUnlockOverlay({ demo, compact = false }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-white/40 px-3 text-center" data-testid="demo-lock-overlay">
      {compact ? null : <Lock className="h-4 w-4 text-amber-600" aria-hidden="true" />}
      <span className="text-xs font-semibold text-slate-700">注册/升级 {demo?.roleLabel || 'VIP'} 查看全部</span>
      {demo?.onUpgrade ? (
        <button type="button" className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-bold text-white shadow-sm hover:bg-amber-600" onClick={() => demo.onUpgrade()}>
          {demoUnlockLabel(demo)}
        </button>
      ) : null}
    </div>
  );
}

/** 占位假行（不含任何真实值）+ 模糊 + 遮罩。 */
export function DemoLockedRows({ count, rowClassName = 'h-11 rounded-xl border border-slate-100 bg-slate-50' }) {
  const demo = useFeatureDemo();
  if (!(count > 0)) return null;
  return (
    <div className="relative min-h-28 overflow-hidden rounded-xl" data-testid="demo-locked-rows" data-locked-count={count}>
      <div className="space-y-2.5 blur-[3px] select-none" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={`flex items-center gap-3 px-3 text-xs text-slate-300 ${rowClassName}`}>
            <span className="w-5 text-center">·</span>
            <span className="flex-1">●●●●●● 纳指ETF●●</span>
            <span className="w-16 text-right">--.--%</span>
          </div>
        ))}
      </div>
      <DemoUnlockOverlay demo={demo} />
    </div>
  );
}

/** 单个被遮罩的值块（例如最佳配对的买入侧）：只渲染占位文本。 */
export function DemoLockedValue({ className = '', children = '●●●●●●' }) {
  const demo = useFeatureDemo();
  return (
    <div className={`relative overflow-hidden ${className}`} data-testid="demo-locked-value">
      <div className="blur-[3px] select-none" aria-hidden="true">{children}</div>
      <DemoUnlockOverlay demo={demo} compact />
    </div>
  );
}
