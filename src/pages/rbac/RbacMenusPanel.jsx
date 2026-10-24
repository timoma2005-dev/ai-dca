import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import { rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { groupMenus, MENU_GROUP_LABELS, reorderedSorts } from '../../app/rbac/rbacMatrix.js';
import { showToast } from '../../app/toast.js';
import { resolveMenuIcon } from '../../components/rbac/menu-icons.js';
import { Drawer, ErrorNote, Panel, buttonClass, dangerButtonClass, inputClass, subtleButtonClass, useConfirm } from './rbacUi.jsx';

const EMPTY = { key: '', label: '', group: 'primary', icon: '', subtitle: '' };

function Switch({ checked, disabled, label, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-indigo-600' : 'bg-slate-300'} disabled:opacity-50`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[1.375rem]' : 'left-0.5'}`} />
    </button>
  );
}

function MenuEditor({ menu, onClose, onDone }) {
  const creating = !menu;
  const [form, setForm] = useState(() => (creating ? EMPTY : { label: menu.label, group: menu.group, icon: menu.icon || '', subtitle: menu.subtitle || '' }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, confirmNode] = useConfirm();
  const Icon = resolveMenuIcon(form.icon, menu?.key || form.key);

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
    <Drawer open title={creating ? '新建菜单' : `编辑菜单：${menu.label}`} subtitle={creating ? '会自动生成 可见 / 可访问 两个权限；页面组件需在前端实现' : menu.key} onClose={onClose} testId="rbac-menu-editor" source="rbac-menu-editor">
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (creating) run(() => rbacAdminApi.createMenu({ ...form, key: form.key.trim(), label: form.label.trim() }), '菜单已创建');
        else run(() => rbacAdminApi.updateMenu(menu.key, { label: form.label.trim(), group: form.group, icon: form.icon, subtitle: form.subtitle }), '菜单已保存');
      }}>
        {creating ? <label className="block text-xs font-semibold text-slate-500">key<input className={`${inputClass} mt-1 w-full font-mono`} value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} aria-label="菜单 key" /></label> : null}
        <label className="block text-xs font-semibold text-slate-500">名称<input className={`${inputClass} mt-1 w-full`} value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} aria-label="菜单名称" /></label>
        <label className="block text-xs font-semibold text-slate-500">分组
          <select className={`${inputClass} mt-1 w-full`} value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} aria-label="菜单分组">
            {Object.entries(MENU_GROUP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="block text-xs font-semibold text-slate-500">图标（lucide 名）
          <span className="mt-1 flex items-center gap-2">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"><Icon className="h-4 w-4" aria-hidden="true" /></span>
            <input className={`${inputClass} w-full`} value={form.icon} onChange={(event) => setForm({ ...form, icon: event.target.value })} placeholder="如 Wallet" aria-label="菜单图标" />
          </span>
        </label>
        <label className="block text-xs font-semibold text-slate-500">副标题<input className={`${inputClass} mt-1 w-full`} value={form.subtitle} onChange={(event) => setForm({ ...form, subtitle: event.target.value })} aria-label="菜单副标题" /></label>
        <ErrorNote error={error} />
        <button type="submit" className={`${buttonClass} w-full`} disabled={busy || !form.label.trim() || (creating && !form.key.trim())}>
          {creating ? <Plus className="h-4 w-4" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{creating ? '创建' : '保存'}
        </button>
      </form>
      {!creating && menu.key !== 'adminRbac' ? (
        <button type="button" className={`${dangerButtonClass} mt-6 w-full`} disabled={busy} onClick={async () => {
          if (await confirm({ title: '删除菜单', message: `删除菜单「${menu.label}」？对应的可见 / 可访问权限会一并删除。`, confirmLabel: '删除', danger: true })) {
            run(() => rbacAdminApi.deleteMenu(menu.key), '菜单已删除');
          }
        }}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />删除菜单
        </button>
      ) : null}
      {confirmNode}
    </Drawer>
  );
}

/** 菜单：按主导航 / 管理分组；启用开关即点即生效；上下箭头调序后一次保存；编辑与新建在抽屉里。 */
export function RbacMenusPanel({ menus = [], onChanged }) {
  const [order, setOrder] = useState(() => groupMenus(menus));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null);
  useEffect(() => { setOrder(groupMenus(menus)); }, [menus]);

  const sortChanges = useMemo(() => order.flatMap((group) => reorderedSorts(group.menus)), [order]);

  function move(groupKey, index, delta) {
    setOrder((current) => current.map((group) => {
      if (group.key !== groupKey) return group;
      const list = [...group.menus];
      const target = index + delta;
      if (target < 0 || target >= list.length) return group;
      [list[index], list[target]] = [list[target], list[index]];
      return { ...group, menus: list };
    }));
  }

  async function toggle(menu, enabled) {
    setBusy(menu.key);
    setError('');
    try {
      await rbacAdminApi.updateMenu(menu.key, { enabled });
      showToast({ title: enabled ? `已启用「${menu.label}」` : `已停用「${menu.label}」`, tone: enabled ? 'emerald' : 'slate' });
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function saveOrder() {
    setBusy('order');
    setError('');
    try {
      for (const item of sortChanges) await rbacAdminApi.updateMenu(item.key, { sort: item.sort });
      showToast({ title: '排序已保存', tone: 'emerald' });
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <Panel
      title="菜单"
      description="分组、排序与启用状态会实时反映到所有用户的侧边栏、底部导航和搜索。"
      actions={<button type="button" className={subtleButtonClass} onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden="true" />新建菜单</button>}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {order.map((group) => (
          <section key={group.key} className="rounded-xl border border-slate-200" aria-label={`${group.label}菜单`}>
            <h4 className="border-b border-slate-100 px-3 py-2 text-xs font-bold text-slate-500">{group.label}<span className="ml-1 font-normal text-slate-400">{group.menus.length}</span></h4>
            <ul className="divide-y divide-slate-100">
              {group.menus.map((menu, index) => {
                const Icon = resolveMenuIcon(menu.icon, menu.key);
                return (
                  <li key={menu.key} className="flex items-center gap-2 px-3 py-2" data-testid="rbac-menu-row" data-menu-key={menu.key}>
                    <span className="flex flex-col">
                      <button type="button" className="rounded p-0.5 text-slate-400 hover:text-indigo-600 disabled:opacity-30" disabled={index === 0 || Boolean(busy)} aria-label={`上移 ${menu.label}`} onClick={() => move(group.key, index, -1)}><ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
                      <button type="button" className="rounded p-0.5 text-slate-400 hover:text-indigo-600 disabled:opacity-30" disabled={index === group.menus.length - 1 || Boolean(busy)} aria-label={`下移 ${menu.label}`} onClick={() => move(group.key, index, 1)}><ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    </span>
                    <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${menu.enabled ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-400'}`}><Icon className="h-4 w-4" aria-hidden="true" /></span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm font-semibold ${menu.enabled ? 'text-slate-800' : 'text-slate-400'}`}>{menu.label}</span>
                      <span className="block truncate font-mono text-[11px] text-slate-400">{menu.key}</span>
                    </span>
                    <button type="button" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600" aria-label={`编辑 ${menu.label}`} onClick={() => setEditing(menu.key)}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <Switch checked={Boolean(menu.enabled)} disabled={Boolean(busy) || menu.key === 'adminRbac'} label={`${menu.label} 启用`} onChange={(next) => toggle(menu, next)} />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <ErrorNote error={error} />
      {sortChanges.length ? (
        <div className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-indigo-200 bg-indigo-50/95 px-4 py-3 shadow-lg backdrop-blur md:bottom-4" data-testid="rbac-menu-savebar" role="status">
          <span className="text-sm font-semibold text-indigo-900">排序已调整 {sortChanges.length} 项</span>
          <span className="flex gap-2">
            <button type="button" className={subtleButtonClass} disabled={Boolean(busy)} onClick={() => setOrder(groupMenus(menus))}><Undo2 className="h-4 w-4" aria-hidden="true" />撤销</button>
            <button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={saveOrder}><Save className="h-4 w-4" aria-hidden="true" />{busy === 'order' ? '保存中…' : '保存排序'}</button>
          </span>
        </div>
      ) : null}
      {editing ? (
        <MenuEditor menu={editing === 'new' ? null : menus.find((menu) => menu.key === editing)} onClose={() => setEditing(null)} onDone={async () => { await onChanged?.(); }} />
      ) : null}
    </Panel>
  );
}
