import { useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { checkInviteCode, loadCloudSession } from '../../app/authClient.js';
import { openAccountAuth } from '../../app/accountAuthEvents.js';
import { normalizeInviteCode } from '../../app/inviteCode.js';
import { trackFeatureEvent } from '../../app/analytics.js';

function inviteCodeFromUrl() {
  try {
    return normalizeInviteCode(new URL(window.location.href).searchParams.get('invite'));
  } catch {
    return '';
  }
}

/** 邀请落地页（被邀请人视角）：打开邀请链接时说明奖励规则，一键去注册。 */
export function InviteWelcome() {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || loadCloudSession()?.accessToken) return undefined;
    const code = inviteCodeFromUrl();
    if (!code) return undefined;
    const seenKey = `ai-dca:invite-welcome:${code}`;
    try { if (window.sessionStorage?.getItem(seenKey)) return undefined; } catch { /* ignore */ }
    let alive = true;
    checkInviteCode(code).then((data) => {
      if (!alive || !data?.valid) return;
      setInfo(data);
      setOpen(true);
      try { window.sessionStorage?.setItem(seenKey, '1'); } catch { /* ignore */ }
      try { trackFeatureEvent('invite', 'landing_view', {}); } catch { /* ignore */ }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!info) return null;

  function register() {
    setOpen(false);
    try { trackFeatureEvent('invite', 'landing_register', {}); } catch { /* ignore */ }
    openAccountAuth({ mode: 'register', source: 'invite-landing', trigger: 'invite_welcome', notice: `邀请码 ${info.code} 已自动填好，注册时验证一下邮箱即可。` });
  }

  const steps = [
    '用用户名注册，并验证邮箱',
    `注册后 ${info.windowDays} 天内有 ${info.minActiveDays} 天登录使用`,
    `你和好友各得 ${info.rewardDays} 天 SVIP`,
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-600"><Gift className="h-5 w-5" aria-hidden="true" /></div>
        <DialogTitle>{info.inviter} 邀请你使用 AI-DCA</DialogTitle>
        <DialogDescription>纳指 QDII 溢价、换基提醒和定投回测，提醒可以发到手机、电脑或邮箱。</DialogDescription>
        <ol className="space-y-2 text-sm text-slate-700">
          {steps.map((step, index) => (
            <li key={step} className="flex items-start gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[11px] font-bold text-white">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <button type="button" onClick={() => setOpen(false)} className="h-10 flex-1 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-600 hover:bg-slate-50">先看看</button>
          <button type="button" onClick={register} className="h-10 flex-[2] rounded-xl bg-amber-500 text-sm font-bold text-white hover:bg-amber-600">注册领取 SVIP</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
