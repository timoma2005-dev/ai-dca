import { useEffect, useState } from 'react';
import { apiUrl } from '../../app/apiBase.js';
import { normalizeFundLimitEntries, readCachedFundLimits, writeCachedFundLimits } from './marketsWatchData.js';

// 详情页单只基金的申购状态（LOF 申购套利估算用）。只在选中标的且 enabled 时请求一次，复用列表的 fund-limit 本地缓存。
export function useDetailFundLimit(code, enabled) {
  const [state, setState] = useState({ code: '', data: null });
  useEffect(() => {
    if (!enabled || !/^[0-9]{6}$/.test(String(code || ''))) return undefined;
    const cached = readCachedFundLimits([code]);
    if (cached.dataByCode[code]) {
      setState({ code, data: cached.dataByCode[code] });
      return undefined;
    }
    const controller = new AbortController();
    fetch(apiUrl('/api/fund-limit', { code }), { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const next = normalizeFundLimitEntries([{ ok: true, code, data: await response.json() }]);
        if (!next[code]) return;
        writeCachedFundLimits(next);
        setState({ code, data: next[code] });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [code, enabled]);
  return state.code === code ? state.data : null;
}
