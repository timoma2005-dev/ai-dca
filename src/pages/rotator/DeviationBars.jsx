import { deviationBars } from './rotatorCharts.js';

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

export default function DeviationBars({ rows, holding, cheapest, gap, enter, at }) {
  const bars = deviationBars(rows);
  if (!bars.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-sm font-medium">
        <span className="tabular-nums">{at || '—'}</span> 实测：各只比今天的基准贵/便宜多少
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        各家溢价水平不同，每只只和它自己今天的基准溢价比（基准价 = IOPV × (1 + 基准溢价)）
      </div>
      <div className="mt-3 grid grid-cols-[4.5rem_3.5rem_1fr_1fr] text-xs font-medium">
        <div />
        <div />
        <div className="pr-2 text-right text-sky-700">← 比今天的基准便宜</div>
        <div className="pl-2 text-orange-700">比今天的基准贵 →</div>
      </div>
      <div className="mt-1 space-y-0.5 text-sm tabular-nums">
        {bars.map((b) => {
          const held = b.code === holding;
          const cheap = b.code === cheapest;
          const w = `${Math.max(b.ratio * 72, 2)}%`;
          return (
            <div
              key={b.code}
              className={`grid grid-cols-[4.5rem_3.5rem_1fr_1fr] items-center rounded px-1 py-0.5 ${cheap ? 'bg-amber-100/70 dark:bg-amber-500/15' : held ? 'bg-sky-100/70 dark:bg-sky-500/15' : ''}`}
              title={`${b.code} 现价 ${px3(b.price)} · 基准 ${px3(b.basePx)}`}
            >
              <div className={`truncate ${cheap || held ? 'font-semibold' : ''}`}>{b.name}</div>
              <div className="text-xs text-muted-foreground">{px3(b.price)}元</div>
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
