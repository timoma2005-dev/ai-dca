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
  return String(point.t ?? point.time ?? point.label ?? point.timestamp ?? '');
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
    return { rows, min: 0, max: 1, length: 0, zones: [], gaps: [] };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.12, 0.1);
  const length = Math.max(...rows.map((x) => x.points.length));
  const zones = computeZones(rows, mode);
  const gaps = zones.length === 3 ? [
    { key: 'high-medium', label: '高 − 中', value: zones[0].value - zones[1].value },
    { key: 'medium-low', label: '中 − 低', value: zones[1].value - zones[2].value },
    { key: 'high-low', label: '高 − 低', value: zones[0].value - zones[2].value },
  ] : [];
  return { rows, min: min - pad, max: max + pad, length, zones, gaps };
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
