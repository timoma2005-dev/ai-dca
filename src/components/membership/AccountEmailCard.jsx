import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { bindAccountEmail, fetchAccountEmail } from '../../app/authClient.js';
import { adoptAccountEmailForNotify, loadNotifyEmailStatus } from '../../app/notifySync.js';
import { showToast } from '../../app/toast.js';
import { EmailCodeFields } from './EmailCodeFields.jsx';

/** 老用户补绑邮箱：绑定后若还没有通知邮箱，自动设为通知邮箱。 */
export function AccountEmailCard({ session }) {
  const [account, setAccount] = useState(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAccountEmail(session).then(async (data) => {
      if (!alive) return;
      setAccount(data);
      // 已有账号邮箱但还没有通知邮箱（如注册时自动设置失败）：补设一次。
      if (!data?.email) return;
      const status = await loadNotifyEmailStatus();
      if (alive && !status?.email?.verified) await adoptAccountEmailForNotify();
    }).catch(() => {});
    return () => { alive = false; };
  }, [session]);

  if (!account || account.email) return null;

  async function bind() {
    setBusy(true);
    try {
      const result = await bindAccountEmail({ email, emailCode: code }, session);
      let adopted = false;
      try {
        const status = await loadNotifyEmailStatus();
        if (!status?.email?.verified) { await adoptAccountEmailForNotify(); adopted = true; }
      } catch { /* 通知邮箱设置失败不影响绑定 */ }
      setAccount({ email: result?.email || email });
      showToast({ title: '邮箱已绑定', description: adopted ? '已同时设为通知邮箱，可在提醒设置里开关。' : '可在提醒设置里改用这个邮箱接收通知。', tone: 'emerald' });
    } catch (err) {
      showToast({ title: '绑定失败', description: err?.message || '请稍后重试', tone: 'red' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/70 px-3 py-2.5 text-xs text-sky-900">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-bold"><Mail className="h-3.5 w-3.5" aria-hidden="true" />绑定邮箱</div>
        {!open ? <button type="button" onClick={() => setOpen(true)} className="font-bold text-sky-700 hover:text-sky-900">去绑定</button> : null}
      </div>
      <p className="mt-1 leading-5 text-sky-800">用于找回账号，也能直接接收盯盘和换基提醒。</p>
      {open ? (
        <div className="mt-2 space-y-2">
          <EmailCodeFields idPrefix="account-bind" purpose="bind" email={email} code={code} onEmailChange={setEmail} onCodeChange={setCode} />
          <button type="button" onClick={bind} disabled={busy || !/^\d{6}$/.test(code)} className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-sky-600 text-xs font-bold text-white hover:bg-sky-700 disabled:opacity-50">{busy ? '绑定中…' : '验证并绑定'}</button>
        </div>
      ) : null}
    </div>
  );
}
