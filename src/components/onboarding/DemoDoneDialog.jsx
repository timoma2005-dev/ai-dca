import { createPortal } from 'react-dom';
import { CheckCircle2 } from 'lucide-react';

/**
 * 游客走完演示教程：提醒演示里填的内容不会保存（第二天就清空），引导注册保留。
 * 已登录用户不弹（直接回新手入门）。
 */
export function DemoDoneDialog({ flow, onRegister, onBack }) {
  if (!flow || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end justify-center bg-slate-900/45 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={flow.doneTitle || '教程完成'} data-testid="demo-done-dialog">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-center gap-2 text-emerald-600">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          <h2 className="text-base font-extrabold text-slate-900">{flow.doneTitle || '教程完成 ✓'}</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          你还没注册，演示里填的内容不会保存，<span className="font-bold text-rose-600">第二天就清空了</span>。注册就送 3 个月 VIP，配置保留下来，溢价拉开时才会真的推到你手机。
        </p>
        <button type="button" className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-xl bg-indigo-600 text-sm font-extrabold text-white hover:bg-indigo-700" onClick={onRegister}>
          免费注册，保留配置
        </button>
        <button type="button" className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-50" onClick={onBack}>
          先回新手入门
        </button>
      </div>
    </div>,
    document.body
  );
}
