/**
 * 份额页单只基金「历史」数据（SVIP）：/api/etf-history/{code}.json。
 * - nginx auth_request 校验 api:etf-history（svip 及以上）；401 未登录、403 权限不足，均不返回数据。
 * - 由 services/etf-history/build_history.py 每日生成：rows[] = { d, sh, dsh, close, nav, prem, dprem,
 *   eff, effShares, src, tot, net, acctTot, acctNet, allow }，份额单位「份」，溢价单位 %。
 * - 内存缓存 10 分钟（按 code + 会话），不写 localStorage（付费数据不落盘）。
 */
import { apiUrl } from './apiBase.js';
import { loadCloudSession } from './authSession.js';

export const ETF_HISTORY_PERM = 'api:etf-history';
export const ETF_HISTORY_TTL_MS = 10 * 60 * 1000;
export const HISTORY_RANGES = [
  ['1m', '1月', 22],
  ['3m', '3月', 66],
  ['6m', '6月', 130],
  ['1y', '1年', Infinity]
];

export function canViewEtfHistory(rbac) {
  if (!rbac?.loggedIn) return false;
  return Boolean(rbac.isAdmin) || (Array.isArray(rbac.perms) && rbac.perms.includes(ETF_HISTORY_PERM));
}

const isCode = (code) => /^\d{6}$/.test(String(code || ''));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 校验并规范化接口返回；结构不对返回 null。 */
export function normalizeEtfHistory(payload, code) {
  if (!payload || typeof payload !== 'object' || payload.code !== code || !Array.isArray(payload.rows)) return null;
  const rows = [];
  for (const r of payload.rows) {
    if (!r || typeof r.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.d)) continue;
    rows.push({
      d: r.d,
      sh: num(r.sh),
      dsh: num(r.dsh),
      close: num(r.close),
      nav: num(r.nav),
      prem: num(r.prem),
      dprem: num(r.dprem),
      eff: r.eff === 'limited' || r.eff === 'unlimited' ? r.eff : null,
      effShares: num(r.effShares),
      src: r.src === 'net' ? 'net' : 'total',
      allow: typeof r.allow === 'boolean' ? r.allow : null
    });
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return {
    code,
    name: String(payload.name || code),
    market: payload.market === 'SSE' ? 'SSE' : 'SZSE',
    generatedAt: payload.generatedAt || null,
    rows
  };
}

/** 生效申购上限的比较值：unlimited 视为无穷大，未知为 null。 */
export function limitValue(r) {
  if (!r) return null;
  if (r.eff === 'unlimited') return Infinity;
  if (r.eff === 'limited' && r.effShares !== null) return r.effShares;
  return null;
}

/** 相邻交易日生效上限的变化：tightened / relaxed；两侧有一侧未知不计。 */
export function limitEvents(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const a = limitValue(rows[i - 1]),
      b = limitValue(rows[i]);
    if (a === null || b === null || a === b) continue;
    out.push({ d: rows[i].d, index: i, from: a, to: b, kind: b < a ? 'tightened' : 'relaxed' });
  }
  return out;
}

export function sliceRange(rows, range) {
  const spec = HISTORY_RANGES.find(([k]) => k === range) || HISTORY_RANGES[2];
  return Number.isFinite(spec[2]) ? rows.slice(-spec[2]) : rows.slice();
}

export function summarizeHistory(rows) {
  const withSh = rows.filter((r) => r.sh !== null);
  const last = [...rows].reverse().find((r) => r.prem !== null) || null;
  const events = limitEvents(rows);
  return {
    sharesChange: withSh.length >= 2 ? withSh[withSh.length - 1].sh - withSh[0].sh : null,
    premium: last ? last.prem : null,
    premiumDate: last ? last.d : null,
    tightened: events.filter((e) => e.kind === 'tightened').length,
    relaxed: events.filter((e) => e.kind === 'relaxed').length
  };
}

export function fmtShares(v, { sign = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = sign && v > 0 ? '+' : '';
  const a = Math.abs(v);
  if (a >= 1e8) return `${s}${(v / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${s}${Math.round(v / 1e4).toLocaleString('zh-CN')}万`;
  return `${s}${Math.round(v).toLocaleString('zh-CN')}`;
}

export function fmtLimit(v) {
  if (v === Infinity) return '不限';
  if (v === null || v === undefined) return '—';
  return `${fmtShares(v)}份`;
}

export function fmtPct(v, { sign = false, digits = 2 } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${sign && v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function historyToCsv(rows, { code = '', name = '' } = {}) {
  const head = ['日期', '代码', '名称', '总份额(份)', '新增(份)', '生效申购上限(份)', '上限口径', '允许申购', '收盘价', '单位净值', '溢价率(%)', '溢价变化(百分点)'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const lim = limitValue(r);
    lines.push([
      r.d, code, name, r.sh, r.dsh, lim === Infinity ? '不限' : lim, r.src === 'net' ? '净申购' : '累计申购',
      r.allow === null ? '' : r.allow ? '是' : '否', r.close, r.nav, r.prem, r.dprem
    ].map(csvCell).join(','));
  }
  return '\ufeff' + lines.join('\n');
}

export function createEtfHistoryClient({
  fetchImpl = (...args) => fetch(...args),
  session = () => loadCloudSession(),
  now = () => Date.now()
} = {}) {
  const memory = new Map();
  const inflight = new Map();
  function load(code, { refresh = false } = {}) {
    if (!isCode(code)) return Promise.resolve({ state: 'error', reason: 'invalid_code' });
    const s = session();
    const key = `${s?.userId || s?.username || 'guest'}:${code}`;
    const hit = memory.get(key);
    if (!refresh && hit && now() - hit.at < ETF_HISTORY_TTL_MS) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const headers = { Accept: 'application/json' };
    if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;
    const p = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetchImpl(apiUrl(`/api/etf-history/${code}.json`), {
          method: 'GET',
          headers,
          credentials: 'same-origin',
          redirect: 'manual',
          signal: controller.signal
        });
        if (res.status === 401) return { state: 'login' };
        if (res.status === 403) return { state: 'locked' };
        if (res.status === 404) return { state: 'empty' };
        if (!res.ok) return { state: 'error', reason: `http_${res.status}` };
        const data = normalizeEtfHistory(await res.json(), code);
        if (!data) return { state: 'error', reason: 'invalid_payload' };
        const value = data.rows.length ? { state: 'ready', data } : { state: 'empty' };
        memory.set(key, { at: now(), value });
        return value;
      } catch (e) {
        return { state: 'error', reason: e?.name === 'AbortError' ? 'timeout' : 'network' };
      } finally {
        clearTimeout(timer);
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }
  return { load, clear: () => memory.clear() };
}

export const etfHistoryClient = createEtfHistoryClient();
