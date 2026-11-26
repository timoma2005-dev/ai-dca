import { useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import { fetchInviteSummary } from '../../app/authClient.js';
import { inviteLink } from '../../app/inviteCode.js';
import { showToast } from '../../app/toast.js';
import { trackFeatureEvent } from '../../app/analytics.js';

/** 账号菜单里的「邀请好友」：展示邀请码、复制邀请链接和邀请进度。 */
export function InvitePanel({ session }) {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchInviteSummary(session).then((data) => { if (alive) setSummary(data); }).catch(() => {});
    return () => { alive = false; };
  }, [session]);
  if (!summary?.code) return null;
  const link = inviteLink(summary.code);
  async function copy() {
    const text = `我在用 AI-DCA 看纳指 QDII 溢价和换基提醒，用我的邀请码 ${summary.code} 注册，活跃 ${summary.minActiveDays} 天后我们各得 ${summary.rewardDays} 天 SVIP：${link}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast({ title: '邀请链接已复制', description: '发给朋友，对方注册时会自动填上邀请码。', tone: 'emerald' });
    } catch {
      showToast({ title: '复制失败', description: link, tone: 'red' });
    }
    try { trackFeatureEvent('invite', 'copy_link', {}); } catch { /* ignore */ }
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-900">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-bold"><Gift className="h-3.5 w-3.5" aria-hidden="true" />邀请好友得 SVIP</div>
        <span className="font-mono text-sm font-bold tracking-wider">{summary.code}</span>
      </div>
      <p className="mt-1 leading-5 text-amber-800">
        好友注册后 {summary.windowDays} 天内有 {summary.minActiveDays} 天登录使用，双方各得 {summary.rewardDays} 天 SVIP（每月最多 {summary.monthlyCap} 次）。
        {summary.pending || summary.rewarded ? ` 进行中 ${summary.pending} · 已生效 ${summary.rewarded}` : ''}
      </p>
      <button type="button" onClick={copy} className="mt-2 inline-flex h-8 w-full items-center justify-center rounded-lg bg-amber-500 text-xs font-bold text-white hover:bg-amber-600">复制邀请链接</button>
    </div>
  );
}
