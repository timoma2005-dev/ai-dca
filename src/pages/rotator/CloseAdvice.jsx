import { closeAdvice, shortName } from './rotatorCharts.js';

// 收盘调仓提示：14:56 定信号，盘后固定价格（15:05–15:30，按收盘价）手动换。只提示，不下单。
export default function CloseAdvice({ close, rows, holding, cheapest, gap }) {
  const name = (code) => {
    const r = (rows || []).find((x) => x.code === code);
    return r ? shortName(r.name, code) : code;
  };
  const view = close ? {
    ...close,
    holding_name: close.holding ? shortName(close.holding_name || '', close.holding) : null,
    cheapest_name: shortName(close.cheapest_name || '', close.cheapest)
  } : null;
  const advice = closeAdvice({ close: view, holding, cheapest, gap, holdingName: name(holding), cheapestName: name(cheapest) });
  if (!advice) return null;
  const hit = advice.action === 'switch';
  return (
    <div className={`rounded-xl border px-3 py-2 text-sm leading-6 tabular-nums sm:px-4 ${hit && advice.final ? 'border-orange-500/50 bg-orange-100/70 dark:bg-orange-500/15' : 'border-border bg-card'}`}>
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium">收盘调仓</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{advice.final ? '今日 14:56 已定' : '预估 · 14:56 定'}</span>
      </div>
      <div className={hit && advice.final ? 'font-semibold' : ''}>{advice.text}</div>
      {hit && advice.final ? <div className="text-xs text-muted-foreground">盘后 15:05–15:30 按收盘价成交，需自己下单；卖出成交后再买入。</div> : null}
    </div>
  );
}
