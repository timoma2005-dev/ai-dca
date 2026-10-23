import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { expiryInputToIso, rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { showToast } from '../../app/toast.js';
import { ErrorNote, Panel, PeoplePagination, PEOPLE_LIMIT, PEOPLE_PAGE_SIZE, buttonClass, formatTime, inputClass, subtleButtonClass } from './rbacUi.jsx';

const NON_GRANTABLE = new Set(['guest', 'user', 'superadmin']);
const ROLE_FILTERS = [
  ['all', '全部'], ['superadmin', '超级管理员'], ['admin', '管理员'], ['svip', 'SVIP'],
  ['vip', 'VIP'], ['auction_viewer', '竞价看板'], ['none', '无额外角色'],
];

/** 服务端搜索，客户端筛选与分页；任命管理员仅超级管理员（服务端同样校验）。 */
export function RbacUsersPanel({ roles = [], canGrantAdmin = false, onChanged, onLoaded }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState(null);
  const [granting, setGranting] = useState(false);
  const pendingSearches = useRef(new Map());
  const latestSearch = useRef(0);
  const grantable = roles.filter((role) => !NON_GRANTABLE.has(role.code) && !role.isVirtual);

  const search = useCallback(async (searchQuery = '') => {
    const requestId = ++latestSearch.current;
    setLoading(true);
    setError('');
    try {
      let pending = pendingSearches.current.get(searchQuery);
      if (!pending) {
        pending = rbacAdminApi.searchUsers(searchQuery).finally(() => pendingSearches.current.delete(searchQuery));
        pendingSearches.current.set(searchQuery, pending);
      }
      const data = await pending;
      if (requestId === latestSearch.current) {
        const rows = Array.isArray(data.users) ? data.users : [];
        setUsers(rows);
        setPage(1);
        setEditor(null);
        onLoaded?.(rows.length);
      }
    } catch (err) {
      if (requestId === latestSearch.current) setError(err.message);
    } finally {
      if (requestId === latestSearch.current) setLoading(false);
    }
  }, [onLoaded]);

  useEffect(() => {
    search('');
    return () => { latestSearch.current += 1; };
  }, [search]);

  async function grant(user) {
    const draft = editor;
    const role = grantable.find((item) => item.code === draft?.role);
    if (granting || draft?.userId !== user.id || !role || (role.privileged && !canGrantAdmin) || user.roles.some((item) => item.code === role.code)) return;
    setGranting(true);
    setError('');
    try {
      await rbacAdminApi.grantRole(user.id, draft.role, expiryInputToIso(draft.expires));
      showToast({ title: '已授予角色', description: `${user.username} → ${draft.role}`, tone: 'emerald' });
      setEditor(null);
      await search(query);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setGranting(false);
    }
  }

  async function revoke(user, role) {
    if (typeof window !== 'undefined' && !window.confirm(`确认撤销 ${user.username} 的「${role.name}」角色？`)) return;
    try {
      await rbacAdminApi.revokeRole(user.id, role.code);
      showToast({ title: '已撤销角色', tone: 'slate' });
      await search(query);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  const filteredUsers = users.filter((user) => roleFilter === 'all'
    || (roleFilter === 'none' ? user.roles.length === 0 : user.roles.some((role) => role.code === roleFilter)));
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / PEOPLE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleUsers = filteredUsers.slice((currentPage - 1) * PEOPLE_PAGE_SIZE, currentPage * PEOPLE_PAGE_SIZE);

  return (
    <Panel title="用户角色" description="所有登录用户默认拥有「普通用户」。到期日留空表示长期有效，过期后自动失效。">
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); search(query); }}>
        <input className={`${inputClass} flex-1`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="用户名或用户 ID（留空列出全部用户）" aria-label="搜索用户" />
        <button type="submit" className={buttonClass} disabled={loading}>
          <Search className="h-4 w-4" aria-hidden="true" />
          {loading ? '搜索中…' : '搜索'}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="按角色筛选">
        {ROLE_FILTERS.map(([code, label]) => (
          <button key={code} type="button" aria-pressed={roleFilter === code} className={`rounded-full px-3 py-1 text-xs font-medium ${roleFilter === code ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`} onClick={() => { setRoleFilter(code); setPage(1); setEditor(null); }}>
            {label}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm text-slate-600" aria-label="注册用户">
          <thead className="border-b border-slate-200 text-xs text-slate-400">
            <tr>{['用户名', '角色', '注册', '最后活跃', '操作'].map((label) => <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>)}</tr>
          </thead>
          <tbody>
            {visibleUsers.map((user) => {
              const expanded = editor?.userId === user.id;
              const availableRoles = grantable.filter((role) => !user.roles.some((owned) => owned.code === role.code));
              return (
                <Fragment key={user.id}>
                  <tr className="border-b border-slate-100" data-testid="rbac-user-row">
                    <td className="px-2 py-2">
                      <div className="font-semibold text-slate-900">{user.username}</div>
                      <div className="text-[11px] text-slate-400">{user.id}</div>
                    </td>
                    <td className="px-2 py-2"><div className="flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">普通用户（默认）</span>
                      {user.roles.map((role) => {
                        const locked = role.code === 'superadmin' || (!canGrantAdmin && roles.find((r) => r.code === role.code)?.privileged);
                        return (
                          <span key={role.code} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${role.expired ? 'bg-slate-100 text-slate-400 line-through' : 'bg-indigo-50 text-indigo-700'}`}>
                            {role.name}
                            <span className="font-normal">{role.expiresAt ? `· ${String(role.expiresAt).slice(0, 10)}${role.expired ? ' 已过期' : ' 到期'}` : '· 长期'}</span>
                            {!locked ? (
                              <button type="button" className="ml-0.5 rounded-full p-0.5 hover:bg-indigo-100" aria-label={`撤销${role.name}`} onClick={() => revoke(user, role)}>
                                <X className="h-3 w-3" aria-hidden="true" />
                              </button>
                            ) : null}
                          </span>
                        );
                      })}
                    </div></td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs">{formatTime(user.createdAt)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs">{user.lastActiveAt ? formatTime(user.lastActiveAt) : '从未'}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <button type="button" className={subtleButtonClass} disabled={granting} aria-expanded={expanded} onClick={() => setEditor(expanded ? null : { userId: user.id, role: '', expires: '' })}>授予角色</button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="border-b border-slate-100 bg-slate-50" data-testid="rbac-user-editor">
                      <td colSpan={5} className="px-2 py-3">
                        <form className="flex flex-wrap items-center gap-2" aria-label={`授予角色：${user.username}`} onSubmit={(event) => { event.preventDefault(); grant(user); }}>
                          <select className={inputClass} value={editor.role} disabled={granting} onChange={(e) => setEditor({ ...editor, role: e.target.value })} aria-label="选择角色">
                            <option value="">选择角色…</option>
                            {availableRoles.map((role) => (
                              <option key={role.code} value={role.code} disabled={role.privileged && !canGrantAdmin}>
                                {role.name}（{role.code}）{role.privileged && !canGrantAdmin ? ' · 仅超级管理员' : ''}
                              </option>
                            ))}
                          </select>
                          <input type="date" className={inputClass} value={editor.expires} disabled={granting} onChange={(e) => setEditor({ ...editor, expires: e.target.value })} aria-label="到期日（可选）" />
                          <button type="submit" className={buttonClass} disabled={!editor.role || granting}>{granting ? '授予中…' : '确认授予'}</button>
                          <button type="button" className={subtleButtonClass} disabled={granting} onClick={() => setEditor(null)}>取消</button>
                        </form>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {loading ? <p className="mt-3 text-xs text-slate-400">正在加载用户…</p> : null}
      {!loading && !filteredUsers.length ? <p className="mt-3 text-xs text-slate-400">暂无匹配用户。</p> : null}
      <PeoplePagination page={currentPage} pageCount={pageCount} disabled={loading} onPageChange={(next) => { setPage(next); setEditor(null); }}>
        {roleFilter === 'all' ? `共 ${users.length} 位注册用户` : `筛选 ${filteredUsers.length} / ${users.length} 位注册用户`}{users.length >= PEOPLE_LIMIT ? `（当前查询取前 ${PEOPLE_LIMIT}）` : ''}
      </PeoplePagination>
    </Panel>
  );
}
