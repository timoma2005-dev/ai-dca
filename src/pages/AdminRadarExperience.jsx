/**
 * 管理员纳指 ETF 套利雷达（测试版）
 * 数据来自 /api/notify/nasdaq-radar（工作日 21:35 计划计算后写入）
 * 面板实现见 src/pages/radar/RadarPanel.jsx。
 */
import { isAnalyticsAdmin } from '../app/analytics.js';
import RadarPanel from './radar/RadarPanel.jsx';

export function AdminRadarExperience({ session }) {
  if (!isAnalyticsAdmin(session)) {
    return <p className="p-5 text-sm text-slate-500">当前账号没有权限。请使用 lovexl 登录后访问。</p>;
  }
  return (
    <div className="mx-auto max-w-6xl min-w-0 p-4">
      <RadarPanel session={session} />
    </div>
  );
}

export default AdminRadarExperience;
