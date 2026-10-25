import { useCallback } from 'react';
import { GraduationCap } from 'lucide-react';
import { GettingStartedCard } from './GettingStartedCard.jsx';
import { VipExpiryNotice } from './VipExpiryNotice.jsx';
import { useOnboarding } from '../../app/onboarding/useOnboarding.js';
import { shouldShowGettingStarted } from '../../app/onboarding/catalog.js';
import { ONBOARDING_OPEN_EVENT, ONBOARDING_START_DEMO_EVENT, ONBOARDING_START_EVENT, writeOnboardingState } from '../../app/onboarding/state.js';
import { trackFeatureEvent } from '../../app/analytics.js';

function navigate(tab) {
  window.dispatchEvent(new CustomEvent('workspace:navigate', { detail: { tab } }));
}

/**
 * 首页任务卡：把任务点击翻译成导航 + 步骤提示。
 * onRegister / onUpgrade 由工作台提供（打开注册框 / 打赏开通二维码）。
 */
export function GettingStartedSlot({ loggedIn, accessOf, onRegister, onUpgrade, demoActive = false, takeover = false, roles = [] }) {
  const { state, tasks } = useOnboarding({ loggedIn, accessOf });
  const handleAction = useCallback((task) => {
    trackFeatureEvent('onboarding', 'task_click', { taskId: task.id, status: task.status, version: 2 });
    if (task.action === 'register') { onRegister?.(); return; }
    if (task.status === 'locked') { onUpgrade?.(); return; }
    if (task.action === 'demo') {
      writeOnboardingState({ [task.seenKey || 'seenDemo']: true });
      window.dispatchEvent(new CustomEvent(ONBOARDING_START_DEMO_EVENT, { detail: { tab: task.tab, flow: task.flow, variant: task.variant || '' } }));
      return;
    }
    if (task.tab) navigate(task.tab);
    if (task.flow) {
      // 先切页，再启动提示；宿主会等待懒加载页面里的目标出现。
      window.setTimeout(() => window.dispatchEvent(new CustomEvent(ONBOARDING_START_EVENT, { detail: { flow: task.flow } })), 0);
    }
  }, [onRegister, onUpgrade]);
  const dismiss = () => { trackFeatureEvent('onboarding', 'dismiss', { doneCount: tasks.doneCount, mode: tasks.mode, takeover, version: 2 }); writeOnboardingState({ dismissed: true }); };
  const expiry = loggedIn ? <VipExpiryNotice roles={roles} onUpgrade={onUpgrade} demoActive={demoActive} /> : null;
  if (!shouldShowGettingStarted({ tasks, state, demoActive })) {
    return expiry ? <div className="cn-home-onboarding">{expiry}</div> : null;
  }
  return (
    <div className="cn-home-onboarding flex flex-col gap-3">
      {expiry}
      <GettingStartedCard
        tasks={tasks}
        onAction={handleAction}
        onDismiss={dismiss}
        onFinish={() => writeOnboardingState({ celebrated: true, dismissed: true })}
      />
      {takeover ? (
        <button type="button" className="mx-auto px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-600" onClick={dismiss} data-onboarding-skip="true">
          跳过，先看市场首页
        </button>
      ) : null}
    </div>
  );
}

/** 首页门控：新手入门任务卡还要展示时，首页只显示任务卡（takeover），关掉后才出现原有首页内容。 */
export function OnboardingHomeGate({ loggedIn, accessOf, demoActive = false, children }) {
  const { state, tasks } = useOnboarding({ loggedIn, accessOf });
  return children(shouldShowGettingStarted({ tasks, state, demoActive }));
}

/** 账号菜单 / 侧栏里的常驻入口：重新打开首页任务卡。 */
export function openGettingStarted() {
  window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT));
}

export function GettingStartedEntry({ loggedIn, accessOf, variant = 'menu', onOpened }) {
  const { tasks, state } = useOnboarding({ loggedIn, accessOf });
  if (!tasks || tasks.mode !== 'user') return null;
  if (tasks.allDone && state.celebrated) return null;
  const pct = tasks.total ? tasks.doneCount / tasks.total : 0;
  const ring = (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
      style={{ background: `conic-gradient(#4f46e5 0 ${pct * 100}%, #e0e7ff ${pct * 100}% 100%)` }}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-[10px] font-extrabold text-indigo-600">{tasks.doneCount}/{tasks.total}</span>
    </span>
  );
  const onClick = () => { trackFeatureEvent('onboarding', 'entry_open', { variant, version: 2 }); openGettingStarted(); onOpened?.(); };
  if (variant === 'sidebar') {
    return (
      <button type="button" className="flex w-full items-center gap-2.5 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-left hover:bg-indigo-50" onClick={onClick} data-onboarding-entry="sidebar">
        {ring}
        <span className="min-w-0">
          <span className="block text-xs font-bold text-slate-900">新手入门</span>
          <span className="block text-[11px] text-slate-500">{tasks.allDone ? '全部完成' : `还差 ${tasks.total - tasks.doneCount} 件小事`}</span>
        </span>
      </button>
    );
  }
  return (
    <button type="button" className="flex w-full items-center gap-2.5 rounded-xl bg-indigo-50 px-3 py-2 text-left hover:bg-indigo-100" onClick={onClick} data-onboarding-entry="menu">
      {ring}
      <span className="flex-1 text-sm font-bold text-indigo-900">新手入门</span>
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600"><GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />{state.dismissed ? '重新打开' : '继续'}</span>
    </button>
  );
}
