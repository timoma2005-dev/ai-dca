/**
 * 管理员纳指 ETF 套利雷达（测试版）
 * 数据来自 /api/notify/nasdaq-radar（工作日 21:35 计划计算后写入）
 * 改版后仅保留管理员门控与 Tab 挂载；面板实现见 src/pages/radar/*。
 */
import { useState } from 'react';
import { isAnalyticsAdmin } from '../app/analytics.js';
import EtfPcfSharesPanel from './EtfPcfSharesPanel.jsx';
import RadarPanel from './radar/RadarPanel.jsx';
import { PageTabs } from '../components/experience-ui.jsx';

export function AdminRadarExperience({ session }) {
  const [activeTab, setActiveTab] = useState('radar');
  if (!isAnalyticsAdmin(session)) {
    return <p className="p-5 text-sm text-slate-500">当前账号没有权限。请使用 lovexl 登录后访问。</p>;
  }
  return (
    <div className="mx-auto max-w-6xl min-w-0 p-4">
      <PageTabs
        tablistLabel="管理员雷达"
        tabs={[
          { key: 'radar', label: '套利雷达', href: '#radar' },
          { key: 'shares', label: '份额新增', href: '#shares' }
        ]}
        activeKey={activeTab}
        onSelect={setActiveTab}
      />
      <div role="tabpanel" id="panel-radar" aria-labelledby="tab-radar" hidden={activeTab !== 'radar'} tabIndex={0} className="mt-4">
        {activeTab === 'radar' && <RadarPanel session={session} />}
      </div>
      <div role="tabpanel" id="panel-shares" aria-labelledby="tab-shares" hidden={activeTab !== 'shares'} tabIndex={0} className="mt-4">
        {activeTab === 'shares' && <EtfPcfSharesPanel />}
      </div>
    </div>
  );
}

export default AdminRadarExperience;
