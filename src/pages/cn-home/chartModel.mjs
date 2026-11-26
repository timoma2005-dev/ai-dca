// Pure chart math for the cn-home PremiumChart (src/pages/cn-home/PremiumChart.jsx).
// No JSX and no React here, so node tests can import this module directly.
export const PALETTE = ['#1468f3', '#e5484d', '#0aa870', '#f08c2e', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#dc6b19', '#4f46e5', '#0f766e', '#be123c', '#9333ea', '#0284c7', '#ca8a04', '#16a34a'];

export function lineKey(line, index) {
  return String(line?.key ?? line?.code ?? index);
}

export function isLofLine(line) {
  const code = String(line?.code || line?.key || '');
  const name = String(line?.name || line?.label || '');
  return /^16/.test(code) || /LOF|联接/i.test(name);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Defensive: server shapes vary (value / premiumPercent / pr for premium mode,
// price / p for price mode).
export function valueOfPoint(point, mode) {
  if (!point) return null;
  if (mode === 'premium') return finiteNumber(point.value ?? point.pr ?? point.premiumPercent);
  return finiteNumber(point.value ?? point.p ?? point.price);
}

// Defensive: tooltip time fields vary across server shapes.
export function pointTime(point) {
  if (!point) return '';
  const raw = String(point.t ?? point.time ?? point.label ?? point.timestamp ?? '');
  // ISO 时间（2026-10-30T09:30:00+08:00）只显示 HH:MM；日期（日收盘）原样
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/);
  return iso ? iso[1] : raw;
}

// 坐标轴取整刻度：步长取 1/2/2.5/5×10^k，刻度覆盖 [min, max]。
export function niceTicks(min, max, count = 5) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ticks: [0, 1], step: 1 };
  if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
  const raw = (hi - lo) / Math.max(count - 1, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw * 0.999);
  const start = Math.floor(lo / step + 1e-9);
  const end = Math.ceil(hi / step - 1e-9);
  const ticks = [];
  for (let i = start; i <= end; i += 1) ticks.push(Number((i * step).toFixed(10)));
  return { ticks, step };
}

export function tickDecimals(step) {
  let d = 0;
  while (d < 4 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-6) d += 1;
  return d;
}

function niceDomain(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.04, 0.05);
  const { ticks, step } = niceTicks(min - pad, max + pad);
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks, step };
}

// 连续 minLen 个点数值完全不变 = 价格未更新（停牌或无成交），返回实线/虚线分段（端点共享）。
export function staleSegments(points, minLen = 6) {
  const list = Array.isArray(points) ? points : [];
  const runs = [];
  let s = 0;
  for (let i = 1; i <= list.length; i += 1) {
    if (i < list.length && Math.abs(list[i].value - list[s].value) < 1e-9) continue;
    if (i - s >= minLen) runs.push([s, i - 1]);
    s = i;
  }
  const segs = [];
  let cur = 0;
  for (const [a, b] of runs) {
    if (a > cur) segs.push({ from: cur, to: a, stale: false });
    segs.push({ from: a, to: b, stale: true });
    cur = b;
  }
  if (list.length && (cur < list.length - 1 || !segs.length)) segs.push({ from: cur, to: list.length - 1, stale: false });
  return segs;
}

const INTRADAY_TICKS = ['09:30', '10:30', '11:30', '14:00', '15:00'];
const INTRADAY_TICKS_NARROW = ['09:30', '11:30', '15:00'];

// 分时图按整点刻度（午休压缩，11:30 即 13:00），日线按等分。返回 [{ idx, label }]。
export function timeTickIndices(points, { narrow = false, daily = false } = {}) {
  const list = Array.isArray(points) ? points : [];
  if (!list.length) return [];
  if (!daily && list.every((p) => /^\d{2}:\d{2}$/.test(String(p.t)))) {
    const out = [];
    for (const label of narrow ? INTRADAY_TICKS_NARROW : INTRADAY_TICKS) {
      const idx = list.findIndex((p) => p.t >= label);
      if (idx >= 0 && !out.some((x) => x.idx === idx)) out.push({ idx, label });
    }
    if (out.length >= 2) return out;
  }
  const fractions = narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  return fractions
    .map((f) => (f === 1 ? list.length - 1 : Math.floor(list.length * f)))
    .filter((idx, pos, arr) => list[idx] && arr.indexOf(idx) === pos)
    .map((idx) => ({ idx, label: list[idx].t || '' }));
}

// Build the render model: normalized rows (hidden lines removed), value range,
// and the high/medium/low premium zones with spread gaps.
export function buildChartModel(series, mode, hiddenKeys = []) {
  const hidden = new Set(hiddenKeys || []);
  const rows = (Array.isArray(series) ? series : [])
    .map((line, index) => ({
      ...line,
      rowKey: lineKey(line, index),
      color: PALETTE[index % PALETTE.length],
      points: (line.points || [])
        .map((p) => ({ ...p, value: valueOfPoint(p, mode), t: pointTime(p) }))
        .filter((p) => p.value != null),
    }))
    .filter((x) => x.points.length && !hidden.has(x.rowKey));

  const values = rows.flatMap((x) => x.points.map((p) => p.value));
  if (!values.length) {
    return { rows, min: 0, max: 1, ticks: [0, 1], step: 1, length: 0, zones: [], gaps: [] };
  }
  const domain = niceDomain(values);
  const length = Math.max(...rows.map((x) => x.points.length));
  const zones = computeZones(rows, mode);
  const gaps = zones.length === 3 ? [
    { key: 'high-medium', label: '高 − 中', value: zones[0].value - zones[1].value },
    { key: 'medium-low', label: '中 − 低', value: zones[1].value - zones[2].value },
    { key: 'high-low', label: '高 − 低', value: zones[0].value - zones[2].value },
  ] : [];
  return { rows, ...domain, length, zones, gaps };
}

// High/medium/low premium zones: latest value per visible non-LOF line, split
// into thirds, median of each third. Premium mode only.
export function computeZones(rows, mode) {
  if (mode !== 'premium') return [];
  const latest = rows
    .map((line) => ({ line, value: line.points[line.points.length - 1].value }))
    .sort((a, b) => b.value - a.value)
    .filter(({ line }) => !isLofLine(line));
  if (latest.length < 3) return [];
  const first = Math.ceil(latest.length / 3);
  const second = Math.ceil((latest.length * 2) / 3);
  const buckets = [
    ['high', '高溢价区', latest.slice(0, first)],
    ['medium', '中溢价区', latest.slice(first, second)],
    ['low', '低溢价区', latest.slice(second)],
  ];
  return buckets.map(([key, label, items]) => {
    const sorted = items.map((item) => item.value).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { key, label, value, count: items.length, codes: items.map((item) => item.line.code).filter(Boolean) };
  });
}

// Collision-avoided end labels: top-down push-apart, then clamp the tail to the
// bottom, then bottom-up pull-back, then clamp the head to the top.
// (Ported from the previous MiniChart implementation, kept byte-for-byte logic.)
export function resolveEndLabels(rows, yFor, { top, bottom, minGapMax = 17 } = {}) {
  if (!rows.length) return [];
  const minGap = Math.min(minGapMax, (bottom - top) / Math.max(rows.length - 1, 1));
  const labels = rows
    .map((line, index) => {
      const point = line.points[line.points.length - 1];
      return { line, index, point, pointY: yFor(point.value), y: yFor(point.value) };
    })
    .sort((a, b) => a.y - b.y);
  labels.forEach((item, index) => {
    if (index) item.y = Math.max(item.y, labels[index - 1].y + minGap);
  });
  if (labels.length && labels[labels.length - 1].y > bottom) {
    const shift = labels[labels.length - 1].y - bottom;
    labels.forEach((item) => { item.y -= shift; });
  }
  for (let index = labels.length - 2; index >= 0; index -= 1) {
    labels[index].y = Math.min(labels[index].y, labels[index + 1].y - minGap);
  }
  if (labels.length && labels[0].y < top) {
    const shift = top - labels[0].y;
    labels.forEach((item) => { item.y += shift; });
  }
  return labels;
}

// Tooltip rows at a cursor index: value-ranked (premium) or series order (price).
export function tooltipRows(rows, cursor, mode) {
  return rows
    .map((line) => ({ line, p: line.points[Math.min(cursor ?? 0, line.points.length - 1)] }))
    .sort((a, b) => (mode === 'premium' ? (b.p?.value ?? -Infinity) - (a.p?.value ?? -Infinity) : 0));
}

// 缩放：取 [start, end] 索引窗口（含两端），纵轴按窗口内数据重算；分区/利差沿用全量（最新）口径。
export function sliceChartModel(model, start, end) {
  if (start == null || end == null || !model?.length) return model;
  const s = Math.max(0, Math.min(start, model.length - 1));
  const e = Math.max(s, Math.min(end, model.length - 1));
  if (s === 0 && e === model.length - 1) return model;
  const rows = model.rows
    .map((row) => ({ ...row, points: row.points.slice(s, e + 1) }))
    .filter((row) => row.points.length);
  const values = rows.flatMap((x) => x.points.map((p) => p.value));
  if (!values.length) return model;
  return { ...model, rows, ...niceDomain(values), length: e - s + 1, offset: s };
}

// 缩放窗口计算：factor<1 放大，>1 缩小；anchor 为锚点在窗口内的相对位置 0~1（锚点处的数据保持不动）。
export function zoomWindow(total, view, factor, anchor = 0.5, minSize = 8) {
  if (!total) return null;
  const s0 = view ? view[0] : 0;
  const e0 = view ? view[1] : total - 1;
  const w0 = e0 - s0 + 1;
  const floor = Math.min(minSize, total);
  const w = Math.max(floor, Math.min(total, Math.round(w0 * factor)));
  if (w >= total) return null;
  const a = Math.max(0, Math.min(1, anchor));
  const center = s0 + a * (w0 - 1);
  let s = Math.round(center - a * (w - 1));
  s = Math.max(0, Math.min(total - w, s));
  return [s, s + w - 1];
}

export function panWindow(total, view, delta) {
  if (!view || !total) return view;
  const w = view[1] - view[0] + 1;
  const s = Math.max(0, Math.min(total - w, Math.round(view[0] + delta)));
  return [s, s + w - 1];
}

// 图例/读数用的短名：去 ETF，纳斯达克100/纳指100 → 纳指。
export function shortLineLabel(label) {
  return String(label || '').replace(/纳斯达克100|纳斯达克|纳指100/g, '纳指').replace(/ETF/g, '').trim();
}
