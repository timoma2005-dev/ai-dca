// 行情表缺失值处理（审计 batch2 #5）：
// - null / '' / undefined / 非有限数一律视为缺失，不能被 Number(null) 变成 0 显示成 0.00；
// - 场外基金显示最新净值与净值日期，缺失时显示「—」并标注净值日更；
// - 排序时缺失值不论升降序都排在最后。
import { formatMarketPrice, formatTurnover } from './marketDisplayUtils.js';

export const MISSING_TEXT = '—';

export function toNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isOtcFundRow(row) {
  if (!row || typeof row !== 'object') return false;
  const kind = String(row.fundKind || row.kind || row.fundVenue || '').toLowerCase();
  if (kind === 'otc') return true;
  if (String(row.assetType || '').toLowerCase() === 'otc_fund') return true;
  if (String(row.valueType || '').toLowerCase() === 'nav') return true;
  return /^jj\d{6}$/i.test(String(row.symbol || '').trim());
}

function formatNavDate(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(text);
  return match ? { short: `${match[2]}-${match[3]}`, full: `${match[1]}-${match[2]}-${match[3]}` } : null;
}

// 场外基金价格列取值：优先 latestNav（净值），其次 price；<=0 视为缺失。
export function resolveMarketPriceValue(row) {
  if (!row) return null;
  const candidates = isOtcFundRow(row)
    ? [row.latestNav, row.price, row.nav]
    : [row.price];
  for (const candidate of candidates) {
    const n = toNumberOrNull(candidate);
    if (n != null && n > 0) return n;
  }
  return null;
}

export function resolveMarketPriceDisplay(row, format = formatMarketPrice) {
  const value = resolveMarketPriceValue(row);
  if (isOtcFundRow(row)) {
    const date = formatNavDate(row?.latestNavDate || row?.navDate);
    if (value == null) {
      return { text: MISSING_TEXT, note: '净值日更', title: '暂无净值（场外基金净值每日更新一次）', missing: true };
    }
    return {
      text: format(value, row),
      note: date ? `净值 ${date.short}` : '净值',
      title: date ? `最新净值（${date.full}），场外基金净值每日更新` : '最新净值，场外基金净值每日更新',
      missing: false,
    };
  }
  if (value == null) return { text: MISSING_TEXT, note: '暂无', title: '暂无行情数据', missing: true };
  return { text: format(value, row), note: '', title: '', missing: false };
}

export function resolveTurnoverDisplay(row) {
  const raw = row?.turnover ?? row?.amount;
  const value = toNumberOrNull(raw);
  if (isOtcFundRow(row) && (value == null || value <= 0)) {
    return { text: MISSING_TEXT, title: '场外基金无成交额（按净值申赎）', missing: true };
  }
  if (value == null || value < 0) return { text: MISSING_TEXT, title: '暂无成交额', missing: true };
  return { text: formatTurnover(value), title: '', missing: false };
}

// 数值比较：缺失值在升序和降序下都排最后。
// TanStack 会在 desc 时把 sortingFn 结果取反，所以缺失分支要预先按方向反向。
export function compareMissingLast(a, b, desc = false) {
  const aN = toNumberOrNull(a);
  const bN = toNumberOrNull(b);
  if (aN == null && bN == null) return 0;
  if (aN == null) return desc ? -1 : 1;
  if (bN == null) return desc ? 1 : -1;
  return aN - bN;
}

// getDesc(columnId) 返回当前列是否降序（读取表格最新 sorting 状态）。
export function createMissingLastNumericSort(getDesc) {
  return (rowA, rowB, columnId) => compareMissingLast(
    rowA.getValue(columnId),
    rowB.getValue(columnId),
    Boolean(typeof getDesc === 'function' ? getDesc(columnId) : false)
  );
}
