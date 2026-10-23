import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { buildPermissionMatrix, rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { showToast } from '../../app/toast.js';
import { ErrorNote, Panel, buttonClass, dangerButtonClass, inputClass, subtleButtonClass } from './rbacUi.jsx';

function PermCheckbox({ cell, checked, onToggle, disabled }) {
  if (!cell.exists) return <span className="text-slate-300">—</span>;
  const inheritedOnly = cell.inherited && !checked;
  return (
    <label className="inline-flex items-center gap-1 text-xs">
      <input
        type="checkbox"
        className="h-4 w-4 accent-indigo-600"
        checked={checked || cell.inherited}
        disabled={disabled || inheritedOnly}
        onChange={() => onToggle(cell.code)}
      />
      {inheritedOnly ? <span className="text-[10px] text-slate-400">继承</span> : null}
    </label>
  );
}

/** 角色 CRUD + 勾选菜单权限（可见 / 可访问）与接口权限。子角色自动继承父角色权限。 */
export function RbacRolesPanel({ roles = [], permissions = [], menus = [], canGrantAdmin = false, onChanged }) {
  const [selected, setSelected] = useState('');
  const [draftPerms, setDraftPerms] = useState(null);
  const [form, setForm] = useState({ code: '', name: '', parent: 'user' });
  const [meta, setMeta] = useState({ name: '', description: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const role = roles.find((r) => r.code === selected) || null;
  const locked = Boolean(role && role.privileged && !canGrantAdmin);

  useEffect(() => {
    setDraftPerms(role ? new Set(role.perms) : null);
    setMeta(role ? { name: role.name, description: role.description || '' } : { name: '', description: '' });
  }, [role]);

  const matrix = useMemo(
    () => buildPermissionMatrix({ role: role ? { ...role, perms: [...(draftPerms || [])] } : null, roles, permissions, menus }),
    [role, draftPerms, roles, permissions, menus],
  );

  function toggle(code) {
    setDraftPerms((current) => {
      const next = new Set(current || []);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function run(action, okText) {
    setBusy(true);
    setError('');
    try {
      await action();
      if (okText) showToast({ title: okText, tone: 'emerald' });
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="角色与权限" description="继承链 游客 ← 普通用户 ← VIP ← SVIP ← 管理员 ← 超级管理员。勾「可见」不勾「可访问」时，菜单对该角色显示为锁住。">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div className="space-y-3">
          <ul className="space-y-1" aria-label="角色列表">
            {roles.map((r) => (
              <li key={r.code}>
                <button
                  type="button"
                  onClick={() => setSelected(r.code)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${selected === r.code ? 'bg-indigo-50 font-bold text-indigo-700' : 'text-slate-700 hover:bg-slate-50'}`}
                >
                  <span className="truncate">{r.name}<span className="ml-1 text-[11px] font-normal text-slate-400">{r.code}</span></span>
                  <span className="shrink-0 text-[11px] text-slate-400">{r.userCount == null ? '全部' : `${r.userCount} 人`}</span>
                </button>
              </li>
            ))}
          </ul>
          <form
            className="space-y-2 rounded-xl border border-dashed border-slate-200 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => rbacAdminApi.createRole(form), '已创建角色').then(() => setForm({ code: '', name: '', parent: 'user' }));
            }}
          >
            <div className="text-xs font-bold text-slate-600">新建角色</div>
            <input className={`${inputClass} w-full`} placeholder="编码，如 beta" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} aria-label="角色编码" />
            <input className={`${inputClass} w-full`} placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="角色名称" />
            <select className={`${inputClass} w-full`} value={form.parent} onChange={(e) => setForm({ ...form, parent: e.target.value })} aria-label="继承自">
              {roles.filter((r) => !r.isVirtual).map((r) => (
                <option key={r.code} value={r.code} disabled={r.privileged && !canGrantAdmin}>继承 {r.name}</option>
              ))}
            </select>
            <button type="submit" className={`${buttonClass} w-full`} disabled={busy || !form.code || !form.name}>
              <Plus className="h-4 w-4" aria-hidden="true" />创建
            </button>
          </form>
        </div>

        <div className="min-w-0">
          {!role ? <p className="text-sm text-slate-400">选择左侧角色查看与编辑权限。</p> : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-slate-500">名称<input className={`${inputClass} mt-1 block`} value={meta.name} disabled={locked} onChange={(e) => setMeta({ ...meta, name: e.target.value })} /></label>
                <label className="min-w-[12rem] flex-1 text-xs text-slate-500">说明<input className={`${inputClass} mt-1 block w-full`} value={meta.description} disabled={locked} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></label>
                <button type="button" className={subtleButtonClass} disabled={busy || locked} onClick={() => run(() => rbacAdminApi.updateRole(role.code, meta), '已保存')}>保存信息</button>
                {!role.isSystem ? (
                  <button type="button" className={dangerButtonClass} disabled={busy || locked} onClick={() => {
                    if (window.confirm(`删除角色「${role.name}」？已授予该角色的用户会失去它。`)) run(() => rbacAdminApi.deleteRole(role.code), '已删除').then(() => setSelected(''));
                  }}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />删除
                  </button>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">
                继承自：{roles.find((r) => r.code === role.parent)?.name || '无'}
                {locked ? ' · 管理员相关角色只能由超级管理员修改' : ''}
              </p>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[22rem] text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr><th className="px-3 py-2 text-left font-semibold">菜单</th><th className="px-3 py-2 font-semibold">可见</th><th className="px-3 py-2 font-semibold">可访问</th></tr>
                  </thead>
                  <tbody>
                    {matrix.menuRows.map((row) => (
                      <tr key={row.key} className="border-t border-slate-100">
                        <td className="px-3 py-2">{row.label}<span className="ml-1 text-[11px] text-slate-400">{row.key}</span></td>
                        <td className="px-3 py-2 text-center"><PermCheckbox cell={row.view} checked={row.view.own} onToggle={toggle} disabled={locked} /></td>
                        <td className="px-3 py-2 text-center"><PermCheckbox cell={row.access} checked={row.access.own} onToggle={toggle} disabled={locked} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="mb-2 text-xs font-bold text-slate-600">接口权限</div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {matrix.apiRows.map((row) => (
                    <label key={row.code} className="flex items-start gap-2 text-xs text-slate-700">
                      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-indigo-600" checked={row.own || row.inherited} disabled={locked || (row.inherited && !row.own)} onChange={() => toggle(row.code)} />
                      <span><span className="font-mono">{row.code}</span>{row.inherited && !row.own ? <span className="ml-1 text-slate-400">继承</span> : null}<span className="block text-[11px] text-slate-400">{row.description}</span></span>
                    </label>
                  ))}
                </div>
              </div>
              <button type="button" className={buttonClass} disabled={busy || locked} onClick={() => run(() => rbacAdminApi.setRolePermissions(role.code, [...(draftPerms || [])]), '权限已保存')}>
                <Save className="h-4 w-4" aria-hidden="true" />保存权限
              </button>
            </div>
          )}
          <ErrorNote error={error} />
        </div>
      </div>
    </Panel>
  );
}
