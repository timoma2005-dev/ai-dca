// 复杂图表的视觉隐藏数据摘要（与容器上的 role="img" + aria-label 搭配使用）。
export function ChartSrSummary({ summary }) {
  if (!summary?.label) return null;
  return <p className="sr-only">{summary.label}{summary.details?.length ? `。${summary.details.join('，')}。` : '。'}</p>;
}
