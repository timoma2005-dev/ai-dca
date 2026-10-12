import { useMemo, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import {
  PALETTE,
  buildChartModel,
  lineKey,
  resolveEndLabels,
  tooltipRows,
} from './chartModel.mjs';

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
            <span className="cn-home-zone-title">{zone.label}（{zone.count}只）</span>
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

export function PremiumChart({ series, mode }) {
  const [cursor, setCursor] = useState(null);
  const [hiddenKeys, setHiddenKeys] = useState([]);
  const ref = useRef(null);

  const lines = Array.isArray(series) ? series : [];
  const model = useMemo(() => buildChartModel(lines, mode, hiddenKeys), [lines, mode, hiddenKeys]);

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
    return [0, Math.floor(samplePts.length * 0.25), Math.floor(samplePts.length * 0.5), Math.floor(samplePts.length * 0.75), samplePts.length - 1]
      .filter((idx, pos, arr) => samplePts[idx] && arr.indexOf(idx) === pos);
  }, [samplePts]);

  function toggleLine(key) {
    setHiddenKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function move(event) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !model.length) return;
    const x = event.touches?.[0]?.clientX ?? event.clientX;
    const normX = ((x - rect.left) / rect.width - PAD_L / W) / (PLOT_W / W);
    setCursor(Math.max(0, Math.min(model.length - 1, Math.round(normX * (model.length - 1)))));
  }
  function leave() {
    setCursor(null);
  }

  if (!model.rows.length) return <div className="cn-home-empty">暂无今日走势</div>;

  const tipRows = cursor != null ? tooltipRows(model.rows, cursor, mode) : [];
  const tipTime = tipRows.map((r) => r.p?.t).find(Boolean) || '';
  const cursorXPct = cursor != null ? (xFor(cursor) / W) * 100 : 0;
  const tipOnLeft = cursorXPct > 62;

  return (
    <div className="cn-home-premium-wrap" ref={ref} onMouseMove={move} onMouseLeave={leave} onTouchStart={move} onTouchMove={move}>
      <svg className="cn-home-premium-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="场内分时走势">
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
            <text x={PAD_L - 8} y={yFor(0) + 4} textAnchor="end" className="axis">0.00%</text>
          </g>
        ) : null}
        {timeIndices.map((idx) => (
          <text key={idx} x={xFor(idx)} y={H - 12} textAnchor="middle" className="axis">{samplePts[idx]?.t || ''}</text>
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
      {cursor != null ? (
        <div
          className="cn-home-chart-tooltip"
          style={tipOnLeft
            ? { left: `${cursorXPct}%`, transform: 'translateX(calc(-100% - 16px))' }
            : { left: `${cursorXPct}%`, transform: 'translateX(16px)' }}
        >
          <div className="cn-home-tooltip-head"><span>{tipTime}</span><span>{mode === 'premium' ? '实时溢价率' : '分时价格'}</span></div>
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
      {legendItems.length ? (
        <div className="cn-home-chart-legend" role="group" aria-label="曲线图例，点击切换显示">
          {legendItems.map((item) => {
            const hidden = hiddenKeys.includes(item.key);
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
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <ZonePanel zones={model.zones} gaps={model.gaps} mode={mode} />
    </div>
  );
}
