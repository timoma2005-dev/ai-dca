import { useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { showToast } from '../../app/toast.js';
import { ErrorNote, Panel, buttonClass, dangerButtonClass, inputClass, subtleButtonClass } from './rbacUi.jsx';

const EMPTY = { key: '', label: '', group: 'primary', sort: 1000, icon: '', subtitle: '' };

/** 菜单 CRUD。新建菜单会自动生成 menu:<key>:view / access 两个权限；页面组件仍需在前端 key→组件映射中实现。 */
export function RbacMenusPanel({ menus = [], onChanged }) {
  const [edits, setEdits] = useState({});
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function edit(key, patch) {
    setEdits((current) => ({ ...current, [key]: { ...menus.find((m) => m.key === key), ...current[key], ...patch } }));
  }

  async function run(action, okText) {
    setBusy(true);
    setError('');
    try {
      await action();
      if (okText) showToast({ title: okText, tone: 'emerald' });
      await onChanged?.();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="菜单" description="排序、分组（primary 主导航 / admin 管理分组）与启用状态会实时反映到所有用户的侧边栏、底部导航和搜索。">
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">key</th>
              <th className="px-3 py-2 text-left font-semibold">名称</th>
              <th className="px-3 py-2 text-left font-semibold">分组</th>
              <th className="px-3 py-2 text-left font-semibold">排序</th>
              <th className="px-3 py-2 text-left font-semibold">启用</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {menus.map((menu) => {
              const row = edits[menu.key] || menu;
              const dirty = Boolean(edits[menu.key]);
              return (
                <tr key={menu.key} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{menu.key}</td>
                  <td className="px-3 py-2"><input className={`${inputClass} w-28`} value={row.label} onChange={(e) => edit(menu.key, { label: e.target.value })} aria-label={`${menu.key} 名称`} /></td>
                  <td className="px-3 py-2">
                    <select className={inputClass} value={row.group} onChange={(e) => edit(menu.key, { group: e.target.value })} aria-label={`${menu.key} 分组`}>
                      <option value="primary">primary</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-3 py-2"><input type="number" className={`${inputClass} w-20`} value={row.sort} onChange={(e) => edit(menu.key, { sort: Number(e.target.value) })} aria-label={`${menu.key} 排序`} /></td>
                  <td className="px-3 py-2"><input type="checkbox" className="h-4 w-4 accent-indigo-600" checked={Boolean(row.enabled)} onChange={(e) => edit(menu.key, { enabled: e.target.checked })} aria-label={`${menu.key} 启用`} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button type="button" className={subtleButtonClass} disabled={!dirty || busy} onClick={async () => {
                      const { label, group, sort, enabled, subtitle, icon } = row;
                      if (await run(() => rbacAdminApi.updateMenu(menu.key, { label, group, sort, enabled, subtitle, icon }), '菜单已保存')) {
                        setEdits((current) => { const next = { ...current }; delete next[menu.key]; return next; });
                      }
                    }}>
                      <Save className="h-3.5 w-3.5" aria-hidden="true" />保存
                    </button>
                    {menu.key !== 'adminRbac' ? (
                      <button type="button" className={`${dangerButtonClass} ml-1.5`} disabled={busy} onClick={() => {
                        if (window.confirm(`删除菜单「${menu.label}」？对应的可见 / 可访问权限会一并删除。`)) run(() => rbacAdminApi.deleteMenu(menu.key), '菜单已删除');
                      }}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form
        className="mt-4 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-200 p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => rbacAdminApi.createMenu({ ...form, sort: Number(form.sort) || 1000 }), '菜单已创建')) setForm(EMPTY);
        }}
      >
        <input className={`${inputClass} w-32`} placeholder="key" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} aria-label="新菜单 key" />
        <input className={`${inputClass} w-32`} placeholder="名称" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} aria-label="新菜单名称" />
        <select className={inputClass} value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} aria-label="新菜单分组">
          <option value="primary">primary</option>
          <option value="admin">admin</option>
        </select>
        <input type="number" className={`${inputClass} w-24`} value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })} aria-label="新菜单排序" />
        <input className={`${inputClass} w-32`} placeholder="图标（lucide 名）" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} aria-label="新菜单图标" />
        <button type="submit" className={buttonClass} disabled={busy || !form.key || !form.label}>
          <Plus className="h-4 w-4" aria-hidden="true" />新建菜单
        </button>
      </form>
      <ErrorNote error={error} />
    </Panel>
  );
}
