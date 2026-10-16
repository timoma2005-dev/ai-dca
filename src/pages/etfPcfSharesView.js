/**
 * 「份额新增」面板纯展示函数层：格式化、筛选、排序、状态映射与口径锚点。
 * 业务语义全部来自 src/app/etfPcfSharesClient.js 的既有辅助函数，此处不做任何口径改写。
 */
import { creationLabel, sharesCeiling, sharesPeriodDates } from '../app/etfPcfSharesClient.js';

const zh = (n, options) => n.toLocaleString('zh-CN', options);

export const formatInt = (n) => (Number.isFinite(n) ? zh(n, { maximumFractionDigits: 0 }) : '—');

// 份额增量：万份 + 千分位；零显示「0 份」；缺失显示「—」。
export function formatDeltaShares(n) {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0 份';
  return `${zh(n / 10000, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 万份`;
}

// 移动卡片用的紧凑份额规模：亿份 / 万份 / 份。
export function formatSharesCompact(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e8) return `${zh(n / 1e8, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿份`;
  if (n >= 1e4) return `${zh(n / 1e4, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 万份`;
  return `${zh(n)} 份`;
}

// 统计卡片合计净新增（万份，正数带 +）。
export function formatNetSumWan(n) {
  if (!Number.isFinite(n)) return '—';
  const text = zh(n / 10000, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n > 0 ? '+' : ''}${text}`;
}

// 盘前净新增：复用 creationLabel（估算保留「约」，负值/缺失维持「暂无」语义）。
export function formatCreationCell(r) {
  const valid =
    (r.creationSharesKind === 'exact' || r.creationSharesKind === 'estimate') &&
    Number.isFinite(r.creationShares) &&
    r.creationShares >= 0;
  if (!valid) return { text: '暂无', kind: null, tone: 'muted' };
  return {
    text: `${creationLabel(r)} 万`,
    kind: r.creationSharesKind,
    tone: r.creationShares > 0 ? 'pos' : 'zero'
  };
}

// 累计申购上限：有限显示万/亿份，无限「累计不限」，未知「—」。
export function limitText(r) {
  if (r.totalLimitKind === 'unlimited') return '累计不限';
  if (r.totalLimitKind === 'limited' && Number.isFinite(r.totalLimitShares)) {
    const v = r.totalLimitShares;
    if (v >= 1e8) return `${zh(v / 1e8, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿份`;
    return `${zh(v / 1e4, { maximumFractionDigits: 2 })} 万份`;
  }
  return '—';
}

// 既有「顶格 / 接近」判定：精确顶格或达到上限 90% 以上（未超限）。
export const isCappedOrNear = (r) => Boolean(r.atLimit || (r.nearTotalLimit && r.utilization <= 1));

// 顶格状态：直接采用 sharesCeiling 的 kind/label，由 CSS 按 kind 映射颜色。
export function ceilingMeta(r) {
  const { kind, label } = sharesCeiling(r);
  return { kind, label };
}

// 本地搜索：代码 / 名称匹配（大小写不敏感）。
export const matchesSearch = (r, query) => {
  const q = String(query || '').trim().toLowerCase();
  return !q || `${r.code} ${r.name}`.toLowerCase().includes(q);
};

// 列头排序：缺失值一律置底，同值按代码升序稳定排序。
export function sortRecords(list, sort) {
  if (!sort?.key) return list;
  const dir = sort.dir === 'asc' ? 1 : -1;
  const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return [...list].sort((a, b) => {
    if (sort.key === 'code') return byCode(a, b) * dir;
    const av = a[sort.key];
    const bv = b[sort.key];
    const aMissing = !Number.isFinite(av);
    const bMissing = !Number.isFinite(bv);
    if (aMissing || bMissing) {
      if (aMissing && bMissing) return byCode(a, b);
      return aMissing ? 1 : -1;
    }
    if (av === bv) return byCode(a, b);
    return (av < bv ? -1 : 1) * dir;
  });
}

const shortDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : '—');

// 累计上限口径锚点：各行限额日期一致时显示日期，多只不同则提示见各行。
export function limitAnchorText(records) {
  const dates = new Set(records.filter((r) => r.limitDate).map((r) => r.limitDate));
  if (!dates.size) return '—';
  if (dates.size > 1) return '日期不一，见各行';
  return `PCF 限额 (${shortDate(dates.values().next().value)})`;
}

// 副标题数据口径 Pills：日期锚点经 sharesPeriodDates 校验，PCF 对齐时按 T/P 日表述。
export function pillRows(data, records) {
  if (!data) return [];
  const period = sharesPeriodDates(data);
  const aligned = period.basis === 'PCF' && period.previousDate === data.date;
  return [
    { key: 'limit', label: '累计申购上限', value: limitAnchorText(records) },
    {
      key: 'creation',
      label: '盘前净新增',
      value: `${aligned ? '上一交易日 PCF 推导' : '报表推导'} (${shortDate(data.date)})`
    },
    {
      key: 'current',
      label: '本期总份额',
      value: `${aligned ? '上一交易日快照' : '统计日快照'} (${shortDate(data.date)})`
    },
    {
      key: 'previous',
      label: '上期总份额',
      value: `${aligned ? '上上交易日快照' : '上一统计日快照'} (${shortDate(data.prevDate)})`
    }
  ];
}

// 申购上限使用率进度条：宽度 clamp 0-100%，文字保留真实百分比；负值显示净减少；未知/无限不画。
export function progressMeta(r) {
  if (r.totalLimitKind !== 'limited' || !Number.isFinite(r.utilization)) {
    return { drawable: false, width: 0, text: '', tone: '' };
  }
  const percent = r.utilization * 100;
  if (r.utilization < 0) return { drawable: true, width: 0, text: '净减少', tone: 'neg' };
  return {
    drawable: true,
    width: Math.min(percent, 100),
    text: `${Math.round(percent)}%`,
    tone: percent >= 95 ? 'hot' : percent >= 50 ? 'mid' : 'cool'
  };
}

// 顶部统计卡片：合计净新增为有效深市样本的 deltaShares 汇总。
export function summaryStats(records) {
  const szRecords = records.filter((r) => r.code.startsWith('159'));
  const verified = szRecords.filter((r) => Number.isFinite(r.deltaShares));
  const cappedCount = records.filter(isCappedOrNear).length;
  const atLimitCount = records.filter((r) => r.atLimit === true).length;
  return {
    total: records.length,
    szCount: szRecords.length,
    shCount: records.length - szRecords.length,
    cappedCount,
    atLimitCount,
    nearCount: cappedCount - atLimitCount,
    netSum: verified.length ? verified.reduce((sum, r) => sum + r.deltaShares, 0) : null,
    verifiedCount: verified.length,
    inflowCount: verified.filter((r) => r.deltaShares > 0).length
  };
}
