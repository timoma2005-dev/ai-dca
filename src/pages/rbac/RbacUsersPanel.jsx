import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { expiryInputToIso, rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { showToast } from '../../app/toast.js';
import {
  Drawer, ErrorNote, EXPIRY_PRESETS, Panel, PeoplePagination, PEOPLE_LIMIT, PEOPLE_PAGE_SIZE, RoleChip,
  buttonClass, formatTime, inputClass, presetToDateInput, useConfirm,
} from './rbacUi.jsx';

const NON_GRANTABLE = new Set(['guest', 'user', 'superadmin']);
export const SEARCH_DEBOUNCE_MS = 300;

function canRevoke(role, roles, canGrantAdmin) {
  if (role.code === 'superadmin') return false;
  return canGrantAdmin || !roles.find((item) => item.code === role.code)?.privileged;
}

/** 用户详情抽屉：基本信息、已有角色（可撤销）、授予角色（到期快捷项）。 */
function UserDrawer({ user, roles, canGrantAdmin, onClose, onGrant, onRevoke, busy }) {
  const [draft, setDraft] = useState({ role: '', preset: 'forever', expires: '' });
  const [error, setError] = useState('');
  useEffect(() => { setDraft({ role: '', preset: 'forever', expires: '' }); setError(''); }, [user?.id]);
  if (!user) return null;
  const grantable = roles.filter((role) => !NON_GRANTABLE.has(role.code) && !role.isVirtual && !user.roles.some((owned) => owned.code === role.code));
  const selected = grantable.find((role) => role.code === draft.role);
  const blocked = !selected || (selected.privileged && !canGrantAdmin) || (draft.preset === 'custom' && !draft.expires);

  async function submit(event) {
    event.preventDefault();
    if (blocked || busy) return;
    setError('');
    try {
      await onGrant(user, draft.role, draft.preset === 'forever' ? '' : draft.expires);
      setDraft({ role: '', preset: 'forever', expires: '' });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Drawer
      open
      title={user.username}
      subtitle={user.id}
      onClose={onClose}
      testId="rbac-user-drawer"
      source="rbac-user-drawer"
    >
      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-xs">
        <div><dt className="text-slate-400">注册</dt><dd className="mt-0.5 font-semibold text-slate-700">{formatTime(user.createdAt)}</dd></div>
        <div><dt className="text-slate-400">最后活跃</dt><dd className="mt-0.5 font-semibold text-slate-700">{user.lastActiveAt ? formatTime(user.lastActiveAt) : '从未'}</dd></div>
      </dl>

      <section className="mt-5">
        <h4 className="text-xs font-bold text-slate-500">已有角色</h4>
        <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200" aria-label="已有角色">
          <li className="flex items-center justify-between px-3 py-2.5 text-sm">
            <RoleChip role={{ code: 'user', name: '普通用户' }} />
            <span className="text-xs text-slate-400">默认</span>
          </li>
          {user.roles.map((role) => (
            <li key={role.code} className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <RoleChip role={role} />
              {canRevoke(role, roles, canGrantAdmin) ? (
                <button type="button" className="rounded-lg px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50" disabled={busy} aria-label={`撤销${role.name}`} onClick={() => onRevoke(user, role)}>撤销</button>
              ) : <span className="text-xs text-slate-400">{role.code === 'superadmin' ? '不可撤销' : '仅超级管理员'}</span>}
            </li>
          ))}
        </ul>
      </section>

      <form className="mt-5 space-y-3" aria-label={`授予角色：${user.username}`} onSubmit={submit}>
        <h4 className="text-xs font-bold text-slate-500">授予角色</h4>
        <select className={`${inputClass} w-full`} value={draft.role} disabled={busy} onChange={(event) => setDraft({ ...draft, role: event.target.value })} aria-label="选择角色">
          <option value="">选择角色…</option>
          {grantable.map((role) => (
            <option key={role.code} value={role.code} disabled={role.privileged && !canGrantAdmin}>
              {role.name}（{role.code}）{role.privileged && !canGrantAdmin ? ' · 仅超级管理员' : ''}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="有效期">
          {EXPIRY_PRESETS.map(([key, label, days]) => (
            <button
              key={key}
              type="button"
              aria-pressed={draft.preset === key}
              disabled={busy}
              className="ui-filter"
              onClick={() => setDraft({ ...draft, preset: key, expires: days === null ? draft.expires : presetToDateInput(days) })}
            >
              {label}
            </button>
          ))}
        </div>
        {draft.preset === 'custom' ? (
          <input type="date" className={`${inputClass} w-full`} value={draft.expires} disabled={busy} onChange={(event) => setDraft({ ...draft, expires: event.target.value })} aria-label="到期日" />
        ) : (
          <p className="text-xs text-slate-500">{draft.preset === 'forever' ? '长期有效' : `到期 ${draft.expires}（北京时间当天 23:59）`}</p>
        )}
        <ErrorNote error={error} />
        <button type="submit" className={`${buttonClass} w-full`} disabled={blocked || busy}>{busy ? '处理中…' : '确认授予'}</button>
      </form>
    </Drawer>
  );
}

/** 用户列表：输入即搜（防抖）、按角色筛选、20 行分页，点行打开详情抽屉。任命管理员仅超级管理员（服务端同样校验）。 */
export function RbacUsersPanel({ roles = [], canGrantAdmin = false, onChanged, onLoaded }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeQuery, setActiveQuery] = useState('');
  const [confirm, confirmNode] = useConfirm();
  const pendingSearches = useRef(new Map());
  const latestSearch = useRef(0);
  const lastQuery = useRef(null);
  const debounceTimer = useRef(null);

  const search = useCallback(async (searchQuery = '', { keepPage = false } = {}) => {
    const requestId = ++latestSearch.current;
    lastQuery.current = searchQuery;
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
        setActiveQuery(searchQuery);
        if (!keepPage) setPage(1);
        onLoaded?.(rows.length, rows, searchQuery);
      }
    } catch (err) {
      if (requestId === latestSearch.current) setError(err.message);
    } finally {
      if (requestId === latestSearch.current) setLoading(false);
    }
  }, [onLoaded]);

  useEffect(() => {
    search('');
    return () => {
      latestSearch.current += 1;
      clearTimeout(debounceTimer.current);
    };
  }, [search]);

  function handleQueryChange(value) {
    setQuery(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      if (value.trim() !== lastQuery.current) search(value.trim());
    }, SEARCH_DEBOUNCE_MS);
  }

  async function grant(user, roleCode, expires) {
    setBusy(true);
    try {
      await rbacAdminApi.grantRole(user.id, roleCode, expiryInputToIso(expires));
      showToast({ title: '已授予角色', description: `${user.username} → ${roleCode}`, tone: 'emerald' });
      await search(lastQuery.current ?? '', { keepPage: true });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(user, role) {
    const ok = await confirm({ title: '撤销角色', message: `确认撤销 ${user.username} 的「${role.name}」角色？`, confirmLabel: '撤销', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await rbacAdminApi.revokeRole(user.id, role.code);
      showToast({ title: '已撤销角色', tone: 'slate' });
      await search(lastQuery.current ?? '', { keepPage: true });
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const roleFilters = useMemo(() => {
    const counts = new Map();
    let none = 0;
    for (const user of users) {
      if (!user.roles.length) none += 1;
      for (const role of user.roles) counts.set(role.code, (counts.get(role.code) || 0) + 1);
    }
    const known = roles.filter((role) => role.code !== 'guest' && role.code !== 'user' && !role.isVirtual)
      .sort((a, b) => (b.level || 0) - (a.level || 0));
    return [
      { code: 'all', label: '全部', count: users.length },
      ...known.map((role) => ({ code: role.code, label: role.name, count: counts.get(role.code) || 0 })),
      { code: 'none', label: '无额外角色', count: none },
    ];
  }, [roles, users]);

  const filteredUsers = users.filter((user) => roleFilter === 'all'
    || (roleFilter === 'none' ? user.roles.length === 0 : user.roles.some((role) => role.code === roleFilter)));
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / PEOPLE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleUsers = filteredUsers.slice((currentPage - 1) * PEOPLE_PAGE_SIZE, currentPage * PEOPLE_PAGE_SIZE);
  const openUser = users.find((user) => user.id === openId) || null;

  return (
    <Panel title="注册用户" description="所有登录用户默认拥有「普通用户」。点击一行查看详情、授予或撤销角色；到期后自动失效。">
      <form className="relative" onSubmit={(event) => { event.preventDefault(); clearTimeout(debounceTimer.current); search(query.trim()); }}>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input type="search" className={`${inputClass} w-full pl-9`} value={query} onChange={(event) => handleQueryChange(event.target.value)} placeholder="搜索用户名或用户 ID" aria-label="搜索用户" />
      </form>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="按角色筛选">
        {roleFilters.map((item) => (
          <button key={item.code} type="button" aria-pressed={roleFilter === item.code} data-role-filter={item.code} className="ui-filter" onClick={() => { setRoleFilter(item.code); setPage(1); }}>
            {item.label}<span className="ml-1 tabular-nums opacity-75">{item.count}</span>
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm text-slate-600" aria-label="注册用户">
          <thead className="border-b border-slate-200 text-xs text-slate-400">
            <tr>{['用户', '角色', '注册', '最后活跃', ''].map((label, index) => <th key={label || index} scope="col" className={`px-2 py-2 font-medium ${index >= 2 && index <= 3 ? 'hidden md:table-cell' : ''}`}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {visibleUsers.map((user) => (
              <tr key={user.id} className="cursor-pointer border-b border-slate-100 hover:bg-indigo-50/40" data-testid="rbac-user-row" onClick={() => setOpenId(user.id)}>
                <td className="px-2 py-2.5">
                  <div className="font-semibold text-slate-900">{user.username}</div>
                  <div className="font-mono text-[11px] text-slate-400">{user.id}</div>
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {user.roles.length ? user.roles.map((role) => <RoleChip key={role.code} role={role} />) : <span className="text-xs text-slate-400">普通用户</span>}
                  </div>
                </td>
                <td className="hidden whitespace-nowrap px-2 py-2.5 text-xs md:table-cell">{formatTime(user.createdAt)}</td>
                <td className="hidden whitespace-nowrap px-2 py-2.5 text-xs md:table-cell">{user.lastActiveAt ? formatTime(user.lastActiveAt) : '从未'}</td>
                <td className="px-2 py-2.5 text-right">
                  <button type="button" className="inline-flex items-center rounded-lg p-1 text-slate-400 hover:bg-white hover:text-indigo-600" aria-label={`管理 ${user.username}`} onClick={(event) => { event.stopPropagation(); setOpenId(user.id); }}>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading ? <p className="mt-3 text-xs text-slate-400">正在加载用户…</p> : null}
      {!loading && !filteredUsers.length ? <p className="mt-3 text-xs text-slate-400">暂无匹配用户。</p> : null}
      <PeoplePagination page={currentPage} pageCount={pageCount} disabled={loading} onPageChange={setPage}>
        {roleFilter === 'all' ? `共 ${users.length} 位注册用户` : `筛选 ${filteredUsers.length} / ${users.length} 位注册用户`}{activeQuery && users.length >= PEOPLE_LIMIT ? `（当前查询取前 ${PEOPLE_LIMIT}）` : ''}
      </PeoplePagination>
      {openUser ? (
        <UserDrawer user={openUser} roles={roles} canGrantAdmin={canGrantAdmin} busy={busy} onClose={() => setOpenId('')} onGrant={grant} onRevoke={revoke} />
      ) : null}
      {confirmNode}
    </Panel>
  );
}
