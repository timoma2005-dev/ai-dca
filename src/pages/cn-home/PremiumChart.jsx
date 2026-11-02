import { useEffect, useMemo, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import {
  PALETTE,
  buildChartModel,
  lineKey,
  panWindow,
  resolveEndLabels,
  shortLineLabel,
  sliceChartModel,
  tooltipRows,
  zoomWindow,
} from './chartModel.mjs';
import { summarizeMultiSeries } from '../../lib/chartA11y.js';
import { ChartSrSummary } from '../../components/ChartA11y.jsx';

// viewBox matches the reference home.html chart geometry.
const W = 800;
const H = 380;
const PAD_L = 55;
const PAD_R = 130;
const PAD_T = 20;
const PAD_B = 35;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
const LABEL_X = PAD_L + PLOT_W;

// D2: gapHighLow >= 3 shows the stronger strategy wording.
const STRATEGY_THRESHOLD = 3;

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
}
function fmtValue(value, mode) {
  if (mode === 'premium') return fmtPct(value);
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}
function lineLabel(line) {
  return String(line.label || line.name || line.code || '');
}

function strategyText(gapHighLow) {
  const gap = fmtPct(gapHighLow);
  if (gapHighLow != null && gapHighLow >= STRATEGY_THRESHOLD) {
    return `当前高-低利差达 ${gap}，持有高溢价 ETF 的投资者可通过换基至低溢价同标的或场外申购底仓平抑溢价成本。`;
  }
  return `当前高-低利差为 ${gap}，处于温和区间，换基收益空间有限，可保持现有组合并关注场外申购底仓。`;
}

export function ZonePanel({ zones, gaps, mode }) {
  if (mode !== 'premium' || !zones.length) return null;
  const gapHighLow = gaps.find((g) => g.key === 'high-low')?.value;
  return (
    <div className="cn-home-zone-panel">
      <div className="cn-home-zone-cards">
        {zones.map((zone) => (
          <div key={zone.key} className={`cn-home-zone-card is-${zone.key}`}>
            <span className="cn-home-zone-title">{zone.label} · {zone.count}只</span>
            <span className="cn-home-zone-val">{fmtPct(zone.value)}</span>
          </div>
        ))}
      </div>
      <div className="cn-home-gap-pills">
        <span className="cn-home-gap-label">换基梯度利差：</span>
        {gaps.map((gap) => (
          <span key={gap.key} className="cn-home-gap-pill">{gap.label}：<b>{fmtPct(gap.value)}</b></span>
        ))}
      </div>
      <div className="cn-home-strategy">
        <Info />
        <span><b>策略建议</b>：{strategyText(gapHighLow)}</span>
      </div>
      <small className="cn-home-zone-note">分区统计不含 LOF</small>
    </div>
  );
}

function useIsNarrow() {
  const query = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

const ZOOM_MIN_POINTS = 20;

export function PremiumChart({ series, mode, daily = false }) {
  const [cursor, setCursor] = useState(null);
  const [hiddenKeys, setHiddenKeys] = useState([]);
  // 缩放窗口 [start, end]（全量索引）；null = 全部。
  const [view, setView] = useState(null);
  const ref = useRef(null);
  const svgRef = useRef(null);
  const gesture = useRef(null);
  const narrow = useIsNarrow();

  const lines = Array.isArray(series) ? series : [];
  const fullModel = useMemo(() => buildChartModel(lines, mode, hiddenKeys), [lines, mode, hiddenKeys]);
  const total = fullModel.length;
  const model = useMemo(() => (view ? sliceChartModel(fullModel, view[0], view[1]) : fullModel), [fullModel, view]);
  const zoomable = total >= ZOOM_MIN_POINTS;

  // 换数据集（区间/分组/今日↔历史）时复位缩放。
  useEffect(() => { setView(null); setCursor(null); }, [total, daily]);

  const a11ySummary = useMemo(() => summarizeMultiSeries({
    title: daily ? (mode === 'premium' ? '场内日收盘溢价率走势' : '场内日收盘价走势') : (mode === 'premium' ? '场内分时溢价率走势' : '场内分时走势'),
    lines: model.rows,
    getLabel: (line) => lineLabel(line),
    getPoints: (line) => line.points,
    getValue: (point) => point.value,
    getDate: (point) => point.t,
    unit: mode === 'premium' ? '%' : '',
    changeMode: mode === 'premium' ? 'difference' : 'relative',
  }), [model.rows, mode]);

  const legendItems = useMemo(
    () => lines.map((line, index) => ({
      key: lineKey(line, index),
      color: PALETTE[index % PALETTE.length],
      label: lineLabel(line) || `#${index + 1}`,
    })),
    [lines],
  );

  function yFor(value) {
    return PAD_T + PLOT_H - ((value - model.min) / Math.max(model.max - model.min, 0.0001)) * PLOT_H;
  }
  function xFor(index) {
    return PAD_L + (index / Math.max(model.length - 1, 1)) * PLOT_W;
  }
  function pathD(points) {
    return points
      .map((p, i) => `${i ? 'L' : 'M'}${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)}`)
      .join(' ');
  }

  const endLabels = useMemo(
    () => resolveEndLabels(model.rows, yFor, { top: PAD_T + 6, bottom: H - PAD_B - 6, minGapMax: 13 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model],
  );

  const samplePts = useMemo(() => {
    const sample = model.rows.reduce(
      (best, row) => (row.points.length > (best?.points.length || 0) ? row : best),
      null,
    );
    return sample?.points || [];
  }, [model]);
  const timeIndices = useMemo(() => {
    if (!samplePts.length) return [];
    const ticks = narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
    return ticks.map((f) => (f === 1 ? samplePts.length - 1 : Math.floor(samplePts.length * f)))
      .filter((idx, pos, arr) => samplePts[idx] && arr.indexOf(idx) === pos);
  }, [samplePts, narrow]);

  function toggleLine(key) {
    setHiddenKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  // 客户端 x → 绘图区内相对位置 0~1。
  function fracAt(clientX) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0.5;
    const f = ((clientX - rect.left) / rect.width - PAD_L / W) / (PLOT_W / W);
    return Math.max(0, Math.min(1, f));
  }
  function cursorAt(clientX) {
    if (!model.length) return;
    setCursor(Math.max(0, Math.min(model.length - 1, Math.round(fracAt(clientX) * (model.length - 1)))));
  }
  function zoomBy(factor, anchor) {
    if (!zoomable) return;
    const a = anchor ?? (cursor != null && model.length > 1 ? cursor / (model.length - 1) : 0.5);
    setView((v) => zoomWindow(total, v, factor, a));
    setCursor(null);
  }

  // —— 鼠标：悬停十字线；按住拖动平移（已放大时）。
  function onMouseMove(event) {
    const g = gesture.current;
    if (g?.type === 'drag' && view && event.buttons === 1) {
      const w = g.view[1] - g.view[0] + 1;
      const dx = (event.clientX - g.x) / Math.max(1, svgRef.current?.getBoundingClientRect().width * (PLOT_W / W));
      setView(panWindow(total, g.view, -dx * (w - 1)));
      return;
    }
    cursorAt(event.clientX);
  }
  function onMouseDown(event) {
    if (view) gesture.current = { type: 'drag', x: event.clientX, view };
  }
  function onMouseUp() { gesture.current = null; }
  function leave() {
    gesture.current = null;
    setCursor(null);
  }

  // —— 触摸：单指读数（保留到下次触摸）；双指捏合缩放 + 平移。
  function touchInfo(touches) {
    const a = touches[0];
    const b = touches[1];
    return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), mid: (a.clientX + b.clientX) / 2 };
  }
  function onTouchStart(event) {
    if (event.touches.length >= 2) {
      if (!zoomable) return;
      const t = touchInfo(event.touches);
      const v = view || [0, total - 1];
      gesture.current = { type: 'pinch', dist: t.dist, view: v, anchorIdx: v[0] + fracAt(t.mid) * (v[1] - v[0]) };
      setCursor(null);
      return;
    }
    gesture.current = null;
    cursorAt(event.touches[0].clientX);
  }
  function onTouchMove(event) {
    const g = gesture.current;
    if (g?.type === 'pinch' && event.touches.length >= 2) {
      const t = touchInfo(event.touches);
      const w0 = g.view[1] - g.view[0] + 1;
      const w = Math.max(Math.min(8, total), Math.min(total, Math.round(w0 * (g.dist / Math.max(t.dist, 1)))));
      if (w >= total) { setView(null); return; }
      const f = fracAt(t.mid);
      let s = Math.round(g.anchorIdx - f * (w - 1));
      s = Math.max(0, Math.min(total - w, s));
      setView([s, s + w - 1]);
      return;
    }
    if (event.touches.length === 1 && !g) cursorAt(event.touches[0].clientX);
  }
  function onTouchEnd(event) {
    if (event.touches.length === 0) gesture.current = null;
  }

  // 桌面：Ctrl/⌘ + 滚轮、触控板捏合缩放（需非被动监听才能阻止页面缩放）。
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !zoomable) return undefined;
    function onWheel(event) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const f = fracAt(event.clientX);
      setView((v) => zoomWindow(total, v, event.deltaY > 0 ? 1.25 : 0.8, f));
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomable, total]);

  // 缩放条：拖动滑块平移窗口。
  function onThumbDown(event) {
    if (!view) return;
    const track = event.currentTarget.parentElement;
    const rect = track.getBoundingClientRect();
    const start = { x: event.clientX, view };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    function moveThumb(ev) {
      const delta = ((ev.clientX - start.x) / Math.max(rect.width, 1)) * total;
      setView(panWindow(total, start.view, delta));
    }
    function up() {
      window.removeEventListener('pointermove', moveThumb);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    window.addEventListener('pointermove', moveThumb);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  if (!model.rows.length) return <div className="cn-home-empty">{daily ? '暂无历史走势' : '暂无今日走势'}</div>;

  const readIdx = cursor ?? (narrow ? model.length - 1 : null);
  const tipRows = cursor != null ? tooltipRows(model.rows, cursor, mode) : [];
  const tipTime = tipRows.map((r) => r.p?.t).find(Boolean) || '';
  const cursorXPct = cursor != null ? (xFor(cursor) / W) * 100 : 0;
  const tipOnLeft = cursorXPct > 62;
  const metricLabel = daily ? (mode === 'premium' ? '收盘溢价率' : '收盘价') : (mode === 'premium' ? '实时溢价率' : '分时价格');
  // 图例读数：手机端常显（未触摸时为最新值），桌面悬停时显示。
  const readValues = new Map();
  if (readIdx != null) {
    for (const row of model.rows) readValues.set(row.rowKey, row.points[Math.min(readIdx, row.points.length - 1)]);
  }
  const readTime = readIdx != null ? (model.rows.map((r) => r.points[Math.min(readIdx, r.points.length - 1)]?.t).find(Boolean) || '') : '';
  // 手机读数按当前读数从高到低排（溢价模式）；隐藏的曲线排最后。
  const orderedLegend = narrow && mode === 'premium'
    ? [...legendItems].sort((x, y) => {
      const vx = hiddenKeys.includes(x.key) ? -Infinity : (readValues.get(x.key)?.value ?? -Infinity);
      const vy = hiddenKeys.includes(y.key) ? -Infinity : (readValues.get(y.key)?.value ?? -Infinity);
      return vy - vx;
    })
    : legendItems;
  const firstT = samplePts[0]?.t || '';
  const lastT = samplePts[samplePts.length - 1]?.t || '';

  return (
    <div className="cn-home-premium-wrap" ref={ref}>
      {zoomable ? (
        <div className="cn-home-zoom-bar">
          <span className="cn-home-zoom-range">{view ? `${firstT} ~ ${lastT}` : (narrow ? '双指可缩放' : 'Ctrl+滚轮可缩放')}</span>
          <div className="cn-home-zoom-btns" role="group" aria-label="图表缩放">
            <button type="button" onClick={() => zoomBy(1.6)} disabled={!view} aria-label="缩小" title="缩小">−</button>
            <button type="button" onClick={() => zoomBy(0.6)} disabled={model.length <= 8} aria-label="放大" title="放大">＋</button>
            {view ? <button type="button" className="is-reset" onClick={() => { setView(null); setCursor(null); }} aria-label="复位缩放">复位</button> : null}
          </div>
        </div>
      ) : null}
      <div
        className="cn-home-chart-stage"
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={leave}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onDoubleClick={() => zoomable && (view ? setView(null) : zoomBy(0.5))}
        style={view ? { cursor: 'grab' } : undefined}
      >
      <svg ref={svgRef} className="cn-home-premium-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={a11ySummary.label}>
        {[0, 1, 2, 3, 4].map((i) => {
          const y = PAD_T + (i / 4) * PLOT_H;
          const val = model.max - (i / 4) * (model.max - model.min);
          return (
            <g key={i}>
              <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} className="grid" />
              <text x={PAD_L - 8} y={y + 4} textAnchor="end" className="axis">
                {mode === 'premium' ? fmtPct(val) : Number(val).toFixed(2)}
              </text>
            </g>
          );
        })}
        {mode === 'premium' && model.min < 0 && model.max > 0 ? (
          <g>
            <line x1={PAD_L} y1={yFor(0)} x2={PAD_L + PLOT_W} y2={yFor(0)} className="grid zero" strokeDasharray="3 3" />
            {[0, 1, 2, 3, 4].every((i) => Math.abs(PAD_T + (i / 4) * PLOT_H - yFor(0)) > 14) ? <text x={PAD_L - 8} y={yFor(0) + 4} textAnchor="end" className="axis">0.00%</text> : null}
          </g>
        ) : null}
        {timeIndices.map((idx, pos) => (
          <text key={idx} x={xFor(idx)} y={H - 12} textAnchor={narrow ? (pos === 0 ? 'start' : (pos === timeIndices.length - 1 ? 'end' : 'middle')) : 'middle'} className="axis">{samplePts[idx]?.t || ''}</text>
        ))}
        {model.rows.map((line) => (
          <path key={line.rowKey} d={pathD(line.points)} className="cn-home-curve" style={{ stroke: line.color }} />
        ))}
        {cursor != null ? (
          <line x1={xFor(cursor)} y1={PAD_T} x2={xFor(cursor)} y2={PAD_T + PLOT_H} className="cross" />
        ) : null}
        {endLabels.map(({ line, index, pointY, y }) => {
          const latest = line.points[line.points.length - 1]?.value;
          return (
            <g key={`end-${line.rowKey}`}>
              <circle cx={LABEL_X} cy={pointY} r={2.5} fill={line.color} />
              <line x1={LABEL_X} y1={pointY} x2={LABEL_X + 8} y2={y} stroke={line.color} strokeWidth={1} opacity={0.6} />
              <text x={LABEL_X + 12} y={y + 3.5} className="end-label-text" fill={line.color}>
                {`${lineLabel(line).replace(/ETF/g, '')} ${fmtValue(latest, mode)}`}
              </text>
            </g>
          );
        })}
      </svg>
      {cursor != null && !narrow ? (
        <div
          className="cn-home-chart-tooltip"
          style={tipOnLeft
            ? { left: `${cursorXPct}%`, transform: 'translateX(calc(-100% - 16px))' }
            : { left: `${cursorXPct}%`, transform: 'translateX(16px)' }}
        >
          <div className="cn-home-tooltip-head"><span>{tipTime}</span><span>{daily ? (mode === 'premium' ? '收盘溢价率' : '收盘价') : (mode === 'premium' ? '实时溢价率' : '分时价格')}</span></div>
          <div className="cn-home-tooltip-list">
            {tipRows.map(({ line, p }) => (
              <div key={line.rowKey} className="cn-home-tooltip-row">
                <span className="cn-home-tooltip-left">
                  <span className="cn-home-tooltip-dot" style={{ background: line.color }} />
                  <span>{lineLabel(line)}</span>
                </span>
                <span className="cn-home-tooltip-val">{fmtValue(p?.value, mode)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      </div>
      {view ? (
        <div className="cn-home-zoom-track" aria-hidden="true">
          <span
            className="cn-home-zoom-thumb"
            style={{ left: `${(view[0] / total) * 100}%`, width: `${((view[1] - view[0] + 1) / total) * 100}%` }}
            onPointerDown={onThumbDown}
          />
        </div>
      ) : null}
      <ChartSrSummary summary={a11ySummary} />
      {legendItems.length ? (
        <>
          {narrow && readTime ? <div className="cn-home-read-head"><span>{readTime}</span><span>{metricLabel}{cursor == null && !view ? ' · 最新' : ''}</span></div> : null}
          <div className={`cn-home-chart-legend${narrow ? ' is-readout' : ''}`} role="group" aria-label="曲线图例，点击切换显示">
            {orderedLegend.map((item) => {
              const hidden = hiddenKeys.includes(item.key);
              const point = readValues.get(item.key);
              return (
                <button
                  type="button"
                  key={item.key}
                  className={`cn-home-legend-chip${hidden ? ' is-hidden' : ''}`}
                  aria-pressed={!hidden}
                  title={hidden ? '点击显示该曲线' : '点击隐藏该曲线'}
                  onClick={() => toggleLine(item.key)}
                >
                  <span className="cn-home-legend-dot" style={{ background: item.color }} />
                  <span className="cn-home-legend-name">{narrow ? shortLineLabel(item.label) : item.label}</span>
                  {narrow && !hidden ? <b className="cn-home-legend-val">{fmtValue(point?.value, mode)}</b> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      <ZonePanel zones={fullModel.zones} gaps={fullModel.gaps} mode={mode} />
    </div>
  );
}
