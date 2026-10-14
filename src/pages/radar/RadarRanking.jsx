import { useEffect, useRef } from 'react';
import { cx } from '../../components/experience-ui.jsx';
import { candidatePair, rankRadarEtfs, rotationAdvice } from '../../app/radarModel.js';

/**
 * 纳指 ETF 溢价排行与内联轮动建议（plan §4）。
 * - 展示实际 N 只有效标的；候选标识只在有效集合内选最高/最低；
 * - 重复点击关闭；点击最低者显示无需切换；
 * - 差价来自当前快照 premium，标注“溢价差（百分点），未计交易成本”；
 * - 建议为内联展开，不是底部 Sheet；打开时温和滚动并遵循 reduced-motion。
 */

export function RadarRanking({ data, selectedCode, onToggleSelected }) {
  const ranked = rankRadarEtfs(data);
  const candidates = candidatePair(data);
  const advice = rotationAdvice(data, selectedCode);
  const adviceRef = useRef(null);
  const previousAdviceKeyRef = useRef(null);

  useEffect(() => {
    const key = advice ? advice.selected.code : null;
    if (key === previousAdviceKeyRef.current) return;
    previousAdviceKeyRef.current = key;
    if (!key) return;
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    adviceRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
  }, [advice]);

  const maxP = ranked.length ? ranked[0].premium : 1;
  const minP = ranked.length ? ranked[ranked.length - 1].premium : 0;

  return (
    <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-900">{ranked.length} 只纳指 ETF 溢价排行</h3>
        <span className="text-[11px] text-slate-400">按溢价率排序 · 点击行查看轮动建议</span>
      </div>
      <div className="space-y-2.5">
        {ranked.map((etf, index) => {
          const width = maxP > minP ? (((etf.premium - minP) / (maxP - minP)) * 100).toFixed(0) : 100;
          const isSellCandidate = candidates?.sell.code === etf.code;
          const isBuyCandidate = candidates?.buy.code === etf.code;
          const isSelected = etf.code === selectedCode;
          return (
            <button
              key={etf.code}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onToggleSelected?.(etf.code)}
              className={cx(
                'flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                isSelected
                  ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300'
                  : 'border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50'
              )}
            >
              <span
                className={cx(
                  'w-5 shrink-0 text-center text-[11px] font-bold tabular-nums',
                  index < 3 ? 'text-indigo-600' : 'text-slate-300'
                )}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <b className="text-xs font-bold text-slate-800 tabular-nums">{etf.code}</b>
                  <span className="min-w-0 truncate text-[11px] text-slate-400">{etf.name || '—'}</span>
                  {isSellCandidate && (
                    <span className="rounded bg-rose-100 px-1.5 py-px text-[10px] font-bold text-rose-700">卖出候选</span>
                  )}
                  {isBuyCandidate && (
                    <span className="rounded bg-emerald-100 px-1.5 py-px text-[10px] font-bold text-emerald-700">买入候选</span>
                  )}
                </span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className={cx(
                      'block h-full rounded-full',
                      isSellCandidate ? 'bg-rose-400' : isBuyCandidate ? 'bg-emerald-400' : 'bg-indigo-300'
                    )}
                    style={{ width: `${width}%` }}
                  />
                </span>
              </span>
              <span
                className={cx(
                  'w-16 shrink-0 text-right text-xs font-bold tabular-nums',
                  isSellCandidate ? 'text-rose-600' : isBuyCandidate ? 'text-emerald-600' : 'text-slate-600'
                )}
              >
                {etf.premium.toFixed(2)}%
              </span>
            </button>
          );
        })}
      </div>

      {advice && (
        <div
          ref={adviceRef}
          className="mt-4 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-4 text-white shadow-[0_4px_12px_rgba(15,23,42,0.12)]"
        >
          <div className="mb-3 flex items-center justify-between gap-2 text-xs text-slate-400">
            <span>持有 {advice.selected.code} 的轮动切换建议</span>
            <button
              type="button"
              onClick={() => onToggleSelected?.(advice.selected.code)}
              className="shrink-0 rounded px-1 text-[11px] text-slate-400 hover:text-white"
            >
              ✕ 关闭
            </button>
          </div>
          {advice.isLowest ? (
            <p className="text-sm leading-6 text-emerald-300">
              {advice.selected.code} 已是当前有效标的中最低溢价（{advice.selected.premium.toFixed(2)}%），
              作为买入底仓最佳，无需切换。
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-slate-400">卖出高溢价</div>
                  <div className="text-base font-bold tabular-nums">{advice.selected.code}</div>
                  <div className="text-sm font-bold text-rose-300 tabular-nums">{advice.selected.premium.toFixed(2)}%</div>
                </div>
                <div className="shrink-0 text-center">
                  <div aria-hidden="true" className="text-lg leading-none">→</div>
                  <div className="mt-1 rounded-xl bg-white/10 px-3 py-1.5 text-center">
                    <div className="text-[10px] text-slate-400">溢价差</div>
                    <div className="text-base font-extrabold text-amber-300 tabular-nums">{advice.spreadPoints}</div>
                  </div>
                </div>
                <div className="min-w-0 flex-1 text-right">
                  <div className="text-[11px] text-slate-400">换入最低溢价</div>
                  <div className="text-base font-bold tabular-nums">{advice.lowest.code}</div>
                  <div className="text-sm font-bold text-emerald-300 tabular-nums">{advice.lowest.premium.toFixed(2)}%</div>
                </div>
              </div>
              <p className="mt-3 border-t border-white/10 pt-2 text-[11px] leading-5 text-slate-400">
                溢价差（百分点），未计交易成本；差价来自当前快照 premium，不构成收益承诺。
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default RadarRanking;
