// 图表文本替代（审计 batch2 #21）：根据数据生成 aria-label 摘要（标的、区间、最新值、涨跌）。
function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function defaultFormat(value, digits) {
  return value.toFixed(digits);
}

function formatDateLabel(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms + 8 * 3600 * 1000);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

// points: 任意对象数组或数字数组；getValue/getDate 取值；unit: '' | '%'；
// changeMode: 'relative'（价格类，算区间涨跌幅）| 'difference'（收益率类，算区间变化百分点）。
export function summarizeSeries({
  title = '',
  subject = '',
  points = [],
  getValue = (point) => point,
  getDate = () => '',
  unit = '',
  digits = 2,
  format = defaultFormat,
  changeMode = 'relative',
} = {}) {
  const rows = (Array.isArray(points) ? points : [])
    .map((point) => ({ value: finite(getValue(point)), date: formatDateLabel(getDate(point)) }))
    .filter((row) => row.value != null);
  const head = [title, subject].filter(Boolean).join('：');
  if (!rows.length) return { label: `${head || '图表'}，暂无数据`, details: [] };
  const first = rows[0];
  const last = rows[rows.length - 1];
  const values = rows.map((row) => row.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const fmt = (value) => `${format(value, digits)}${unit}`;
  const parts = [];
  if (first.date && last.date) parts.push(`区间 ${first.date} 至 ${last.date}`);
  parts.push(`最新 ${fmt(last.value)}`);
  if (rows.length >= 2) {
    if (changeMode === 'difference') {
      const diff = last.value - first.value;
      parts.push(`区间变化 ${diff > 0 ? '+' : ''}${format(diff, digits)}${unit === '%' ? ' 个百分点' : unit}`);
    } else if (first.value !== 0) {
      const pct = ((last.value / first.value) - 1) * 100;
      parts.push(`区间涨跌 ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`);
    }
  }
  const details = [`最高 ${fmt(max)}`, `最低 ${fmt(min)}`, `共 ${rows.length} 个数据点`];
  return { label: `${head || '图表'}，${parts.join('，')}`, details };
}

export function chartA11yProps(summary) {
  return { role: 'img', 'aria-label': summary?.label || '图表' };
}

// 多曲线图：每条曲线给出最新值与区间涨跌/变化，aria-label 只放各曲线最新值，细节放视觉隐藏摘要。
export function summarizeMultiSeries({ title = '', lines = [], getLabel = (line) => line.label, getPoints = (line) => line.points, ...options } = {}) {
  const items = (Array.isArray(lines) ? lines : [])
    .map((line) => ({ name: String(getLabel(line) || '').trim(), summary: summarizeSeries({ ...options, subject: '', title: '', points: getPoints(line) }) }))
    .filter((item) => item.name && !item.summary.label.endsWith('暂无数据'));
  if (!items.length) return { label: `${title || '图表'}，暂无数据`, details: [] };
  const latest = items.map((item) => `${item.name} ${item.summary.label.replace(/^图表，/, '').replace(/^区间 [^，]+，/, '').split('，')[0].replace(/^最新 /, '')}`);
  return {
    label: `${title || '图表'}，${items.length} 条曲线，最新：${latest.join('；')}`,
    details: items.map((item) => `${item.name}：${item.summary.label.replace(/^图表，/, '')}，${item.summary.details.join('，')}`),
  };
}
