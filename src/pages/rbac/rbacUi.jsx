// 权限管理页的小型 UI 原语（与站内 Tailwind 风格一致；不使用底部浮窗，避免与移动端底部导航冲突）。
export const inputClass = 'h-9 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100';
export const buttonClass = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';
export const subtleButtonClass = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
export const dangerButtonClass = 'inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50';
export const PEOPLE_PAGE_SIZE = 8;
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
