import { useEffect } from 'react';
import { deviationBars, emptyHint, inLunch, shanghaiDay } from './rotatorCharts.js';

const LAST_KEY = 'aidca.rotator.lastbars.v1';
function loadLast() { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; } }

const pct = (bps, d = 2) => `${bps > 0 ? '+' : bps < 0 ? '−' : ''}${Math.abs(bps / 100).toFixed(d)}%`;
const px3 = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v).toFixed(3) : '—');

function Summary({ bars, holding, cheapest, gap, enter }) {
  const h = bars.find((b) => b.code === holding);
  const c = bars.find((b) => b.code === cheapest);
  if (!c) return null;
  const line = (b) => `${b.name} ${px3(b.price)}，比今天基准 ${px3(b.basePx)} ${b.dev > 0 ? '贵' : '便宜'} ${Math.abs(b.dev / 100).toFixed(2)}%`;
  if (!h) return <div>最便宜：{line(c)}（未设置持仓）</div>;
  if (h.code === c.code) return <div>{line(h)}；已经拿着最便宜的 → 不换</div>;
  const hit = Number.isFinite(gap) && Number.isFinite(enter) && gap >= enter;
  return (
    <>
      <div>{line(h)}；</div>
      <div>
        {line(c)}，差 <b>{Number.isFinite(gap) ? (gap / 100).toFixed(2) : '—'}%</b>
        {hit ? ' → 换' : ` → 不换（阈值 ${Number.isFinite(enter) ? (enter / 100).toFixed(2) : '—'}%）`}
      </div>
    </>
  );
}

// 午休时后端只剩上午最后一笔留档；万一也没有，就用本机记下的上午最后一次有效数据
export default function DeviationBars(props) {
  const live = deviationBars(props.rows).length > 0;
  const { rows, cheapest, gap, at } = props;
  useEffect(() => {
    if (!live) return;
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ day: shanghaiDay(), rows, cheapest, gap, at })); } catch { /* 隐私模式 */ }
  }, [live, rows, cheapest, gap, at]);
  const lunch = inLunch();
  const last = !live && lunch ? loadLast() : null;
  const use = last?.day === shanghaiDay() ? { ...props, ...last } : props;
  return <Bars {...use} lunch={lunch} />;
}

function Bars({ rows, holding, cheapest, gap, enter, at, lunch }) {
  const bars = deviationBars(rows);
  if (!bars.length) {
    const [title, sub] = emptyHint();
    return (
      <div className="rounded-xl border border-dashed border-border bg-card px-4 py-10 text-center">
        <div className="text-base font-medium">{title}</div>
        <div className="mt-1 text-sm text-muted-foreground">{sub}</div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <div className="text-sm font-medium">
        {lunch ? <span className="mr-1 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">午休中 · 13:00 恢复</span> : null}
        <span className="tabular-nums">{at || '—'}</span> 各只比今天的基准贵/便宜多少
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        每只只和自己今天的基准溢价比
      </div>
      <div className="mt-3 grid grid-cols-[3.75rem_3.25rem_1fr_1fr] whitespace-nowrap px-1 text-[11px] font-medium sm:grid-cols-[4.5rem_3.5rem_1fr_1fr] sm:text-xs">
        <div className="text-muted-foreground">基金</div>
        <div className="text-muted-foreground">现价</div>
        <div className="pr-1 text-right text-sky-700">← 便宜</div>
        <div className="pl-1 text-orange-700">贵 →</div>
      </div>
      <div className="mt-1 space-y-0.5 text-sm tabular-nums">
        {bars.map((b) => {
          const held = b.code === holding;
          const cheap = b.code === cheapest;
          const w = `${Math.max(b.ratio * 72, 2)}%`;
          return (
            <div
              key={b.code}
              className={`grid grid-cols-[3.75rem_3.25rem_1fr_1fr] items-center whitespace-nowrap sm:grid-cols-[4.5rem_3.5rem_1fr_1fr] rounded px-1 py-0.5 ${cheap ? 'bg-amber-100/70 dark:bg-amber-500/15' : held ? 'bg-sky-100/70 dark:bg-sky-500/15' : ''}`}
              title={`${b.code} 现价 ${px3(b.price)} · 基准 ${px3(b.basePx)}`}
            >
              <div className={`truncate ${cheap || held ? 'font-semibold' : ''}`}>{b.name}</div>
              <div className="text-xs text-muted-foreground">{px3(b.price)}</div>
              <div className="flex items-center justify-end gap-1 border-r border-foreground/70 pr-0.5">
                {b.dev < 0 ? (
                  <>
                    <span className={`text-xs ${cheap ? 'font-semibold' : ''}`}>{pct(b.dev)}</span>
                    <span className="h-3.5 rounded-sm border border-sky-900/60 bg-sky-300/80" style={{ width: w }} />
                  </>
                ) : held ? <span className="text-xs font-semibold">我拿着 →</span> : null}
              </div>
              <div className="flex items-center gap-1 pl-0.5">
                {b.dev >= 0 ? (
                  <>
                    <span className="h-3.5 rounded-sm border border-orange-900/60 bg-orange-200" style={{ width: w }} />
                    <span className={`text-xs ${held ? 'font-semibold' : ''}`}>{pct(b.dev)}</span>
                  </>
                ) : cheap ? <span className="text-xs font-semibold">← 最便宜</span> : held ? <span className="text-xs font-semibold">← 我拿着</span> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 rounded-lg bg-amber-100/60 px-3 py-2 text-sm leading-6 tabular-nums dark:bg-amber-500/10">
        <Summary bars={bars} holding={holding} cheapest={cheapest} gap={gap} enter={enter} />
      </div>
    </div>
  );
}
