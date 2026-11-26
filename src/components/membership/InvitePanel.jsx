import { useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import { fetchInviteSummary } from '../../app/authClient.js';
import { inviteLink } from '../../app/inviteCode.js';
import { showToast } from '../../app/toast.js';
import { trackFeatureEvent } from '../../app/analytics.js';
import { InviteCenterDialog } from './InviteCenterDialog.jsx';

/** 账号菜单里的「邀请好友」：展示邀请码、复制邀请链接和邀请进度。 */
export function InvitePanel({ session }) {
  const [summary, setSummary] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchInviteSummary(session).then((data) => { if (alive) setSummary(data); }).catch(() => {});
    return () => { alive = false; };
  }, [session]);
  if (!summary?.code) return null;
  const link = inviteLink(summary.code);
  async function copy() {
    const text = `我在用 AI-DCA 看纳指 QDII 溢价和换基提醒，用我的邀请码 ${summary.code} 注册，我们立刻各得 ${summary.rewardDays} 天 SVIP：${link}`;
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
        好友用你的邀请码注册，双方立刻各得 {summary.rewardDays} 天 SVIP（每月最多 {summary.monthlyCap} 次）。
        {summary.total ? ` 已邀请 ${summary.total} 人 · 进行中 ${summary.pending} · 已达标 ${summary.rewarded}` : ''}
      </p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => { setDetailOpen(true); try { trackFeatureEvent('invite', 'open_detail', {}); } catch { /* ignore */ } }} className="inline-flex h-8 flex-1 items-center justify-center rounded-lg border border-amber-300 bg-white text-xs font-bold text-amber-800 hover:bg-amber-100">邀请明细{summary.total ? `（${summary.total}）` : ''}</button>
        <button type="button" onClick={copy} className="inline-flex h-8 flex-1 items-center justify-center rounded-lg bg-amber-500 text-xs font-bold text-white hover:bg-amber-600">复制邀请链接</button>
      </div>
      <InviteCenterDialog open={detailOpen} onOpenChange={setDetailOpen} summary={summary} onCopy={copy} />
    </div>
  );
}
