import { useEffect, useState } from 'react';
import { CloudOff, Loader2 } from 'lucide-react';
import { CLOUD_SYNC_SESSION_EVENT } from '../app/authSession.js';
import { isLoginSyncPending, LOGIN_SYNC_STATE_EVENT } from '../app/loginSyncGate.js';
import { showToast } from '../app/toast.js';

// 账户菜单入口：登录合并未确认（取消或失败）时显示，点击重新计算差异并打开合并对话框。
export function LoginSyncPendingEntry({ onOpened }) {
  const [pending, setPending] = useState(() => isLoginSyncPending());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const refresh = () => setPending(isLoginSyncPending());
    window.addEventListener(LOGIN_SYNC_STATE_EVENT, refresh);
    window.addEventListener(CLOUD_SYNC_SESSION_EVENT, refresh);
    return () => {
      window.removeEventListener(LOGIN_SYNC_STATE_EVENT, refresh);
      window.removeEventListener(CLOUD_SYNC_SESSION_EVENT, refresh);
    };
  }, []);

  if (!pending) return null;

  async function open() {
    if (busy) return;
    setBusy(true);
    try {
      const mod = await import('../app/postAuthSync.js');
      const outcome = await mod.ensureCloudSyncReady({ reopenLoginSync: true });
      if (outcome?.status === 'error') {
        showToast({ title: '暂时无法检查数据差异', description: outcome.error?.message || '请检查网络后重试。', tone: 'red' });
      } else if (outcome?.status === 'migration-required') {
        showToast({ title: '请先完成旧数据迁移', tone: 'amber' });
      }
      onOpened?.();
    } finally {
      setBusy(false);
      setPending(isLoginSyncPending());
    }
  }

  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-left transition-colors hover:bg-amber-100"
      onClick={() => void open()}
      disabled={busy}
    >
      {busy ? <Loader2 className="h-4 w-4 flex-none animate-spin text-amber-700" aria-hidden="true" /> : <CloudOff className="h-4 w-4 flex-none text-amber-700" aria-hidden="true" />}
      <span className="min-w-0">
        <span className="block text-xs font-bold text-amber-950">数据未同步 · 处理数据同步</span>
        <span className="block text-[11px] leading-4 text-amber-800/80">本机与云端数据待确认，自动同步已暂停</span>
      </span>
    </button>
  );
}
