/**
 * 纳指 ETF 套利雷达（测试版，所需角色以服务端菜单 requiredRole 为准，当前 SVIP；权限见 docs/plan-rbac.md）
 * 数据来自 /api/notify/nasdaq-radar（工作日 21:35 计划计算后写入）
 * 面板实现见 src/pages/radar/RadarPanel.jsx。
 */
import { canAccessMenuFromSession, isAnalyticsAdmin } from '../app/analytics.js';
import RadarPanel from './radar/RadarPanel.jsx';
import { useDemoActive, useRequiredRoleLabel } from '../components/rbac/demo-lock.jsx';

export function AdminRadarExperience({ session }) {
  const demo = useDemoActive();
  const roleLabel = useRequiredRoleLabel('adminRadar', 'SVIP');
  if (!isAnalyticsAdmin(session) && !canAccessMenuFromSession(session, 'adminRadar') && !demo) {
    return <p className="p-5 text-sm text-slate-500">当前账号没有雷达权限（需要 {roleLabel}）。</p>;
  }
  return (
    <div className="mx-auto max-w-6xl min-w-0 p-4">
      <RadarPanel session={session} />
    </div>
  );
}

export default AdminRadarExperience;
