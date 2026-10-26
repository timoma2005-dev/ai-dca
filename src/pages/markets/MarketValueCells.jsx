import { cx } from '../../components/experience-ui.jsx';
import { resolveMarketPriceDisplay, resolveTurnoverDisplay } from './marketMissingValue.js';

// 价格单元格：场外基金显示净值 + 净值日期；缺失显示「—」并标注原因，不再显示 0.00。
export function MarketPriceCell({ row, className = '' }) {
  const view = resolveMarketPriceDisplay(row);
  return (
    <span className="inline-flex flex-col items-center leading-tight" title={view.title || undefined}>
      <span className={cx('tabular-nums', view.missing ? 'text-[var(--market-text-muted)]' : 'font-semibold text-slate-900', className)}>{view.text}</span>
      {view.note ? <span className="text-[10px] font-normal text-[var(--market-text-muted)]">{view.note}</span> : null}
    </span>
  );
}

export function MarketTurnoverCell({ row, className = '' }) {
  const view = resolveTurnoverDisplay(row);
  return (
    <span className={cx('tabular-nums', view.missing ? 'text-[var(--market-text-muted)]' : 'text-[var(--market-text-strong)]', className)} title={view.title || undefined}>
      {view.text}
    </span>
  );
}

export function MobilePriceValue({ row }) {
  const view = resolveMarketPriceDisplay(row);
  return (
    <span title={view.title || undefined}>
      <span className={cx('font-mono text-lg font-bold tabular-nums', view.missing ? 'text-slate-400' : 'text-slate-900')}>{view.text}</span>
      {view.note ? <span className="ml-1 text-[10px] font-normal text-slate-400">{view.note}</span> : null}
    </span>
  );
}
