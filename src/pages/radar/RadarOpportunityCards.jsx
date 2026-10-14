import { cx } from '../../components/experience-ui.jsx';
import { percentileView, validBestPair } from '../../app/radarModel.js';

/**
 * 左栏最优机会 Hero 与溢价差分位条（plan §4）。
 * - Hero 只展示通过校验的 bestPair；partial（无 bestPair 但有 etfs）显示缺失说明，排行仍可见。
 * - 分位沿用 historyDays >= 5 展示门槛与 85 分位关注提示；缺失不是 0 分位。
 */

function PercentileBar({ percentile }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(percentile) ? percentile : 0));
  return (
    <div>
      <div className="relative h-3 overflow-hidden rounded-full border border-slate-200 bg-slate-100">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-300 via-amber-300 to-rose-400 transition-all duration-1000"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="relative mt-1 h-8">
        <div
          className="absolute flex -translate-x-1/2 flex-col items-center transition-all duration-1000"
          style={{ left: `${pct}%` }}
        >
          <div className="h-3 w-0.5 bg-slate-800" />
          <div className="mt-0.5 whitespace-nowrap rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-bold text-white tabular-nums">
            {percentile}分位
          </div>
        </div>
      </div>
    </div>
  );
}

export function RadarOpportunityCards({ data }) {
  const pair = validBestPair(data);
  const percentile = percentileView(data);

  return (
    <div className="min-w-0 space-y-5">
      <article className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-600 via-indigo-600 to-violet-700 p-5 text-white shadow-lg shadow-indigo-200/60 sm:p-6">
        <div className="pointer-events-none absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/10" aria-hidden="true" />
        <div className="relative mb-4 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold">
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
            今日最优套利机会
          </span>
          <span className="min-w-0 text-right text-[11px] text-indigo-100">
            {data?.date ? `${data.date} 收盘口径，净值日期未验证` : '基准日期未知'}
          </span>
        </div>
        {pair ? (
          <>
            <div className="relative grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="min-w-0 rounded-xl border border-white/15 bg-white/10 px-4 py-3">
                <div className="flex items-center gap-1.5 text-[11px] text-indigo-100">
                  <span aria-hidden="true" className="text-rose-300">●</span> 高溢价卖出
                </div>
                <div className="mt-0.5 text-xl font-extrabold leading-tight tracking-tight tabular-nums">{pair.sell.code}</div>
                <div className="break-words text-xs leading-tight text-indigo-100">{pair.sell.name || '—'}</div>
                <div className="mt-1.5 text-2xl font-extrabold leading-none tabular-nums">{pair.sell.premium.toFixed(2)}%</div>
              </div>
              <div className="flex flex-col items-center justify-center px-1">
                <span aria-hidden="true" className="text-2xl leading-none">→</span>
                <span className="mt-1 whitespace-nowrap rounded-full bg-white px-2.5 py-1 text-[11px] font-extrabold text-indigo-700 shadow tabular-nums">
                  价差 {pair.spread.toFixed(2)}%
                </span>
              </div>
              <div className="min-w-0 rounded-xl border border-white/15 bg-white/10 px-4 py-3 sm:text-right">
                <div className="flex items-center gap-1.5 text-[11px] text-indigo-100 sm:justify-end">
                  低溢价买入 <span aria-hidden="true" className="text-emerald-300">●</span>
                </div>
                <div className="mt-0.5 text-xl font-extrabold leading-tight tracking-tight tabular-nums">{pair.buy.code}</div>
                <div className="break-words text-xs leading-tight text-indigo-100">{pair.buy.name || '—'}</div>
                <div className="mt-1.5 text-2xl font-extrabold leading-none tabular-nums">{pair.buy.premium.toFixed(2)}%</div>
              </div>
            </div>
            <div className="relative mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/15 pt-3 text-xs text-indigo-100">
              {percentile.visible && percentile.percentile != null ? (
                <span>
                  价差处于近 20 个交易日样本中 <b className="text-sm font-extrabold text-white tabular-nums">{percentile.percentile}</b> 分位
                  （样本 {percentile.historyDays}/{percentile.maxHistoryDays} 条）
                </span>
              ) : (
                <span>分位数据积累中（{percentile.historyDays ?? '—'}/20 天），暂无分位参考</span>
              )}
              {percentile.visible && percentile.percentile != null && (
                <span
                  className={cx(
                    'rounded-full px-2.5 py-1 text-[11px] font-bold',
                    percentile.attention ? 'bg-emerald-400 text-emerald-950' : 'bg-white/20 text-white'
                  )}
                >
                  {percentile.attention ? '建议关注' : '观望'}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-white/15 bg-white/10 px-4 py-5 text-sm leading-6 text-indigo-50">
            当前快照缺少最优套利对（bestPair 缺失或不完整）。溢价排行仍可查看，
            但请等待 21:35 计划计算产出完整快照后再参考套利结论。
          </div>
        )}
      </article>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">溢价差历史分位（近 20 个交易日）</h3>
          <span className="text-xs text-slate-400 tabular-nums">
            {percentile.visible
              ? `样本 ${percentile.historyDays}/${percentile.maxHistoryDays} 条`
              : '分位需 ≥5 天历史'}
          </span>
        </div>
        {pair && percentile.visible ? (
          percentile.percentile != null ? (
            <>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                当前价差 <b className="text-slate-800 tabular-nums">{pair.spread.toFixed(2)}%</b>，
                超过了近 20 个交易日样本中 <b className="text-indigo-600 tabular-nums">{percentile.percentile}%</b> 的日子。
                {percentile.attention ? '分位高于 85，建议关注轮动机会。' : '分位未高于 85，暂无特别提示。'}
              </p>
              <div className="mt-3">
                <PercentileBar percentile={percentile.percentile} />
              </div>
            </>
          ) : (
            <p className="mt-2 text-xs leading-5 text-slate-500">
              本次快照未返回有效分位数值，缺失不计为 0 分位，等待后续快照补充。
            </p>
          )
        ) : (
          <p className="mt-2 text-xs leading-5 text-slate-500">
            历史数据积累中（{percentile.historyDays ?? '—'}/20 天），暂无分位参考。
          </p>
        )}
      </section>
    </div>
  );
}

export default RadarOpportunityCards;
