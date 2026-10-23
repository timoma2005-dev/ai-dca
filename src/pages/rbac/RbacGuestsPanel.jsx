import { useEffect, useRef, useState } from 'react';
import { rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { ErrorNote, Panel } from './rbacUi.jsx';

export function RbacGuestsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef(null);

  useEffect(() => {
    let cancelled = false;
    // StrictMode 重放 effect 时复用请求，卸载后不再更新状态。
    request.current ||= rbacAdminApi.listGuests();
    request.current.then((result) => {
      if (!cancelled) setData(result);
    }).catch((err) => {
      if (!cancelled) setError(err.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const guests = Array.isArray(data?.guests) ? data.guests : [];
  return (
    <Panel title="游客（未注册访客）">
      <ErrorNote error={error} />
      {loading ? <p className="text-xs text-slate-400">正在加载游客…</p> : null}
      {!loading && data?.available === false ? <p className="text-xs text-slate-400">暂无游客数据（分析库不可用）</p> : null}
      {!loading && data?.available && !guests.length ? <p className="text-xs text-slate-400">暂无游客访问记录。</p> : null}
      {!loading && data?.available && guests.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>{['访客标识', '首次访问', '最近活跃', '活跃天数'].map((label) => <th key={label} className="px-2 py-2 font-medium">{label}</th>)}</tr>
            </thead>
            <tbody>
              {guests.map((guest) => (
                <tr key={guest.visitorId} className="border-b border-slate-100" data-testid="rbac-guest-row">
                  <td className="px-2 py-2 font-mono" title={guest.visitorId}>{guest.visitorId.length > 18 ? `${guest.visitorId.slice(0, 18)}…` : guest.visitorId}</td>
                  <td className="whitespace-nowrap px-2 py-2">{guest.firstSeenDate}</td>
                  <td className="whitespace-nowrap px-2 py-2">{guest.lastActiveDate}</td>
                  <td className="px-2 py-2">{guest.activeDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
