import { useEffect, useRef, useState } from 'react';
import { rbacAdminApi } from '../../app/rbac/rbacAdminApi.js';
import { ErrorNote, Panel, PeoplePagination, PEOPLE_LIMIT, PEOPLE_PAGE_SIZE, inputClass } from './rbacUi.jsx';

export function RbacGuestsPanel({ onLoaded }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const request = useRef(null);

  useEffect(() => {
    let cancelled = false;
    // StrictMode 重放 effect 时复用请求，卸载后不再更新状态。
    request.current ||= rbacAdminApi.listGuests();
    request.current.then((result) => {
      if (!cancelled) {
        setData(result);
        onLoaded?.(Array.isArray(result.guests) ? result.guests.length : 0);
      }
    }).catch((err) => {
      if (!cancelled) setError(err.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [onLoaded]);

  const guests = Array.isArray(data?.guests) ? data.guests : [];
  const filteredGuests = guests.filter((guest) => guest.visitorId.toLowerCase().includes(query.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filteredGuests.length / PEOPLE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleGuests = filteredGuests.slice((currentPage - 1) * PEOPLE_PAGE_SIZE, currentPage * PEOPLE_PAGE_SIZE);

  return (
    <Panel title="游客（未注册访客）">
      <input type="search" className={`${inputClass} w-full`} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="按访客标识搜索" aria-label="搜索游客" />
      <ErrorNote error={error} />
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm text-slate-600" aria-label="游客">
          <thead className="border-b border-slate-200 text-xs text-slate-400">
            <tr>{['访客标识', '首次访问', '最近活跃', '活跃天数'].map((label) => <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>)}</tr>
          </thead>
          <tbody>
            {visibleGuests.map((guest) => (
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
      {loading ? <p className="mt-3 text-xs text-slate-400">正在加载游客…</p> : null}
      {!loading && data?.available === false ? <p className="mt-3 text-xs text-slate-400">暂无游客数据（分析库不可用）</p> : null}
      {!loading && data?.available && !filteredGuests.length ? <p className="mt-3 text-xs text-slate-400">{guests.length ? '暂无匹配游客。' : '暂无游客访问记录。'}</p> : null}
      <PeoplePagination page={currentPage} pageCount={pageCount} disabled={loading} onPageChange={setPage}>
        {query.trim() ? `筛选 ${filteredGuests.length} / ${guests.length} 位游客` : `共 ${guests.length} 位游客`}{guests.length >= PEOPLE_LIMIT ? `（按最近活跃排序，取前 ${PEOPLE_LIMIT}）` : ''}
      </PeoplePagination>
    </Panel>
  );
}
