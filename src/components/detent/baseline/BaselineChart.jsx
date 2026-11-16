// Adapted from Detent "Baseline chart" (detentui.com, MIT): a series measured against any
// point you choose. Tap/click the line and that point becomes the level: above it fills in
// the rise colour, below it the fall colour, and the sentence reads again from there.
// Changes: plain JSX, no Detent physics lib (motion `animate` drives the level glide),
// A-share colours (red up / green down) via CSS vars, Chinese sentence, responsive height.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'motion/react';

const T = 10;
const B = 22;
const RIGHT = 0;
const UP = 'var(--market-rise, #d93025)';
const DOWN = 'var(--market-fall, #188038)';

function smooth(xs, ys) {
  const n = xs.length;
  if (n < 2) return n ? `M${xs[0]},${ys[0]}` : '';
  if (n > 400) return xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${ys[i].toFixed(2)}`).join('');
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1));
  const m = [d[0], ...d.slice(1).map((s, i) => (s * d[i] <= 0 ? 0 : (s + d[i]) / 2)), d[n - 2]];
  let p = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (xs[i + 1] - xs[i]) / 3;
    p += `C${xs[i] + h},${ys[i] + m[i] * h} ${xs[i + 1] - h},${ys[i + 1] - m[i + 1] * h} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return p;
}

function useBoxSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function BaselineChart({ data, format = (n) => String(n), label = '走势', className = '', onStartChange }) {
  const id = useId().replace(/:/g, '');
  const reduce = useReducedMotion();
  const box = useRef(null);
  const { w, h: boxH } = useBoxSize(box);
  const H = Math.max(120, boxH || 220);
  const last = data.length - 1;
  const [from, setFrom] = useState(0);
  const [at, setAt] = useState(null);
  const [seat, setSeat] = useState(() => ({ i: 0, v: data[0]?.value ?? 0 }));
  const seatRef = useRef(seat);
  const touchRef = useRef(false);

  const signature = `${data.length}|${data[0]?.label}|${data[last]?.label}`;
  useEffect(() => {
    setFrom(0);
    setAt(null);
    const next = { i: 0, v: data[0]?.value ?? 0 };
    seatRef.current = next;
    setSeat(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    const target = { i: Math.min(from, last), v: data[Math.min(from, last)]?.value ?? 0 };
    const start = seatRef.current;
    if (reduce) {
      seatRef.current = target;
      setSeat(target);
      return undefined;
    }
    const run = animate(0, 1, {
      type: 'spring',
      visualDuration: 0.35,
      bounce: 0,
      onUpdate: (t) => {
        const next = { i: start.i + (target.i - start.i) * t, v: start.v + (target.v - start.v) * t };
        seatRef.current = next;
        setSeat(next);
      }
    });
    return () => run.stop();
  }, [from, data, last, reduce]);

  const values = data.map((d) => d.value);
  const top = Math.max(...values);
  const low = Math.min(...values);
  const pad = (top - low) * 0.1 || Math.abs(top) * 0.01 || 1;
  const X = (i) => (i / (last || 1)) * (w - RIGHT);
  const Y = (v) => T + (1 - (v - (low - pad)) / (top - low + pad * 2)) * (H - T - B);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const line = useMemo(() => (w ? smooth(data.map((_, i) => X(i)), values.map(Y)) : ''), [w, H, data]);

  const seatX = X(seat.i);
  const level = Y(seat.v);
  const shape = `${line} L${X(last)},${level} L0,${level} Z`;
  const end = at !== null && at !== from ? at : last;
  const base = data[from]?.value;
  const gain = (data[end]?.value ?? 0) - (base ?? 0);
  const pct = base ? Math.abs((gain / base) * 100) : 0;
  const pctText = `${gain > 0 ? '+' : gain < 0 ? '-' : ''}${pct.toFixed(2)}%`;
  const back = end < from;
  const tone = gain > 0 ? UP : gain < 0 ? DOWN : 'var(--market-text-subtle, #5f6368)';
  const fromLabel = data[from]?.label;
  const endLabel = data[end]?.label;

  const indexFromEvent = (event) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    return Math.min(last, Math.max(0, Math.round((x / rect.width) * last)));
  };
  const choose = (i) => {
    if (i === null) return;
    setFrom(i);
    onStartChange?.(i);
  };
  const onKey = (e) => {
    const here = at ?? last;
    if (e.key === 'ArrowLeft') setAt(Math.max(0, here - 1));
    else if (e.key === 'ArrowRight') setAt(Math.min(last, here + 1));
    else if (e.key === 'Home') setAt(0);
    else if (e.key === 'End') setAt(last);
    else if (e.key === 'Escape') setAt(null);
    else if (e.key === 'Enter' || e.key === ' ') choose(here);
    else return;
    e.preventDefault();
  };

  const tickCount = Math.max(2, Math.min(6, Math.floor((w || 300) / 110)));
  const ticks = Array.from(new Set(Array.from({ length: tickCount }, (_, k) => Math.round((k / (tickCount - 1)) * last))));
  const readX = at !== null ? X(at) : null;
  const readY = at !== null ? Y(values[at]) : null;

  if (data.length < 2) return null;
  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      <div className="flex min-h-[44px] items-start justify-between gap-3 px-1 pb-1">
        <p aria-live="polite" className="text-[14px] leading-[1.45] text-[var(--market-text-subtle,#5f6368)] sm:text-[15px]">
          {back ? (
            <>
              <span className="text-[var(--market-text-strong,#202124)]">{endLabel}</span> 比 {fromLabel}{' '}
              <span className="font-semibold tabular-nums" style={{ color: tone }}>
                {gain === 0 ? '持平' : `${gain > 0 ? '高' : '低'} ${format(Math.abs(gain))}`}
              </span>
              <span className="tabular-nums">，{pctText}</span>
            </>
          ) : (
            <>
              自 <span className="text-[var(--market-text-strong,#202124)]">{fromLabel}</span> 到 {endLabel}{' '}
              <span className="font-semibold tabular-nums" style={{ color: tone }}>
                {gain === 0 ? '持平' : `${gain > 0 ? '涨' : '跌'} ${format(Math.abs(gain))}`}
              </span>
              <span className="tabular-nums">，{pctText}</span>
            </>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2 pt-0.5 text-[11px] text-[var(--market-text-subtle,#80868b)]">
          {from !== 0 ? (
            <button type="button" onClick={() => choose(0)} className="rounded-full border border-[var(--market-border,#dadce0)] px-2 py-0.5 hover:bg-black/5">
              重置基准
            </button>
          ) : (
            <span className="hidden sm:inline">点图上任一天设为基准</span>
          )}
        </div>
      </div>
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label={`${label}，点击设为基准日`}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={end}
        aria-valuetext={`${back ? `${endLabel} 比 ${fromLabel}` : `自 ${fromLabel} 到 ${endLabel}`} ${pctText}`}
        className="relative min-h-0 flex-1 cursor-crosshair touch-pan-y select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8]/30"
        onPointerMove={(e) => setAt(indexFromEvent(e))}
        onPointerDown={(e) => {
          touchRef.current = e.pointerType !== 'mouse';
          setAt(indexFromEvent(e));
        }}
        onPointerLeave={() => setAt(null)}
        onPointerCancel={() => setAt(null)}
        onClick={(e) => {
          choose(indexFromEvent(e));
          if (touchRef.current) setAt(null);
        }}
        onKeyDown={onKey}
      >
        <svg width="100%" height={H} className="absolute inset-0 block overflow-visible" aria-hidden>
          {w > 0 && (
            <>
              <defs>
                <clipPath id={`${id}up`}>
                  <rect x={seatX} y={-T} width={Math.max(0, w - seatX)} height={Math.max(0, level + T)} />
                </clipPath>
                <clipPath id={`${id}down`}>
                  <rect x={seatX} y={level} width={Math.max(0, w - seatX)} height={H} />
                </clipPath>
                <clipPath id={`${id}since`}>
                  <rect x={seatX} y={-T} width={Math.max(0, w - seatX)} height={H + T * 2} />
                </clipPath>
              </defs>
              <g clipPath={`url(#${id}up)`}>
                <path d={shape} fill={UP} opacity={0.16} />
              </g>
              <g clipPath={`url(#${id}down)`}>
                <path d={shape} fill={DOWN} opacity={0.16} />
              </g>
              <path d={line} fill="none" stroke="#202124" strokeOpacity={0.22} strokeWidth={1.4} />
              <path d={line} fill="none" stroke="#202124" strokeWidth={1.7} clipPath={`url(#${id}since)`} />
              <line x1={seatX} x2={w} y1={level} y2={level} stroke="#202124" strokeOpacity={0.45} strokeDasharray="2 3" />
              <line x1={seatX} x2={seatX} y1={level} y2={H - B} stroke="#202124" strokeOpacity={0.22} />
              <circle cx={seatX} cy={level} r={4} fill="#fff" stroke="#202124" strokeWidth={1.5} />
              {readX !== null ? (
                <>
                  <line x1={readX} x2={readX} y1={T} y2={H - B} stroke="#202124" strokeOpacity={0.12} />
                  <circle cx={readX} cy={readY} r={3.5} fill="#202124" />
                </>
              ) : null}
              <line x1={0} x2={w} y1={H - B + 0.5} y2={H - B + 0.5} stroke="#dadce0" />
              {ticks.map((i) => (
                <text
                  key={i}
                  x={X(i)}
                  y={H - 6}
                  textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
                  className="fill-[#80868b] text-[10px] tabular-nums"
                >
                  {data[i].label}
                </text>
              ))}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

export default BaselineChart;
