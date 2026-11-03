import { useEffect, useState } from 'react';

// 美股指数期货（东财 CME 连续合约）：纳指 NQ00Y、标普 ES00Y。东财接口允许本站跨域。
// 页面可见时每 60 秒刷新一次；隐藏时暂停。f2 价格需除以 10^f1，f3 为涨跌幅×100（相对上一结算价）。
export const INDEX_FUTURES = [
  { secid: '103.NQ00Y', key: 'NQ00Y', label: '纳指期货' },
  { secid: '103.ES00Y', key: 'ES00Y', label: '标普期货' },
];
const URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids='
  + INDEX_FUTURES.map((item) => item.secid).join(',') + '&fields=f1,f2,f3,f12,f124';
const REFRESH_MS = 60_000;

export function parseIndexFutures(payload) {
  const list = payload?.data?.diff;
  const rows = Array.isArray(list) ? list : Object.values(list || {});
  const out = {};
  rows.forEach((item) => {
    const key = String(item?.f12 || '');
    const scale = 10 ** (Number(item?.f1) || 0);
    const price = Number(item?.f2);
    const pct = Number(item?.f3);
    if (!key || !Number.isFinite(price) || price <= 0) return;
    out[key] = {
      price: price / scale,
      changePercent: Number.isFinite(pct) ? pct / 100 : null,
      time: Number(item?.f124) > 0 ? Number(item.f124) * 1000 : null,
    };
  });
  return out;
}

export function useIndexFutures(enabled = true) {
  const [state, setState] = useState({ data: {}, error: false });
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    let timer = null;
    let controller = null;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      fetch(URL, { cache: 'no-store', signal: controller.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('http'))))
        .then((payload) => {
          const data = parseIndexFutures(payload);
          setState((prev) => (Object.keys(data).length ? { data, error: false } : { ...prev, error: true }));
        })
        .catch((error) => { if (error?.name !== 'AbortError') setState((prev) => ({ ...prev, error: true })); });
    };
    load();
    timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
  return state;
}
