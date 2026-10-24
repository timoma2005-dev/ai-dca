import { Fragment, useEffect, useMemo, useState } from 'react';
import { Check, Lock, MoreHorizontal, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import { rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import {
  apiCellState, applyMenuState, computeEffective, createDraft, diffDraft, groupMenus, isRoleLocked,
  menuCellState, nextMenuState, orderRolesByChain,
} from '../../app/rbac/rbacMatrix.js';
import { showToast } from '../../app/toast.js';
import { Drawer, ErrorNote, Panel, buttonClass, dangerButtonClass, inputClass, roleTone, subtleButtonClass, useConfirm } from './rbacUi.jsx';

const STATE_LABELS = { none: '无', view: '可见（锁住）', access: '可访问' };

function MenuCell({ cell, roleName, menuLabel, disabled, onClick }) {
  const { state, inherited, source } = cell;
  const tone = state === 'access'
    ? (inherited ? 'bg-emerald-50 text-emerald-500' : 'bg-emerald-500 text-white')
    : state === 'view'
      ? (inherited ? 'bg-amber-50 text-amber-500' : 'bg-amber-400 text-white')
      : 'bg-white text-slate-300 ring-1 ring-inset ring-slate-200';
  return (
    <button
      type="button"
      data-cell-state={state}
      data-inherited={inherited ? 'true' : undefined}
      disabled={disabled}
      aria-label={`${menuLabel} · ${roleName}：${STATE_LABELS[state]}${inherited ? `（继承自 ${source}）` : ''}`}
      title={inherited ? `继承自 ${source}` : STATE_LABELS[state]}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold transition ${tone} ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:scale-105'}`}
      onClick={onClick}
    >
      {state === 'access' ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" /> : state === 'view' ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : '—'}
    </button>
  );
}

function ApiCell({ cell, roleName, code, disabled, onClick }) {
  return (
    <button
      type="button"
      data-cell-state={cell.on ? 'on' : 'off'}
      data-inherited={cell.inherited ? 'true' : undefined}
      disabled={disabled || cell.inherited}
      aria-label={`${code} · ${roleName}：${cell.on ? '允许' : '无'}${cell.inherited ? `（继承自 ${cell.source}）` : ''}`}
      title={cell.inherited ? `继承自 ${cell.source}` : undefined}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold ${cell.on ? (cell.inherited ? 'bg-indigo-50 text-indigo-400' : 'bg-indigo-600 text-white') : 'bg-white text-slate-300 ring-1 ring-inset ring-slate-200'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      onClick={onClick}
    >
      {cell.on ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" /> : '—'}
    </button>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
      <span className="inline-flex items-center gap-1"><span className="inline-flex h-4 w-4 items-center justify-center rounded bg-emerald-500 text-white"><Check className="h-3 w-3" strokeWidth={3} /></span>可访问</span>
      <span className="inline-flex items-center gap-1"><span className="inline-flex h-4 w-4 items-center justify-center rounded bg-amber-400 text-white"><Lock className="h-2.5 w-2.5" /></span>可见（锁住）</span>
      <span className="inline-flex items-center gap-1"><span className="inline-flex h-4 w-4 items-center justify-center rounded text-slate-300 ring-1 ring-slate-200">—</span>无</span>
      <span className="inline-flex items-center gap-1"><span className="inline-flex h-4 w-4 rounded bg-emerald-50" />浅色 = 继承</span>
      <span>点击格子循环切换，改动先暂存</span>
    </div>
  );
}

function RoleEditor({ role, roles, canGrantAdmin, onClose, onDone }) {
  const creating = !role;
  const [form, setForm] = useState(() => (creating ? { code: '', name: '', parent: 'user', description: '' } : { name: role.name, description: role.description || '' }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  async function run(action, okText) {
    setBusy(true);
    setError('');
    try {
      await action();
      showToast({ title: okText, tone: 'emerald' });
      await onDone();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open title={creating ? '新建角色' : `编辑角色：${role.name}`} subtitle={creating ? '新角色自动继承父角色的全部权限' : role.code} onClose={onClose} testId="rbac-role-editor" source="rbac-role-editor">
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (creating) run(() => rbacAdminApi.createRole({ code: form.code.trim(), name: form.name.trim(), parent: form.parent, description: form.description }), '已创建角色');
        else run(() => rbacAdminApi.updateRole(role.code, { name: form.name.trim(), description: form.description }), '已保存');
      }}>
        {creating ? (
          <label className="block text-xs font-semibold text-slate-500">编码<input className={`${inputClass} mt-1 w-full`} placeholder="如 beta" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} aria-label="角色编码" /></label>
        ) : null}
        <label className="block text-xs font-semibold text-slate-500">名称<input className={`${inputClass} mt-1 w-full`} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} aria-label="角色名称" /></label>
        <label className="block text-xs font-semibold text-slate-500">说明<input className={`${inputClass} mt-1 w-full`} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} aria-label="角色说明" /></label>
        {creating ? (
          <label className="block text-xs font-semibold text-slate-500">继承自
            <select className={`${inputClass} mt-1 w-full`} value={form.parent} onChange={(event) => setForm({ ...form, parent: event.target.value })} aria-label="继承自">
              {roles.filter((item) => !item.isVirtual).map((item) => (
                <option key={item.code} value={item.code} disabled={item.privileged && !canGrantAdmin}>{item.name}（{item.code}）</option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-slate-500">继承自：{roles.find((item) => item.code === role.parent)?.name || '无'} · {role.userCount == null ? '全部登录用户' : `${role.userCount} 人`}</p>
        )}
        <ErrorNote error={error} />
        <button type="submit" className={`${buttonClass} w-full`} disabled={busy || !form.name.trim() || (creating && !form.code.trim())}>
          {creating ? <Plus className="h-4 w-4" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{creating ? '创建' : '保存'}
        </button>
      </form>
      {!creating && !role.isSystem ? (
        <button type="button" className={`${dangerButtonClass} mt-6 w-full`} disabled={busy} onClick={async () => {
          if (await confirm({ title: '删除角色', message: `删除角色「${role.name}」？已授予该角色的用户会失去它。`, confirmLabel: '删除', danger: true })) {
            run(() => rbacAdminApi.deleteRole(role.code), '已删除角色');
          }
        }}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />删除角色
        </button>
      ) : null}
      {confirmNode}
    </Drawer>
  );
}

/** 权限矩阵：行 = 菜单（按分组）+ 接口权限，列 = 角色（按继承链）。改动先暂存，底部统一保存。 */
export function RbacMatrixPanel({ roles = [], permissions = [], menus = [], canGrantAdmin = false, onChanged }) {
  const [draft, setDraft] = useState(() => createDraft(roles));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [mobileRole, setMobileRole] = useState('');
  useEffect(() => { setDraft(createDraft(roles)); }, [roles]);

  const columns = useMemo(() => orderRolesByChain(roles), [roles]);
  const effective = useMemo(() => computeEffective(roles, draft), [roles, draft]);
  const groups = useMemo(() => groupMenus(menus), [menus]);
  const known = useMemo(() => new Set(permissions.map((perm) => perm.code)), [permissions]);
  const apiPerms = useMemo(() => permissions.filter((perm) => perm.kind === 'api'), [permissions]);
  const { changes, count } = useMemo(() => diffDraft(roles, draft), [roles, draft]);
  const roleName = (code) => roles.find((role) => role.code === code)?.name || code;
  const named = (cell) => (cell.source ? { ...cell, source: roleName(cell.source) } : cell);
  const activeMobileRole = columns.find((role) => role.code === mobileRole) || columns[0] || null;

  useEffect(() => {
    if (!count || typeof window === 'undefined') return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [count]);

  function toggleMenu(role, menuKey) {
    const cell = menuCellState(role, menuKey, draft, effective);
    const target = nextMenuState(cell.state, cell.floor);
    const inherited = role.parent ? effective[role.parent] : new Map();
    setDraft((current) => ({ ...current, [role.code]: applyMenuState(current[role.code] || new Set(), menuKey, target, inherited) }));
  }

  function toggleApi(role, code) {
    setDraft((current) => {
      const next = new Set(current[role.code] || []);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return { ...current, [role.code]: next };
    });
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      for (const change of changes) await rbacAdminApi.setRolePermissions(change.code, change.perms);
      showToast({ title: '权限已保存', description: `${changes.length} 个角色，${count} 处改动`, tone: 'emerald' });
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const menuDisabled = (role, menuKey) => isRoleLocked(role, canGrantAdmin) || !known.has(`menu:${menuKey}:view`);

  return (
    <Panel
      title="权限矩阵"
      description="继承链 游客 → 普通用户 → VIP → SVIP → 管理员 → 超级管理员；子角色自动拥有父角色的权限。管理员相关列只有超级管理员可改。"
      actions={<button type="button" className={subtleButtonClass} onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden="true" />新建角色</button>}
    >
      <Legend />
      <div className="mt-3 hidden overflow-x-auto rounded-xl border border-slate-200 md:block">
        <table className="w-full min-w-[44rem] text-sm" aria-label="权限矩阵">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left font-semibold">菜单 / 接口</th>
              {columns.map((role) => (
                <th key={role.code} scope="col" className="px-2 py-2 text-center font-semibold" data-role-column={role.code}>
                  <div className="flex flex-col items-center gap-0.5">
                    <span className={`rounded-full px-2 py-0.5 ${roleTone(role.code)}`}>{role.name}</span>
                    <span className="text-[10px] font-normal text-slate-400">{role.userCount == null ? (role.isVirtual ? '未登录' : '全部') : `${role.userCount} 人`}</span>
                    {isRoleLocked(role, canGrantAdmin) ? <span className="text-[10px] font-normal text-slate-400">只读</span> : (
                      <button type="button" className="rounded p-0.5 text-slate-400 hover:bg-white hover:text-indigo-600" aria-label={`编辑角色 ${role.name}`} onClick={() => setEditing(role.code)}>
                        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.key}>
                <tr className="bg-slate-50/60"><th colSpan={columns.length + 1} scope="rowgroup" className="sticky left-0 px-3 py-1.5 text-left text-[11px] font-bold text-slate-400">{group.label}</th></tr>
                {group.menus.map((menu) => (
                  <tr key={menu.key} className="border-t border-slate-100" data-matrix-row={menu.key}>
                    <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-medium text-slate-800">
                      {menu.label}<span className="ml-1.5 font-mono text-[10px] font-normal text-slate-400">{menu.key}</span>
                      {!menu.enabled ? <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-400">已停用</span> : null}
                    </th>
                    {columns.map((role) => (
                      <td key={role.code} className="px-2 py-1.5 text-center">
                        <MenuCell cell={named(menuCellState(role, menu.key, draft, effective))} roleName={role.name} menuLabel={menu.label} disabled={menuDisabled(role, menu.key)} onClick={() => toggleMenu(role, menu.key)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
            {apiPerms.length ? (
              <tr className="bg-slate-50/60"><th colSpan={columns.length + 1} scope="rowgroup" className="sticky left-0 px-3 py-1.5 text-left text-[11px] font-bold text-slate-400">接口权限</th></tr>
            ) : null}
            {apiPerms.map((perm) => (
              <tr key={perm.code} className="border-t border-slate-100" data-matrix-row={perm.code}>
                <th scope="row" className="sticky left-0 z-10 max-w-[16rem] bg-white px-3 py-1.5 text-left font-normal">
                  <span className="font-mono text-xs text-slate-700">{perm.code}</span>
                  <span className="block truncate text-[11px] text-slate-400" title={perm.description}>{perm.description}</span>
                </th>
                {columns.map((role) => (
                  <td key={role.code} className="px-2 py-1.5 text-center">
                    <ApiCell cell={named(apiCellState(role, perm.code, draft, effective))} roleName={role.name} code={perm.code} disabled={isRoleLocked(role, canGrantAdmin)} onClick={() => toggleApi(role, perm.code)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {activeMobileRole ? (
        <div className="mt-3 space-y-3 md:hidden" data-testid="rbac-matrix-mobile">
          <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="选择角色">
            {columns.map((role) => (
              <button key={role.code} type="button" aria-pressed={activeMobileRole.code === role.code} className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${activeMobileRole.code === role.code ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`} onClick={() => setMobileRole(role.code)}>
                {role.name}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            继承自 {roleName(activeMobileRole.parent) || '无'}
            {isRoleLocked(activeMobileRole, canGrantAdmin) ? ' · 只读' : (
              <button type="button" className="ml-2 font-semibold text-indigo-600" onClick={() => setEditing(activeMobileRole.code)}>编辑角色</button>
            )}
          </p>
          {groups.map((group) => (
            <div key={group.key} className="rounded-xl border border-slate-200">
              <div className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-bold text-slate-400">{group.label}</div>
              <ul className="divide-y divide-slate-100">
                {group.menus.map((menu) => {
                  const cell = named(menuCellState(activeMobileRole, menu.key, draft, effective));
                  return (
                    <li key={menu.key} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">{menu.label}{cell.inherited ? <span className="ml-1 text-[10px] text-slate-400">继承 {cell.source}</span> : null}</span>
                      <span className="flex items-center gap-2 text-xs text-slate-500">{STATE_LABELS[cell.state]}<MenuCell cell={cell} roleName={activeMobileRole.name} menuLabel={menu.label} disabled={menuDisabled(activeMobileRole, menu.key)} onClick={() => toggleMenu(activeMobileRole, menu.key)} /></span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <div className="rounded-xl border border-slate-200">
            <div className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-bold text-slate-400">接口权限</div>
            <ul className="divide-y divide-slate-100">
              {apiPerms.map((perm) => (
                <li key={perm.code} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0"><span className="block truncate font-mono text-xs text-slate-700">{perm.code}</span><span className="block truncate text-[11px] text-slate-400">{perm.description}</span></span>
                  <ApiCell cell={named(apiCellState(activeMobileRole, perm.code, draft, effective))} roleName={activeMobileRole.name} code={perm.code} disabled={isRoleLocked(activeMobileRole, canGrantAdmin)} onClick={() => toggleApi(activeMobileRole, perm.code)} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <ErrorNote error={error} />
      {count ? (
        <div className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-indigo-200 bg-indigo-50/95 px-4 py-3 shadow-lg backdrop-blur md:bottom-4" data-testid="rbac-matrix-savebar" role="status">
          <span className="text-sm font-semibold text-indigo-900">已修改 {count} 处 · {changes.map((item) => roleName(item.code)).join('、')}</span>
          <span className="flex gap-2">
            <button type="button" className={subtleButtonClass} disabled={saving} onClick={() => setDraft(createDraft(roles))}><Undo2 className="h-4 w-4" aria-hidden="true" />撤销</button>
            <button type="button" className={buttonClass} disabled={saving} onClick={save}><Save className="h-4 w-4" aria-hidden="true" />{saving ? '保存中…' : '保存'}</button>
          </span>
        </div>
      ) : null}
      {editing ? (
        <RoleEditor
          role={editing === 'new' ? null : roles.find((role) => role.code === editing)}
          roles={roles}
          canGrantAdmin={canGrantAdmin}
          onClose={() => setEditing(null)}
          onDone={async () => { await onChanged?.(); }}
        />
      ) : null}
    </Panel>
  );
}
