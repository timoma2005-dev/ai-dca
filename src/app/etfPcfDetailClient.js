import { apiUrl } from './apiBase.js';

export function createPcfDetailClient({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const memory = new Map();
  const inflight = new Map();
  function subscribe(code, date) {
    const key = `${code}:${date}`;
    const cached = memory.get(key);
    if (cached && cached.until > now()) return { promise: Promise.resolve(cached.result), release() {} };
    let task = inflight.get(key);
    if (task?.controller.signal.aborted) task = null;
    if (!task) {
      const controller = new AbortController();
      task = { controller, consumers: 0 };
      const timer = setTimeout(() => controller.abort(), 8000);
      task.promise = (async () => {
        try {
          const response = await fetchImpl(apiUrl('/api/etf-pcf-limit', { code, date }), {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            signal: controller.signal
          });
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            await response.body?.cancel();
            throw Error('redirect');
          }
          const data = await response.json();
          if (controller.signal.aborted) throw Error('aborted');
          if (response.status === 404 && data.reason === 'cache_miss') return { state: 'empty' };
          if (
            !response.ok ||
            data.code !== code ||
            data.date !== date ||
            data.source !== (code.startsWith('159') ? 'szse_pcf' : 'sse_pcf')
          )
            throw Error('invalid_data');
          const result = { state: 'ready', data };
          // Never extend a server expiry; historical data has a short local lifetime.
          const until = Math.min(now() + 300000, data.expiresAt ? Date.parse(data.expiresAt) : Infinity);
          if (Number.isFinite(until) && until > now()) memory.set(key, { until, result });
          return result;
        } catch {
          return { state: 'error' };
        } finally {
          clearTimeout(timer);
          if (inflight.get(key) === task) inflight.delete(key);
        }
      })();
      inflight.set(key, task);
    }
    task.consumers++;
    let released = false;
    return {
      promise: task.promise,
      release() {
        if (released) return;
        released = true;
        task.consumers--;
        // Allow React's immediate effect remount to reuse the same request.
        setTimeout(() => {
          if (!task.consumers && inflight.get(key) === task) task.controller.abort();
        }, 0);
      }
    };
  }
  return { subscribe };
}
export const pcfDetailClient = createPcfDetailClient();

const money = (n) => (Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 8 }) : '—');
export function formatPcfShares(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿份`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万份`;
  return `${Math.round(n)}份`;
}
export function pcfDetailSections(p) {
  const sse = p.source === 'sse_pcf';
  const allowed = (value) =>
    typeof value === 'boolean' ? (value ? '允许' : '不允许') : sse ? p.creationRedemption || '—' : '—';
  const limit = (value, empty) => (value === null ? empty : formatPcfShares(value));
  // 单账户限额（SSE/SZSE PCF 新增字段）：逐项独立判断，prefix+Kind/Shares 均缺失时不加行；
  // Shares null 或 kind unlimited 记「不设上限」，有限数字（含 0）走 formatPcfShares，其余记「—」。
  const accountLimit = (prefix) => {
    const shares = p[`${prefix}Shares`];
    const kind = p[`${prefix}Kind`];
    if (shares === undefined && kind === undefined) return null;
    if (shares === null || kind === 'unlimited') return '不设上限';
    return Number.isFinite(shares) ? formatPcfShares(shares) : '—';
  };
  const accountLimitRows = [
    ['accountTotalSubscribeLimit', '单账户累计申购上限'],
    ['accountTotalRedeemLimit', '单账户累计赎回上限'],
    ['accountNetSubscribeLimit', '单账户净申购上限'],
    ['accountNetRedeemLimit', '单账户净赎回上限']
  ].flatMap(([prefix, label]) => {
    const value = accountLimit(prefix);
    return value === null ? [] : [[label, value]];
  });
  return [
    {
      date: p.prevDayDate || '—',
      rows: [
        ['最小申购、赎回单位的现金差额（元）', money(p.prevDayCashDifference)],
        ['最小申购、赎回单位净值（元）', money(sse ? p.navPerCreationUnit : p.prevDayUnitNav)],
        ['基金份额净值（元）', money(sse ? p.nav : p.prevDayNav)]
      ]
    },
    {
      date: p.date || '—',
      rows: [
        ['预估现金部分（元）', money(p.estimatedCashDifference)],
        [
          '现金替代比例上限',
          Number.isFinite(p.cashSubstitutionRatioLimitPct) ? `${p.cashSubstitutionRatioLimitPct}%` : '—'
        ],
        ['是否需要公布IOPV', typeof p.iopvRequired === 'boolean' ? (p.iopvRequired ? '是' : '否') : '—'],
        [
          '最小申购、赎回单位',
          Number.isFinite(p.creationRedemptionUnitShares) && p.creationRedemptionUnitShares >= 1e4
            ? `${(p.creationRedemptionUnitShares / 1e4).toFixed(2)}万份`
            : formatPcfShares(p.creationRedemptionUnitShares)
        ],
        ['申购的允许情况', allowed(p.subscriptionAllowed)],
        ['赎回的允许情况', allowed(p.redemptionAllowed)],
        ['当日累计申购上限', limit(p.totalSubscribeLimitShares, '无')],
        ['当日累计赎回上限', limit(p.totalRedeemLimitShares, '无')],
        ['当日净申购上限', limit(p.netSubscribeLimitShares, '不设上限')],
        ['当日净赎回上限', limit(p.netRedeemLimitShares, '不设上限')],
        ...accountLimitRows
      ]
    }
  ];
}
