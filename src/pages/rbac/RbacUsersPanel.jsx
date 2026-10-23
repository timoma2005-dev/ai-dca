import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { expiryInputToIso, rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { showToast } from '../../app/toast.js';
import { ErrorNote, Panel, buttonClass, formatTime, inputClass, subtleButtonClass } from './rbacUi.jsx';

const NON_GRANTABLE = new Set(['guest', 'user', 'superadmin']);

/** 搜用户 → 勾角色 / 设到期 / 撤销。任命管理员仅超级管理员（服务端同样校验）。 */
export function RbacUsersPanel({ roles = [], canGrantAdmin = false, onChanged }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});
  const grantable = roles.filter((role) => !NON_GRANTABLE.has(role.code) && !role.isVirtual);

  async function search(event) {
    event?.preventDefault?.();
    setLoading(true);
    setError('');
    try {
      const data = await rbacAdminApi.searchUsers(query);
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function updateDraft(userId, patch) {
    setDrafts((current) => ({ ...current, [userId]: { role: '', expires: '', ...current[userId], ...patch } }));
  }

  async function grant(user) {
    const draft = drafts[user.id] || {};
    if (!draft.role) return;
    try {
      await rbacAdminApi.grantRole(user.id, draft.role, expiryInputToIso(draft.expires));
      showToast({ title: '已授予角色', description: `${user.username} → ${draft.role}`, tone: 'emerald' });
      updateDraft(user.id, { role: '', expires: '' });
      await search();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revoke(user, role) {
    if (typeof window !== 'undefined' && !window.confirm(`确认撤销 ${user.username} 的「${role.name}」角色？`)) return;
    try {
      await rbacAdminApi.revokeRole(user.id, role.code);
      showToast({ title: '已撤销角色', tone: 'slate' });
      await search();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Panel title="用户角色" description="所有登录用户默认拥有「普通用户」。到期日留空表示长期有效，过期后自动失效。">
      <form className="flex flex-wrap gap-2" onSubmit={search}>
        <input className={`${inputClass} flex-1`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="用户名或用户 ID（留空列出已授权用户）" aria-label="搜索用户" />
        <button type="submit" className={buttonClass} disabled={loading}>
          <Search className="h-4 w-4" aria-hidden="true" />
          {loading ? '搜索中…' : '搜索'}
        </button>
      </form>
      <ErrorNote error={error} />
      <ul className="mt-4 space-y-3">
        {users.map((user) => {
          const draft = drafts[user.id] || { role: '', expires: '' };
          return (
            <li key={user.id} className="rounded-xl border border-slate-200 p-3" data-testid="rbac-user-row">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm font-bold text-slate-900">{user.username}</div>
                <div className="text-[11px] text-slate-400">{user.id} · 注册 {formatTime(user.createdAt)}</div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
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
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select className={inputClass} value={draft.role} onChange={(e) => updateDraft(user.id, { role: e.target.value })} aria-label="选择角色">
                  <option value="">选择角色…</option>
                  {grantable.map((role) => (
                    <option key={role.code} value={role.code} disabled={role.privileged && !canGrantAdmin}>
                      {role.name}（{role.code}）{role.privileged && !canGrantAdmin ? ' · 仅超级管理员' : ''}
                    </option>
                  ))}
                </select>
                <input type="date" className={inputClass} value={draft.expires} onChange={(e) => updateDraft(user.id, { expires: e.target.value })} aria-label="到期日（可选）" />
                <button type="button" className={subtleButtonClass} disabled={!draft.role} onClick={() => grant(user)}>授予 / 更新到期</button>
              </div>
            </li>
          );
        })}
      </ul>
      {!loading && !users.length ? <p className="mt-4 text-xs text-slate-400">输入用户名后搜索。</p> : null}
    </Panel>
  );
}
