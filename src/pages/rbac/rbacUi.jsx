// 权限管理页的小型 UI 原语（与站内 Tailwind 风格一致）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { setMobileBottomSheetOpen } from '../../app/mobileBottomSheet.js';
export const inputClass = 'h-9 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100';
export const buttonClass = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';
export const subtleButtonClass = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
export const dangerButtonClass = 'inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50';
export const PEOPLE_PAGE_SIZE = 20;
// 与 searchUsers / listGuests 当前请求的 limit 一致。
export const PEOPLE_LIMIT = 200;

export function PeoplePagination({ page, pageCount, onPageChange, disabled = false, children }) {
  return (
    <footer className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
      <p>{children}</p>
      <nav className="ml-auto flex items-center gap-2" aria-label="分页">
        <button type="button" className={subtleButtonClass} disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
        <span className="whitespace-nowrap" aria-live="polite">第 {page} / {pageCount} 页</span>
        <button type="button" className={subtleButtonClass} disabled={disabled || page >= pageCount} onClick={() => onPageChange(page + 1)}>下一页</button>
      </nav>
    </footer>
  );
}

export function Panel({ title, description, actions, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          {description ? <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700" role="alert">{error}</p>;
}

export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** 角色徽章配色：按等级（超管紫、管理员靛、SVIP 玫红、VIP 金、其余灰）。 */
const ROLE_TONES = {
  superadmin: 'bg-violet-100 text-violet-700',
  admin: 'bg-indigo-100 text-indigo-700',
  svip: 'bg-rose-100 text-rose-700',
  vip: 'bg-amber-100 text-amber-800',
  user: 'bg-slate-100 text-slate-600',
  guest: 'bg-slate-100 text-slate-500',
};

export function roleTone(code) {
  return ROLE_TONES[code] || 'bg-sky-100 text-sky-700';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 到期文案与是否临近（7 天内）。 */
export function roleExpiryInfo(role, now = Date.now()) {
  if (!role?.expiresAt) return { text: '长期', soon: false, expired: Boolean(role?.expired) };
  const ts = Date.parse(role.expiresAt);
  const date = String(role.expiresAt).slice(0, 10);
  const expired = Boolean(role.expired) || (Number.isFinite(ts) && ts <= now);
  if (expired) return { text: `${date} 已过期`, soon: false, expired: true };
  const soon = Number.isFinite(ts) && ts - now <= 7 * DAY_MS;
  return { text: `${date} 到期`, soon, expired: false };
}

export function RoleChip({ role, children, className = '' }) {
  const info = roleExpiryInfo(role);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${info.expired ? 'bg-slate-100 text-slate-400 line-through' : roleTone(role.code)} ${className}`}>
      {role.name || role.code}
      {role.expiresAt ? <span className={`font-normal ${info.soon ? 'text-orange-600' : 'opacity-75'}`}>· {info.text}</span> : null}
      {children}
    </span>
  );
}

export function StatCard({ label, value, hint }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">{value ?? '—'}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

/** 到期快捷项（按北京时间日期）。 */
export const EXPIRY_PRESETS = [
  ['7d', '7 天', 7], ['30d', '30 天', 30], ['1y', '1 年', 365], ['forever', '长期', 0], ['custom', '自定义', null],
];

export function presetToDateInput(days, now = Date.now()) {
  if (!days) return '';
  const date = new Date(now + days * DAY_MS + 8 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

/** 右侧抽屉（手机端全屏）。打开时隐藏移动端底部导航。 */
export function Drawer({ open, title, subtitle, onClose, children, footer, source = 'rbac-drawer', testId }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    setMobileBottomSheetOpen(source, true);
    function onKey(event) { if (event.key === 'Escape') onCloseRef.current?.(); }
    window.addEventListener('keydown', onKey);
    return () => {
      setMobileBottomSheetOpen(source, false);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, source]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal((
    <div className="fixed inset-0 z-[115] flex justify-end bg-slate-900/40" onClick={() => onCloseRef.current?.()}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className="flex h-full w-full flex-col bg-white shadow-2xl sm:max-w-md"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold text-slate-900">{title}</h3>
            {subtitle ? <p className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="关闭" onClick={() => onCloseRef.current?.()}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <footer className="border-t border-slate-100 px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">{footer}</footer> : null}
      </aside>
    </div>
  ), document.body);
}

/** 站内二次确认：const [confirm, confirmNode] = useConfirm(); if (await confirm({...})) ... */
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = useCallback((options) => new Promise((resolve) => setState({ ...options, resolve })), []);
  const finish = (value) => {
    state?.resolve(value);
    setState(null);
  };
  const node = state && typeof document !== 'undefined' ? createPortal((
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-900/50 p-4" onClick={() => finish(false)}>
      <div role="alertdialog" aria-modal="true" aria-label={state.title} data-testid="rbac-confirm" className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <h3 className="text-base font-bold text-slate-900">{state.title}</h3>
        {state.message ? <p className="mt-2 text-sm leading-6 text-slate-600">{state.message}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={subtleButtonClass} onClick={() => finish(false)}>取消</button>
          <button type="button" className={state.danger ? 'inline-flex h-9 items-center justify-center rounded-lg bg-rose-600 px-3 text-sm font-semibold text-white hover:bg-rose-700' : buttonClass} onClick={() => finish(true)}>
            {state.confirmLabel || '确认'}
          </button>
        </div>
      </div>
    </div>
  ), document.body) : null;
  return [confirm, node];
}
