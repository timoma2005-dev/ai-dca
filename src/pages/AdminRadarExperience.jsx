/**
 * 纳指 ETF 套利雷达（测试版，VIP 及以上；权限见 docs/plan-rbac.md）
 * 数据来自 /api/notify/nasdaq-radar（工作日 21:35 计划计算后写入）
 * 面板实现见 src/pages/radar/RadarPanel.jsx。
 */
import { canAccessMenuFromSession, isAnalyticsAdmin } from '../app/analytics.js';
import RadarPanel from './radar/RadarPanel.jsx';
import { isFeatureDemoActive } from '../app/demo/demoMode.js';

export function AdminRadarExperience({ session }) {
  if (!isAnalyticsAdmin(session) && !canAccessMenuFromSession(session, 'adminRadar') && !isFeatureDemoActive()) {
    return <p className="p-5 text-sm text-slate-500">当前账号没有雷达权限（需要 VIP）。</p>;
  }
  return (
    <div className="mx-auto max-w-6xl min-w-0 p-4">
      <RadarPanel session={session} />
    </div>
  );
}

export default AdminRadarExperience;
