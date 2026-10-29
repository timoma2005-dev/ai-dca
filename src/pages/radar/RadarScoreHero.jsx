import { cx } from '../../components/experience-ui.jsx';
import { rankRadarEtfs } from '../../app/radarModel.js';
import { heroNotes, parityHint, shortName } from '../../app/radarScoreModel.js';
import { DemoLockedValue, useDemoVisibleRows } from '../../components/rbac/demo-lock.jsx';

/**
 * 评分 v2「今日换基建议」（2026-10 重设计）：
 * 换基分环 + 卖出 / 买入两张基金卡 + 三个指标块（净价差、卖出紧迫度、买入吸引力）。
 * 桌面一行横排；移动端环与指标在上、两张基金卡并排在下。
 * 评分处于影子运行（scoring.mode = shadow）：只展示，不触发通知。
 */

function ScoreRing({ score }) {
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-[72px] w-[72px] shrink-0 sm:h-24 sm:w-24" aria-label={`换基分 ${pct}`}>
      <svg viewBox="0 0 72 72" className="h-full w-full -rotate-90">
        <circle cx="36" cy="36" r={r} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="6" />
        <circle
          cx="36" cy="36" r={r} fill="none" stroke="#fbbf24" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <b className="text-2xl font-extrabold leading-none tabular-nums sm:text-3xl">{pct}</b>
        <span className="mt-0.5 text-[10px] text-indigo-200">换基分</span>
      </div>
    </div>
  );
}

function FundCard({ side, etf, locked }) {
  const sell = side === 'sell';
  return (
    <div className={cx('min-w-0 rounded-xl px-3 py-2.5 ring-1 sm:px-4 sm:py-3', sell ? 'bg-rose-500/10 ring-rose-300/30' : 'bg-emerald-500/10 ring-emerald-300/30')}>
      <p className={cx('text-[11px] font-semibold', sell ? 'text-rose-200' : 'text-emerald-200')}>{sell ? '卖出' : '买入'}</p>
      {locked ? (
        <DemoLockedValue className="mt-1 block rounded-lg bg-white/10 px-2 py-1 text-sm text-indigo-100">●●●● 升级查看</DemoLockedValue>
      ) : (
        <>
          <p className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
            <b className="truncate text-lg font-extrabold leading-tight sm:text-xl">{shortName(etf.code, etf.name)}</b>
            <span className="shrink-0 text-[11px] tabular-nums text-indigo-200">{etf.code}</span>
          </p>
          <p className={cx('mt-0.5 text-xl font-extrabold tabular-nums leading-tight sm:text-2xl', sell ? 'text-rose-300' : 'text-emerald-300')}>
            {etf.premium?.toFixed(2)}%
          </p>
        </>
      )}
    </div>
  );
}

function Kpi({ label, short, value, unit, tone = 'text-white' }) {
  return (
    <div className="min-w-0 rounded-xl bg-white/[0.07] px-3 py-2 ring-1 ring-white/10">
      <p className="truncate text-[11px] text-indigo-200"><span className="lg:hidden">{short || label}</span><span className="hidden lg:inline">{label}</span></p>
      <p className={cx('mt-0.5 text-lg font-extrabold tabular-nums leading-tight', tone)}>
        {value}
        {unit ? <span className="ml-0.5 text-[11px] font-semibold text-indigo-200">{unit}</span> : null}
      </p>
    </div>
  );
}

const NOTE_STYLES = {
  sell: 'bg-rose-100 text-rose-700',
  buy: 'bg-emerald-100 text-emerald-700',
  skip: 'bg-amber-100 text-amber-800',
};

export function RadarScoreHero({ data }) {
  const scoring = data?.scoring;
  const pair = scoring?.recommendedPair;
  const visibleRows = useDemoVisibleRows();
  const buyHidden = Boolean(pair && !rankRadarEtfs(data).slice(0, visibleRows).some((etf) => etf.code === pair.buy.code));
  const notes = heroNotes(data).filter((note) => !(buyHidden && note.kind !== 'sell'));
  const triggered = notes.some((note) => note.kind === 'sell' && note.tag === '果断卖出');
  const parity = parityHint(data);
  const visibleCodes = rankRadarEtfs(data).slice(0, visibleRows).map((etf) => etf.code);
  const parityLocked = Boolean(parity && !(visibleCodes.includes(parity.sell.code) && visibleCodes.includes(parity.buy.code)));

  return (
    <article
      data-testid="radar-score-hero"
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-950 via-indigo-950 to-indigo-800 p-4 text-white shadow-lg shadow-indigo-200/50 sm:p-6"
    >
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-violet-500/25 blur-3xl" />
      <div className="relative mb-4 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold">今日换基建议</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {triggered ? (
            <span className="rounded-full bg-amber-300/20 px-2.5 py-1 text-[11px] font-bold text-amber-200">⚡ 份额事件触发</span>
          ) : null}
          <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-indigo-100">
            评分 v2.1 · 试运行{data?.date ? ` · ${data.date} 收盘` : ''}{data?.scoring?.quotaDate && data.scoring.quotaDate !== data.date ? ` · ${data.scoring.quotaDate} 份额` : ''}
          </span>
        </span>
      </div>
      {pair ? (
        <div className="relative grid gap-3 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,17rem)] lg:items-center lg:gap-6">
          <div className="flex items-center gap-3 lg:contents">
            <ScoreRing score={pair.score} />
            <div className="grid min-w-0 flex-1 grid-cols-3 gap-2 lg:order-last lg:grid-cols-1">
              <Kpi label="净价差" value={pair.netSpread?.toFixed(2)} unit="pp" tone="text-amber-200" />
              <Kpi label="卖出紧迫度" short="卖出分" value={pair.sellScore} tone="text-rose-200" />
              <Kpi label="买入吸引力" short="买入分" value={pair.buyScore} tone="text-emerald-200" />
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3">
            <FundCard side="sell" etf={pair.sell} />
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-indigo-100">→</span>
            <FundCard side="buy" etf={pair.buy} locked={buyHidden} />
          </div>
        </div>
      ) : (
        <p className="relative rounded-xl bg-white/10 px-4 py-4 text-sm text-indigo-50">
          今天没有通过评分的换基组合（价差不足或候选买入方都在放开中）。
        </p>
      )}
      {pair ? (
        <p className="relative mt-3 text-[11px] leading-5 text-indigo-200">
          净价差已扣点差与佣金 {pair.costPct?.toFixed(2)}% · 换基分 = 45% 净价差 + 30% 卖出紧迫度 + 25% 买入吸引力 · 单品分 = 自身 60 日分位 60 + 份额 25 + 流动性 15 · 试运行只展示、不发通知
        </p>
      ) : null}
      {parity && !parity.sameAsRec ? (
        <div data-testid="radar-parity" className="relative mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-sky-400/10 px-3 py-2 text-xs leading-5 text-indigo-50 ring-1 ring-sky-300/30">
          <span className="shrink-0 rounded-md bg-sky-100 px-1.5 py-0.5 text-[11px] font-bold text-sky-800">平价换基</span>
          {parityLocked ? (
            <DemoLockedValue className="rounded-lg bg-white/10 px-2 py-0.5 text-indigo-100">●●●● 升级查看</DemoLockedValue>
          ) : (
            <span className="min-w-0">
              <b>{parity.sellShort}</b> {parity.sell.premium?.toFixed(2)}% → <b>{parity.buyShort}</b> {parity.buy.premium?.toFixed(2)}%
              <span className="text-indigo-200">（溢价差 {parity.spread > 0 ? '+' : ''}{parity.spread?.toFixed(2)}pp，分数差 +{parity.edge}）</span>
            </span>
          )}
          <span className="w-full text-[11px] text-indigo-200 sm:w-auto">溢价差不多，但一只在自身高位、一只在低位 · 回测 5 日平均多收敛约 0.27pp · 建议持有满 5 个交易日再换 · 纸面跟踪</span>
        </div>
      ) : null}
      {notes.length ? (
        <ul className="relative mt-3 grid gap-2 lg:grid-cols-2">
          {notes.map((note) => (
            <li key={`${note.kind}-${note.tag}`} className="flex items-start gap-2 rounded-xl bg-white/[0.07] px-3 py-2 text-xs leading-5 text-indigo-50 ring-1 ring-white/10">
              <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold', NOTE_STYLES[note.kind])}>{note.tag}</span>
              <span className="min-w-0">{note.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export default RadarScoreHero;
