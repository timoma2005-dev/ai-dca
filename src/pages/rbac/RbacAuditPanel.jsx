import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { ErrorNote, Panel, formatTime, inputClass, subtleButtonClass } from './rbacUi.jsx';

const ACTION_LABELS = {
  'role.grant': '授予角色',
  'role.revoke': '撤销角色',
  'role.bootstrap': '种子授予',
  'role.create': '新建角色',
  'role.update': '修改角色',
  'role.delete': '删除角色',
  'role.permissions': '修改角色权限',
  'permission.create': '新建权限',
  'menu.create': '新建菜单',
  'menu.update': '修改菜单',
  'menu.delete': '删除菜单',
  'rbac.migrate': '迁移',
};

export function RbacAuditPanel() {
  const [entries, setEntries] = useState([]);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async ({ append = false, before = '' } = {}) => {
    setLoading(true);
    setError('');
    try {
      const data = await rbacAdminApi.listAudit({ before, target });
      const rows = Array.isArray(data.entries) ? data.entries : [];
      setEntries((current) => (append ? [...current, ...rows] : rows));
      setHasMore(rows.length >= 50);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    load();
    // 仅首次进入时加载；筛选通过按钮触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Panel
      title="审计日志"
      description="所有角色、权限与菜单的变更都会记录操作者与时间。"
      actions={(
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); load(); }}>
          <input className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="按操作者 / 目标 ID 筛选" aria-label="审计筛选" />
          <button type="submit" className={subtleButtonClass} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />查询
          </button>
        </form>
      )}
    >
      <ErrorNote error={error} />
      <ol className="divide-y divide-slate-100">
        {entries.map((entry) => (
          <li key={entry.id} className="py-2.5 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-bold text-slate-800">{ACTION_LABELS[entry.action] || entry.action}<span className="ml-2 font-normal text-slate-500">{entry.targetType}:{entry.targetId}</span></span>
              <span className="text-slate-400">{formatTime(entry.createdAt)} · {entry.actorUsername || 'system'}</span>
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">{JSON.stringify(entry.detail)}</pre>
          </li>
        ))}
      </ol>
      {hasMore ? (
        <button type="button" className={`${subtleButtonClass} mt-3`} disabled={loading} onClick={() => load({ append: true, before: entries.at(-1)?.id || '' })}>加载更多</button>
      ) : null}
    </Panel>
  );
}
