import { Fragment, useState } from 'react';
import { cx } from '../../components/experience-ui.jsx';
import {
  SCORE_SORTS,
  limitSteps,
  quotaRatioTone,
  scoreBreakdown,
  scoredRows,
} from '../../app/radarScoreModel.js';
import { DemoLockedRows, useDemoVisibleRows } from '../../components/rbac/demo-lock.jsx';
import { rankRadarEtfs } from '../../app/radarModel.js';

/**
 * 评分 v2：12 只 ETF 的溢价、份额状态、额度/日均成交、卖出紧迫度、买入吸引力。
 * 桌面表格、移动卡片；点一行展开分项得分与额度阶梯。
 */

const BADGE_TONES = {
  rose: 'bg-rose-100 text-rose-700',
  amber: 'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-700',
  indigo: 'bg-indigo-100 text-indigo-700',
  slate: 'bg-slate-100 text-slate-600',
};
const RATIO_TONES = { high: 'text-rose-600', mid: 'text-amber-600', low: 'text-slate-500', muted: 'text-slate-300' };

function ScoreBar({ value, tone }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <span className="flex items-center gap-2">
      <b className={cx('w-6 shrink-0 text-right text-xs tabular-nums', tone === 'sell' ? 'text-rose-600' : 'text-emerald-700')}>{pct}</b>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100 sm:w-20">
        <span className={cx('block h-full rounded-full', tone === 'sell' ? 'bg-rose-400' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function QuotaBadge({ badge }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold', BADGE_TONES[badge.tone])}>{badge.label}</span>
      {badge.detail ? <span className="truncate text-[11px] text-slate-400">{badge.detail}</span> : null}
    </span>
  );
}

function Tag({ row }) {
  if (row.sellTag) return <span className="rounded bg-rose-100 px-1.5 py-px text-[10px] font-bold text-rose-700">{row.sellTag}</span>;
  if (row.buyBlocked) return <span className="rounded bg-amber-100 px-1.5 py-px text-[10px] font-bold text-amber-800">{row.buyBlocked}</span>;
  if (row.isRecommendedSell) return <span className="rounded bg-rose-50 px-1.5 py-px text-[10px] font-bold text-rose-600">首选卖出</span>;
  if (row.isRecommendedBuy) return <span className="rounded bg-emerald-100 px-1.5 py-px text-[10px] font-bold text-emerald-700">首选买入</span>;
  return null;
}

function LimitStepChart({ steps }) {
  if (steps.length < 2) return <p className="text-[11px] text-slate-400">额度历史积累中（{steps.length} 天）</p>;
  const finite = steps.map((s) => (s.limit < 0 ? null : s.limit)).filter((v) => v != null);
  const max = Math.max(1, ...finite) * 1.15;
  const W = 280; const H = 56;
  const x = (i) => (i / (steps.length - 1)) * W;
  const y = (v) => (v < 0 ? 4 : H - (v / max) * (H - 8));
  let d = '';
  steps.forEach((s, i) => {
    d += i === 0 ? `M0 ${y(s.limit)}` : ` H${x(i).toFixed(1)} V${y(s.limit).toFixed(1)}`;
  });
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" aria-hidden="true">
        <path d={d} fill="none" stroke="#e11d48" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400 tabular-nums">
        <span>{steps[0].date.slice(5)}</span>
        <span>申购上限（份/日，顶格 = 不设限）</span>
        <span>{steps[steps.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}

function Breakdown({ data, row }) {
  const sides = [['sell', '卖出紧迫度', row.sellScore], ['buy', '买入吸引力', row.buyScore]];
  return (
    <div className="grid gap-4 rounded-xl bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_minmax(0,1.1fr)]">
      {sides.map(([side, title, total]) => (
        <div key={side} className="min-w-0">
          <p className="mb-1.5 text-[11px] font-bold text-slate-700">{title} {total}</p>
          <ul className="space-y-1">
            {scoreBreakdown(row, side).map((item) => (
              <li key={item.label} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="min-w-0 text-slate-600">{item.label}<span className="ml-1 text-slate-400">{item.detail}</span></span>
                <b className="shrink-0 tabular-nums text-slate-800">{item.points ?? '—'}<span className="font-normal text-slate-400">/{item.max}</span></b>
              </li>
            ))}
          </ul>
          {side === 'buy' && row.buyBlocked ? <p className="mt-1 text-[11px] text-amber-700">放开中且新增额度 ≥ 日均成交 1%：{row.buyBlocked}</p> : null}
        </div>
      ))}
      <div className="min-w-0">
        <p className="mb-1.5 text-[11px] font-bold text-slate-700">额度变化</p>
        <LimitStepChart steps={limitSteps(data, row.code)} />
      </div>
    </div>
  );
}

function ratioText(row) {
  if (row.quota?.unlimited) return '不设限';
  return Number.isFinite(row.quota?.quotaRatioPct) ? `${row.quota.quotaRatioPct.toFixed(2)}%` : '—';
}

function peerText(row) {
  if (!Number.isFinite(row.premiumVsPeer)) return '—';
  return `${row.premiumVsPeer > 0 ? '+' : ''}${row.premiumVsPeer.toFixed(2)}`;
}

/** 首选卖出 / 首选买入行加左侧色条 */
function accentClass(row) {
  if (row.isRecommendedSell) return 'shadow-[inset_3px_0_0_#f43f5e]';
  if (row.isRecommendedBuy) return 'shadow-[inset_3px_0_0_#10b981]';
  return '';
}

function MiniScore({ label, value, tone }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
      {label}
      <b className={cx('tabular-nums', tone === 'sell' ? 'text-rose-600' : 'text-emerald-700')}>{pct}</b>
      <span className="h-1 w-8 overflow-hidden rounded-full bg-slate-100">
        <span className={cx('block h-full rounded-full', tone === 'sell' ? 'bg-rose-400' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export function RadarScoreTable({ data }) {
  const [sort, setSort] = useState('overall');
  const [open, setOpen] = useState('');
  const rows = scoredRows(data, sort);
  const visibleRows = useDemoVisibleRows();
  // 演示：只露溢价排行前 visibleRows 只，其余遮罩（与旧排行一致）
  const visibleCodes = new Set(rankRadarEtfs(data).slice(0, visibleRows).map((etf) => etf.code));
  const shown = rows.filter((row) => visibleCodes.has(row.code));
  const lockedCount = rows.length - shown.length;
  const toggle = (code) => setOpen((cur) => (cur === code ? '' : code));
  // 「只看份额异动」随份额动态一起下线（2026-10 重设计），模型里的 quota 排序保留给测试/复盘复用
  const sorts = Object.entries(SCORE_SORTS).filter(([key]) => key !== 'quota');

  return (
    <section data-testid="radar-score-table" className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
        <h3 className="text-sm font-bold text-slate-900">
          {Object.keys(data?.scoring?.etfs || {}).length} 只纳指 ETF 评分
          <span className="ml-2 hidden text-[11px] font-normal text-slate-400 sm:inline">点一行看分项得分与额度阶梯</span>
        </h3>
        <div className="inline-flex rounded-xl bg-slate-100 p-0.5" role="tablist" aria-label="排序">
          {sorts.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={sort === key}
              onClick={() => setSort(key)}
              className={cx(
                'min-h-8 rounded-lg px-3 text-xs font-semibold transition-colors',
                sort === key ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 桌面表格 */}
      <div className="hidden px-5 pb-2 lg:block">
        <table className="w-full table-fixed text-left">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] text-slate-400">
              <th className="w-[24%] py-2.5 pl-3 font-medium">基金</th>
              <th className="w-[13%] py-2.5 font-medium">溢价 <span className="text-slate-300">/ vs 同类</span></th>
              <th className="w-[23%] py-2.5 font-medium">份额状态</th>
              <th className="w-[10%] whitespace-nowrap py-2.5 font-medium">额度/成交</th>
              <th className="w-[15%] py-2.5 font-medium">卖出紧迫度</th>
              <th className="w-[15%] py-2.5 font-medium">买入吸引力</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <Fragment key={row.code}>
                <tr
                  onClick={() => toggle(row.code)}
                  className={cx(
                    'cursor-pointer border-b border-slate-50 transition-colors hover:bg-slate-50',
                    accentClass(row),
                    open === row.code && 'bg-indigo-50/70'
                  )}
                  aria-expanded={open === row.code}
                >
                  <td className="py-3 pl-3 pr-2">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <b className="text-sm text-slate-800">{row.short}</b>
                      <span className="text-[11px] tabular-nums text-slate-400">{row.code}</span>
                      <Tag row={row} />
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-3">
                    <b className={cx('text-sm tabular-nums', row.premiumVsPeer > 1 ? 'text-rose-600' : 'text-slate-700')}>{row.premium?.toFixed(2)}%</b>
                    <span className="ml-1.5 text-[11px] tabular-nums text-slate-400">{peerText(row)}</span>
                  </td>
                  <td className="py-3 pr-2"><QuotaBadge badge={row.badge} /></td>
                  <td className={cx('py-3 text-xs font-semibold tabular-nums', RATIO_TONES[quotaRatioTone(row.quota?.quotaRatioPct)])}>{ratioText(row)}</td>
                  <td className="py-3"><ScoreBar value={row.sellScore} tone="sell" /></td>
                  <td className="py-3"><ScoreBar value={row.buyScore} tone="buy" /></td>
                </tr>
                {open === row.code ? (
                  <tr><td colSpan={6} className="pb-3 pt-1"><Breakdown data={data} row={row} /></td></tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* 移动卡片：两行紧凑布局 */}
      <ul className="divide-y divide-slate-100 lg:hidden">
        {shown.map((row) => (
          <li key={row.code} className={cx(accentClass(row), open === row.code && 'bg-indigo-50/60')}>
            <button type="button" className="w-full px-4 py-3 text-left" onClick={() => toggle(row.code)} aria-expanded={open === row.code}>
              <span className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <b className="text-[15px] text-slate-800">{row.short}</b>
                  <span className="text-[11px] tabular-nums text-slate-400">{row.code}</span>
                  <Tag row={row} />
                </span>
                <span className="shrink-0 text-right">
                  <b className={cx('text-[15px] tabular-nums', row.premiumVsPeer > 1 ? 'text-rose-600' : 'text-slate-700')}>{row.premium?.toFixed(2)}%</b>
                  <span className="ml-1 text-[11px] tabular-nums text-slate-400">{peerText(row)}</span>
                </span>
              </span>
              <span className="mt-1.5 flex items-center justify-between gap-2">
                <span className="min-w-0"><QuotaBadge badge={row.badge} /></span>
                <span className="flex shrink-0 items-center gap-2.5">
                  <MiniScore label="卖" value={row.sellScore} tone="sell" />
                  <MiniScore label="买" value={row.buyScore} tone="buy" />
                </span>
              </span>
            </button>
            {open === row.code ? (
              <div className="px-4 pb-3">
                <p className={cx('mb-2 text-[11px] tabular-nums', RATIO_TONES[quotaRatioTone(row.quota?.quotaRatioPct)])}>额度/日均成交 {ratioText(row)}</p>
                <Breakdown data={data} row={row} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {lockedCount > 0 ? <div className="space-y-2 px-4 pb-2 sm:px-5"><DemoLockedRows count={lockedCount} /></div> : null}
      <p className="border-t border-slate-100 px-4 py-3 text-[11px] leading-5 text-slate-400 sm:px-5">
        额度/日均成交 ≥2% 标红（套利资金充足，溢价难维持），0.5–2% 标橙。份额状态来自交易所 PCF 申购上限。
      </p>
    </section>
  );
}

export default RadarScoreTable;
