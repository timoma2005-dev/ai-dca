import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { AUDIT_ACTION_LABELS, AUDIT_ACTION_TONES, describeAuditEntry } from '../../app/rbac/rbacAudit.js';
import { ErrorNote, Panel, formatTime, inputClass, subtleButtonClass } from './rbacUi.jsx';

const DOT_TONES = {
  emerald: 'bg-emerald-500',
  rose: 'bg-rose-500',
  indigo: 'bg-indigo-500',
};

/** 审计：时间线 + 人话描述，按操作类型 / 操作者或目标筛选，原始 JSON 折叠。 */
export function RbacAuditPanel({ roles = [], menus = [] }) {
  const [entries, setEntries] = useState([]);
  const [target, setTarget] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const names = useMemo(() => ({
    roleNames: Object.fromEntries(roles.map((role) => [role.code, role.name])),
    menuNames: Object.fromEntries(menus.map((menu) => [menu.key, menu.label])),
  }), [roles, menus]);

  const load = useCallback(async ({ append = false, before = '', filters } = {}) => {
    const query = filters || { target, action };
    setLoading(true);
    setError('');
    try {
      const data = await rbacAdminApi.listAudit({ before, target: query.target.trim(), action: query.action });
      const rows = Array.isArray(data.entries) ? data.entries : [];
      setEntries((current) => (append ? [...current, ...rows] : rows));
      setHasMore(rows.length >= 50);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [target, action]);

  useEffect(() => {
    load({ filters: { target: '', action: '' } });
    // 仅首次进入时加载；之后由筛选触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Panel title="审计日志" description="所有角色、权限与菜单的变更都会记录操作者与时间。">
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); load(); }}>
        <select className={inputClass} value={action} onChange={(event) => { setAction(event.target.value); load({ filters: { target, action: event.target.value } }); }} aria-label="操作类型">
          <option value="">全部操作</option>
          {Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input type="search" className={`${inputClass} min-w-[10rem] flex-1`} value={target} onChange={(event) => setTarget(event.target.value)} placeholder="操作者用户名 / 目标 ID" aria-label="审计筛选" />
        <button type="submit" className={subtleButtonClass} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />查询
        </button>
      </form>
      <ErrorNote error={error} />
      <ol className="relative mt-4 space-y-4 border-l border-slate-200 pl-5" aria-label="审计时间线">
        {entries.map((entry) => (
          <li key={entry.id} className="relative text-sm" data-testid="rbac-audit-entry">
            <span className={`absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${DOT_TONES[AUDIT_ACTION_TONES[entry.action]] || 'bg-slate-400'}`} aria-hidden="true" />
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="font-semibold text-slate-800">{describeAuditEntry(entry, names)}</span>
              <span className="text-xs text-slate-400">{formatTime(entry.createdAt)}</span>
            </div>
            <details className="mt-1 text-xs text-slate-500">
              <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-600">{AUDIT_ACTION_LABELS[entry.action] || entry.action} · {entry.targetType}:{entry.targetId}</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">{JSON.stringify(entry.detail, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ol>
      {!loading && !entries.length ? <p className="mt-3 text-xs text-slate-400">暂无审计记录。</p> : null}
      {hasMore ? (
        <button type="button" className={`${subtleButtonClass} mt-4`} disabled={loading} onClick={() => load({ append: true, before: entries.at(-1)?.id || '' })}>加载更多</button>
      ) : null}
    </Panel>
  );
}
