import { useEffect, useState } from 'react';
import { sendAccountEmailCode } from '../../app/authClient.js';
import { cx, inputClass } from '../experience-ui.jsx';

/** 邮箱 + 验证码输入：注册（purpose=register）与老用户补绑（purpose=bind）共用。 */
export function EmailCodeFields({ idPrefix, email, code, onEmailChange, onCodeChange, purpose = 'register' }) {
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState('');

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function send() {
    if (!String(email || '').trim()) { setHint('请先填写邮箱'); return; }
    setSending(true);
    setHint('');
    try {
      const result = await sendAccountEmailCode({ email, purpose });
      setCooldown(Number(result?.cooldownSeconds) || 60);
      setHint(`验证码已发到 ${result?.maskedAddress || email}，10 分钟内有效`);
    } catch (err) {
      setHint(err?.message || '验证码发送失败，请稍后重试');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={`${idPrefix}-email`} className="block text-xs font-semibold text-slate-600">邮箱</label>
      <div className="flex gap-2">
        <input id={`${idPrefix}-email`} className={cx(inputClass, 'min-w-0 flex-1')} type="email" autoComplete="email" value={email} onChange={(event) => onEmailChange(event.target.value)} placeholder="用于找回账号和接收提醒" />
        <button type="button" onClick={send} disabled={sending || cooldown > 0} className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          {cooldown > 0 ? `${cooldown}s 后重发` : sending ? '发送中…' : '发验证码'}
        </button>
      </div>
      <input id={`${idPrefix}-code`} aria-label="邮箱验证码" className={inputClass} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 位邮箱验证码" />
      {hint ? <p aria-live="polite" className="text-[11px] leading-4 text-slate-500">{hint}</p> : null}
    </div>
  );
}
