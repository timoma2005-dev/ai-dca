import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { rbacAdminApi } from '../app/rbac/rbacAdminApi.js';
import { refreshRbac } from '../app/rbac/rbacStore.js';
import { useRbac } from '../app/rbac/useRbac.js';
import { hasPerm } from '../app/rbac/menuModel.js';
import { PageTabs } from '../components/experience-ui.jsx';
import { RbacAuditPanel } from './rbac/RbacAuditPanel.jsx';
import { RbacMatrixPanel } from './rbac/RbacMatrixPanel.jsx';
import { RbacMenusPanel } from './rbac/RbacMenusPanel.jsx';
import { RbacUsersPanel } from './rbac/RbacUsersPanel.jsx';
import { RbacGuestsPanel } from './rbac/RbacGuestsPanel.jsx';
import { ErrorNote, PEOPLE_LIMIT, StatCard } from './rbac/rbacUi.jsx';

export const RBAC_SECTIONS = [
  { key: 'users', label: '用户' },
  { key: 'guests', label: '游客' },
  { key: 'matrix', label: '权限矩阵' },
  { key: 'menus', label: '菜单' },
  { key: 'audit', label: '审计' },
];
const SECTION_KEYS = new Set(RBAC_SECTIONS.map((item) => item.key));
// 旧链接 #roles 指向原「角色权限」，现合并到权限矩阵。
const LEGACY_SECTIONS = { roles: 'matrix' };

export function sectionFromHash(hash = '') {
  const key = String(hash || '').replace(/^#/, '').split(/[?&]/)[0];
  if (SECTION_KEYS.has(key)) return key;
  return LEGACY_SECTIONS[key] || 'users';
}

function readHashSection() {
  return typeof window === 'undefined' ? 'users' : sectionFromHash(window.location.hash);
}

const capped = (count) => (count === null ? null : `${count}${count >= PEOPLE_LIMIT ? '+' : ''}`);

/** 权限管理（adminRbac）：需要 api:rbac-admin；任命管理员需要 api:rbac-grant-admin（超级管理员）。 */
export default function AdminRbacExperience() {
  const rbac = useRbac();
  const [section, setSection] = useState(readHashSection);
  const [visited, setVisited] = useState(() => new Set([readHashSection()]));
  const [data, setData] = useState({ roles: [], permissions: [], menus: [] });
  const [error, setError] = useState('');
  const [userStats, setUserStats] = useState({ count: null, privileged: null });
  const [guestCount, setGuestCount] = useState(null);
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

  const handleUsersLoaded = useCallback((count, rows, query) => {
    if (query) return;
    setUserStats({ count, privileged: Array.isArray(rows) ? rows.filter((user) => user.roles?.length).length : null });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const selectSection = useCallback((key) => {
    setSection(key);
    setVisited((current) => (current.has(key) ? current : new Set([...current, key])));
    if (typeof window !== 'undefined' && window.location.hash !== `#${key}`) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${key}`);
    }
  }, []);

  useEffect(() => {
    const onHash = () => selectSection(readHashSection());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [selectSection]);

  const enabledMenus = data.menus.filter((menu) => menu.enabled).length;
  const counts = {
    users: capped(userStats.count),
    guests: capped(guestCount),
    matrix: data.roles.length ? String(data.roles.length) : null,
    menus: data.menus.length ? String(data.menus.length) : null,
  };
  const tabs = RBAC_SECTIONS.map((item) => ({
    key: item.key,
    href: `#${item.key}`,
    label: counts[item.key] ? <span>{item.label}<span className="ml-1.5 text-xs tabular-nums opacity-75">{counts[item.key]}</span></span> : item.label,
  }));
  const show = (key) => visited.has(key) || section === key;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 pb-24 md:pb-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><ShieldCheck className="h-5 w-5" aria-hidden="true" /></span>
          <div>
            <h2 className="text-lg font-bold text-slate-900">权限管理</h2>
            <p className="text-xs text-slate-500">{canGrantAdmin ? '超级管理员：可任命 / 撤销管理员' : '管理员：可管理 VIP / SVIP 等角色，任命管理员需超级管理员'}</p>
          </div>
        </div>
      </header>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="概览">
        <StatCard label="注册用户" value={userStats.count} />
        <StatCard label="特权用户" value={userStats.privileged} hint="拥有额外角色" />
        <StatCard label="角色" value={data.roles.length || null} hint={data.roles.length ? `${data.roles.filter((role) => role.privileged).length} 个管理员级` : undefined} />
        <StatCard label="菜单" value={data.menus.length || null} hint={data.menus.length ? `${enabledMenus} 个启用` : undefined} />
      </div>
      <PageTabs tabs={tabs} activeKey={section} onSelect={selectSection} />
      <ErrorNote error={error} />
      {/* 用户列表始终挂载：概览卡的注册 / 特权用户数来自它的首轮加载。 */}
      <div hidden={section !== 'users'}>
        <RbacUsersPanel roles={data.roles} canGrantAdmin={canGrantAdmin} onChanged={handleChanged} onLoaded={handleUsersLoaded} />
      </div>
      {show('guests') ? (
        <div hidden={section !== 'guests'}>
          <RbacGuestsPanel onLoaded={setGuestCount} />
        </div>
      ) : null}
      {show('matrix') ? (
        <div hidden={section !== 'matrix'}>
          <RbacMatrixPanel roles={data.roles} permissions={data.permissions} menus={data.menus} canGrantAdmin={canGrantAdmin} onChanged={handleChanged} />
        </div>
      ) : null}
      {show('menus') ? (
        <div hidden={section !== 'menus'}>
          <RbacMenusPanel menus={data.menus} onChanged={handleChanged} />
        </div>
      ) : null}
      {show('audit') ? (
        <div hidden={section !== 'audit'}>
          <RbacAuditPanel roles={data.roles} menus={data.menus} />
        </div>
      ) : null}
    </div>
  );
}
