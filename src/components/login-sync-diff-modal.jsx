// 登录时本机数据与云端不一致：不再逐项比较，只问一次「用本机覆盖云端」还是「改用云端」。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CloudCog, CloudDownload, HardDriveUpload, Loader2 } from 'lucide-react';
import { CLOUD_SYNC_SESSION_EVENT, loadCloudSession } from '../app/authSession.js';
import { LOGIN_SYNC_DIFF_EVENT } from '../app/loginSyncGate.js';
import { confirmLoginSync, getPendingLoginSyncDiff } from '../app/loginSyncFlow.js';
import { HOLDINGS_LEDGER_RESOURCE, LOGIN_SYNC_CHOICES, uniformLoginSyncChoices } from '../app/loginSyncDiff.js';
import { isLocalOnlyModeChosen, setLocalOnlyMode } from '../app/recordingAccess.js';
import { setMobileBottomSheetOpen } from '../app/mobileBottomSheet.js';
import { showToast } from '../app/toast.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

const SHEET_SOURCE = 'login-sync-diff';

function formatTime(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function summarizeLoginSyncPending(pending) {
  const sides = pending?.sides || {};
  const items = pending?.diff?.items || [];
  const txItem = items.find((item) => item.id === HOLDINGS_LEDGER_RESOURCE);
  const resourceLabels = items.filter((item) => item.kind === 'resource').map((item) => item.label || item.resource);
  const remoteTimes = [
    ...Object.values(sides.remoteResources || {}).map((entry) => entry?.updatedAt),
    ...(sides.remoteTransactions || []).map((tx) => tx?.updatedAt)
  ].filter(Boolean).sort();
  return {
    localTxCount: (sides.localTransactions || []).length,
    remoteTxCount: (sides.remoteTransactions || []).length,
    remoteOnlyTxCount: (txItem?.remoteOnlyIds || txItem?.rows?.remoteOnly || []).length,
    resourceLabels,
    remoteUpdatedAt: remoteTimes[remoteTimes.length - 1] || ''
  };
}

function downloadLocalBackup(pending) {
  try {
    const sides = pending?.sides || {};
    const payload = {
      exportedAt: new Date().toISOString(),
      note: 'ai-dca 本机数据备份（登录时选择改用云端前自动导出）',
      transactions: sides.localTransactions || [],
      resources: sides.localResources || {}
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-dca-本机数据备份-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch {
    return false;
  }
}

export function LoginSyncDiffModal() {
  const [pending, setPending] = useState(() => getPendingLoginSyncDiff());
  const [open, setOpen] = useState(() => Boolean(getPendingLoginSyncDiff()));
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const summary = useMemo(() => summarizeLoginSyncPending(pending), [pending]);
  const busy = Boolean(phase);
  const localOnly = isLocalOnlyModeChosen();

  const show = useCallback((next) => {
    if (!next) return;
    setPending(next);
    setPhase('');
    setError('');
    setOpen(true);
  }, []);

  useEffect(() => {
    function handleDiff() { show(getPendingLoginSyncDiff()); }
    function handleSession(event) {
      const session = event?.detail?.session || loadCloudSession();
      if (String(session?.userId || '') !== String(pending?.userId || '')) {
        setOpen(false);
        setPending(null);
      }
    }
    window.addEventListener(LOGIN_SYNC_DIFF_EVENT, handleDiff);
    window.addEventListener(CLOUD_SYNC_SESSION_EVENT, handleSession);
    return () => {
      window.removeEventListener(LOGIN_SYNC_DIFF_EVENT, handleDiff);
      window.removeEventListener(CLOUD_SYNC_SESSION_EVENT, handleSession);
    };
  }, [show, pending?.userId]);

  useEffect(() => {
    setMobileBottomSheetOpen(SHEET_SOURCE, open);
    return () => setMobileBottomSheetOpen(SHEET_SOURCE, false);
  }, [open]);

  function later() {
    if (busy) return;
    setOpen(false);
    showToast({
      title: '数据未同步',
      description: '自动同步已暂停。可从账户菜单「处理数据同步」再次打开。',
      tone: 'amber',
      durationMs: 6000
    });
  }

  async function apply(choice) {
    if (busy || !pending) return;
    setPhase(choice);
    setError('');
    try {
      if (choice === LOGIN_SYNC_CHOICES.REMOTE) downloadLocalBackup(pending);
      await confirmLoginSync(uniformLoginSyncChoices(pending.diff?.items || [], choice));
      setLocalOnlyMode(false);
      setOpen(false);
      setPending(null);
      setPhase('');
      showToast(choice === LOGIN_SYNC_CHOICES.LOCAL
        ? { title: '已用本机数据覆盖云端', description: '之后数据以云端为准，多端自动同步。', tone: 'emerald' }
        : { title: '已改用云端数据', description: '本机旧数据已导出备份文件并从浏览器清除。', tone: 'emerald' });
    } catch (applyError) {
      setError(applyError?.message || '同步未完成，请稍后再试。');
      setPhase('');
    }
  }

  if (!open || !pending) return null;
  const remoteTime = formatTime(summary.remoteUpdatedAt);
  const localParts = [];
  if (summary.localTxCount) localParts.push(`${summary.localTxCount} 笔交易`);
  if (summary.resourceLabels.length) localParts.push(summary.resourceLabels.slice(0, 4).join('、') + (summary.resourceLabels.length > 4 ? ' 等' : ''));

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) later(); }}>
      <DialogContent
        className="z-[140] max-w-md gap-0 rounded-3xl p-0"
        overlayClassName="z-[130] bg-slate-950/65"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      >
        <div className="px-5 pb-2 pt-5 sm:px-6">
          <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-indigo-600">
            <CloudCog className="h-4 w-4" aria-hidden="true" />登录数据同步
          </div>
          <DialogTitle className="mt-2 text-lg font-bold leading-snug text-slate-900">
            {localOnly ? '你之前选择了「只在本机使用」' : '这台设备上有未登录时录入的数据'}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm leading-6 text-slate-600">
            登录后将用本机数据覆盖云端，之后以云端为准、多端同步。
          </DialogDescription>
          <div className="mt-3 space-y-1.5 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <div><span className="text-slate-400">本机：</span>{localParts.join('，') || '有未同步的数据'}</div>
            <div>
              <span className="text-slate-400">云端：</span>
              {summary.remoteTxCount ? `${summary.remoteTxCount} 笔交易` : '已有数据'}
              {remoteTime ? `，最后更新 ${remoteTime}` : ''}
            </div>
            {summary.remoteOnlyTxCount ? (
              <div className="text-amber-700">覆盖后，云端有、本机没有的 {summary.remoteOnlyTxCount} 笔交易会被删除。</div>
            ) : null}
          </div>
          {error ? (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
        <div className="space-y-2 px-5 pb-5 pt-3 sm:px-6">
          <button type="button" disabled={busy} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 text-sm font-bold text-white disabled:opacity-60" onClick={() => void apply(LOGIN_SYNC_CHOICES.LOCAL)}>
            {phase === LOGIN_SYNC_CHOICES.LOCAL ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDriveUpload className="h-4 w-4" />}
            用本机数据覆盖云端
          </button>
          <button type="button" disabled={busy} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 disabled:opacity-60" onClick={() => void apply(LOGIN_SYNC_CHOICES.REMOTE)}>
            {phase === LOGIN_SYNC_CHOICES.REMOTE ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
            不覆盖，改用云端（本机数据导出备份）
          </button>
          <button type="button" disabled={busy} className="h-9 w-full text-xs text-slate-400 disabled:opacity-60" onClick={later}>稍后处理</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
