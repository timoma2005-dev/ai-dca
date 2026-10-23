import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { rbacAdminApi } from '../app/rbac/rbacAdminApi.js';
import { refreshRbac } from '../app/rbac/rbacStore.js';
import { useRbac } from '../app/rbac/useRbac.js';
import { hasPerm } from '../app/rbac/menuModel.js';
import { PageTabs } from '../components/experience-ui.jsx';
import { RbacAuditPanel } from './rbac/RbacAuditPanel.jsx';
import { RbacMenusPanel } from './rbac/RbacMenusPanel.jsx';
import { RbacRolesPanel } from './rbac/RbacRolesPanel.jsx';
import { RbacUsersPanel } from './rbac/RbacUsersPanel.jsx';
import { RbacGuestsPanel } from './rbac/RbacGuestsPanel.jsx';
import { ErrorNote } from './rbac/rbacUi.jsx';

const SECTIONS = [
  { key: 'users', label: '用户角色' },
  { key: 'roles', label: '角色权限' },
  { key: 'menus', label: '菜单' },
  { key: 'audit', label: '审计日志' },
];

/** 权限管理（adminRbac）：需要 api:rbac-admin；任命管理员需要 api:rbac-grant-admin（超级管理员）。 */
export default function AdminRbacExperience() {
  const rbac = useRbac();
  const [section, setSection] = useState('users');
  const [data, setData] = useState({ roles: [], permissions: [], menus: [] });
  const [error, setError] = useState('');
  const canGrantAdmin = hasPerm(rbac, 'api:rbac-grant-admin');

  const reload = useCallback(async () => {
    try {
      const [roles, permissions, menus] = await Promise.all([rbacAdminApi.listRoles(), rbacAdminApi.listPermissions(), rbacAdminApi.listMenus()]);
      setData({ roles: roles.roles || [], permissions: permissions.permissions || [], menus: menus.menus || [] });
      setError('');
    } catch (err) {
      setError(err.status === 403 ? '需要管理员权限' : err.message);
    }
  }, []);

  const handleChanged = useCallback(async () => {
    await reload();
    // 自己的菜单可能也受影响（permVersion 变化时才会重渲染）。
    refreshRbac({ force: true });
  }, [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 pb-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><ShieldCheck className="h-5 w-5" aria-hidden="true" /></span>
          <div>
            <h2 className="text-lg font-bold text-slate-900">权限管理</h2>
            <p className="text-xs text-slate-500">{canGrantAdmin ? '超级管理员：可任命 / 撤销管理员' : '管理员：可管理 VIP / SVIP 等角色，任命管理员需超级管理员'}</p>
          </div>
        </div>
      </header>
      <PageTabs tabs={SECTIONS.map((s) => ({ ...s, href: `#${s.key}` }))} activeKey={section} onSelect={setSection} />
      <ErrorNote error={error} />
      {section === 'users' ? (
        <>
          <RbacUsersPanel roles={data.roles} canGrantAdmin={canGrantAdmin} onChanged={handleChanged} />
          <RbacGuestsPanel />
        </>
      ) : null}
      {section === 'roles' ? <RbacRolesPanel roles={data.roles} permissions={data.permissions} menus={data.menus} canGrantAdmin={canGrantAdmin} onChanged={handleChanged} /> : null}
      {section === 'menus' ? <RbacMenusPanel menus={data.menus} onChanged={handleChanged} /> : null}
      {section === 'audit' ? <RbacAuditPanel /> : null}
    </div>
  );
}
