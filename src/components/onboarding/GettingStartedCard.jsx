import { useEffect, useRef } from 'react';
import { Check, ChevronRight, Lock, PartyPopper, X } from 'lucide-react';
import { trackFeatureEvent } from '../../app/analytics.js';

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

const BADGE_TONE = {
  vip: 'bg-amber-100 text-amber-700',
  muted: 'bg-slate-100 text-slate-500'
};

function TaskRow({ task, onAction }) {
  const done = task.status === 'done';
  const locked = task.status === 'locked';
  const clickable = !done;
  const body = (
    <>
      <span
        className={cx(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
          done ? 'border-emerald-500 bg-emerald-500 text-white' : locked ? 'border-dashed border-slate-300 text-slate-400' : 'border-slate-300'
        )}
        aria-hidden="true"
      >
        {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : locked ? <Lock className="h-3 w-3" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={cx('text-sm font-bold', done ? 'text-slate-400 line-through' : 'text-slate-900')}>{task.title}</span>
          {task.badge ? <span className={cx('rounded-full px-1.5 py-px text-[10px] font-bold', BADGE_TONE[task.badgeTone] || BADGE_TONE.muted)}>{task.badge}</span> : null}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-500">
          {done ? task.doneDescription || '已完成' : locked ? '当前会员等级未开通，开通后继续' : task.description}
        </span>
      </span>
      {clickable ? (
        <span className={cx('inline-flex shrink-0 items-center text-xs font-bold lg:mt-auto', locked ? 'text-amber-700' : 'text-indigo-600')}>
          {locked ? '打赏开通' : task.cta}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      ) : null}
    </>
  );
  const rowClass = 'flex w-full items-center gap-3 py-3 text-left lg:h-full lg:flex-col lg:items-start lg:gap-2 lg:rounded-xl lg:border lg:border-slate-100 lg:p-3';
  return (
    <li className="border-t border-slate-100 first:border-t-0 lg:border-t-0" data-onboarding-task={task.id} data-status={task.status}>
      {clickable ? (
        <button type="button" className={cx(rowClass, 'transition-colors hover:bg-slate-50')} onClick={() => onAction(task)}>{body}</button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </li>
  );
}

/** 首页「先完成一件小事」任务卡。只负责展示和把点击交给调用方；完成状态来自真实数据。 */
export function GettingStartedCard({ tasks, onAction, onDismiss, onFinish }) {
  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current || !tasks) return;
    tracked.current = true;
    trackFeatureEvent('onboarding', 'card_view', { mode: tasks.mode, doneCount: tasks.doneCount, version: 1 });
  }, [tasks]);
  if (!tasks) return null;
  const guest = tasks.mode === 'guest';
  const pct = tasks.total ? Math.round((tasks.doneCount / tasks.total) * 100) : 0;

  if (tasks.allDone) {
    return (
      <section className="rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm" data-testid="getting-started-card" data-state="all-done">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><PartyPopper className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-extrabold text-slate-900">全部完成</h2>
            <p className="text-xs text-slate-500">持仓、切换提醒和通知都已就绪，之后有提醒会第一时间推给你。</p>
          </div>
          <button type="button" className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50" onClick={onFinish}>收起</button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-indigo-100 bg-white p-4 shadow-[0_6px_24px_-12px_rgba(79,70,229,0.35)]" data-testid="getting-started-card" data-mode={tasks.mode}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-extrabold text-slate-900">先完成一件小事</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {guest ? '按你的需要开始，随时可以继续' : `已完成 ${tasks.doneCount}/${tasks.total} · 做完一件就能用起来`}
          </p>
        </div>
        <button type="button" aria-label="关闭新手入门" title="关闭（可在账号菜单「新手入门」重新打开）" className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={onDismiss}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {!guest ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-indigo-50" role="progressbar" aria-valuemin={0} aria-valuemax={tasks.total} aria-valuenow={tasks.doneCount} aria-label="新手入门进度">
          <div className="h-full rounded-full bg-indigo-600 transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <ul className={cx('mt-2', guest ? 'lg:grid lg:grid-cols-2 lg:gap-2' : 'lg:grid lg:grid-cols-4 lg:gap-2')}>
        {tasks.items.map((task) => <TaskRow key={task.id} task={task} onAction={onAction} />)}
      </ul>
      {guest ? (
        <button type="button" className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-xl bg-indigo-600 text-sm font-extrabold text-white hover:bg-indigo-700 lg:hidden" onClick={() => onAction(tasks.items[0])}>
          免费注册
        </button>
      ) : null}
    </section>
  );
}
