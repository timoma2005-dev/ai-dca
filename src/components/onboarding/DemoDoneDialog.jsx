import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2 } from 'lucide-react';

/**
 * 游客走完演示教程：提醒演示里填的内容不会保存（第二天就清空），引导注册保留。
 * 已登录用户不弹（直接回新手入门）。
 * 用 radix Dialog：渠道设置弹窗（也是 radix 模态）可能还开着，嵌套的 radix 弹窗才能叠在最上层并接收点击。
 */
export function DemoDoneDialog({ flow, onRegister, onBack }) {
  const open = Boolean(flow);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onBack?.(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[150] bg-slate-900/45" />
        <Dialog.Content
          className="fixed inset-x-4 bottom-4 z-[151] mx-auto max-w-sm rounded-2xl bg-white p-5 shadow-xl outline-none sm:inset-x-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2"
          data-testid="demo-done-dialog"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-2 text-emerald-600">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            <Dialog.Title className="text-base font-extrabold text-slate-900">{flow?.doneTitle || '教程完成 ✓'}</Dialog.Title>
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
