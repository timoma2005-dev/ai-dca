import { apiUrl } from '../app/apiBase.js';

// 红利低波年线看板（adminHongli，仅超级管理员）：中证红利低波动全收益指数（H20269）等
// 收盘价 vs 250 日年线（SMA250）偏离度看板 + MA250 首次下穿信号回测。
// 页面本体由后端 /opt/ai-dca-hongli/hongli_api.py（127.0.0.1:18092）以 iframe 提供（embed.html，指标说明在看板内），
// 权限由 nginx auth_request（api:hongli）校验；数据每日 19:05 自动采集，看板内「刷新数据」按钮可手动触发。
export default function AdminHongliExperience() {
  return (
    <iframe
      title="红利低波年线看板"
      src={apiUrl('/api/hongli/embed')}
      sandbox="allow-scripts allow-same-origin"
      style={{
        width: '100%',
        height: 'calc(100vh - 150px)',
        minHeight: 760,
        border: '1px solid var(--border-color, #e2e8f0)',
        borderRadius: 12,
        background: '#f4f5f7',
      }}
    />
  );
}
