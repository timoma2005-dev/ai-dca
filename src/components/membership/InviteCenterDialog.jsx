import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { inviteeStatus, shortShanghaiDate } from '../../app/inviteProgress.js';

const TONE_CLASS = {
  success: 'bg-emerald-50 text-emerald-700',
  pending: 'bg-amber-50 text-amber-700',
  muted: 'bg-slate-100 text-slate-500',
};

function Stat({ label, value }) {
  return (
    <div className="rounded-xl bg-slate-50 px-2 py-2 text-center">
      <div className="text-lg font-bold text-slate-900">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

/** 邀请落地页（邀请人视角）：邀请人数、每位好友的达标进度和奖励状态。 */
export function InviteCenterDialog({ open, onOpenChange, summary, onCopy }) {
  const invitees = Array.isArray(summary?.invitees) ? summary.invitees : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogTitle>我的邀请</DialogTitle>
        <DialogDescription>
          好友用你的邀请码注册成功，双方立刻各得 {summary.rewardDays} 天 SVIP，每月最多 {summary.monthlyCap} 次；同一网络注册的不计入。
        </DialogDescription>
        <div className="grid grid-cols-4 gap-2">
          <Stat label="已邀请" value={summary.total ?? invitees.length} />
          <Stat label="进行中" value={summary.pending || 0} />
          <Stat label="已达标" value={summary.rewarded || 0} />
          <Stat label="本月奖励" value={`${summary.rewardedThisMonth || 0}/${summary.monthlyCap}`} />
        </div>
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2">
          <div className="text-xs text-amber-900">邀请码 <span className="font-mono text-sm font-bold tracking-wider">{summary.code}</span></div>
          <button type="button" onClick={onCopy} className="h-8 rounded-lg bg-amber-500 px-3 text-xs font-bold text-white hover:bg-amber-600">复制邀请链接</button>
        </div>
        {invitees.length ? (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {invitees.map((item) => {
              const status = inviteeStatus(item, summary);
              return (
                <li key={`${item.name}-${item.createdAt}`} className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-semibold text-slate-800">{item.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_CLASS[status.tone] || TONE_CLASS.muted}`}>{status.label}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span>{shortShanghaiDate(item.createdAt)} 注册</span>
                    <span>{status.detail}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-xl bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">还没有人通过你的链接注册，复制链接发给朋友吧。</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
