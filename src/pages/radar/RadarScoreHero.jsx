import { cx } from '../../components/experience-ui.jsx';
import { rankRadarEtfs } from '../../app/radarModel.js';
import { heroNotes, shortName } from '../../app/radarScoreModel.js';
import { DemoLockedValue, useDemoVisibleRows } from '../../components/rbac/demo-lock.jsx';

/**
 * 评分 v2「今日换基建议」：换基分环 + 卖→买 + 净价差 + 份额提示条。
 * 评分处于影子运行（scoring.mode = shadow）：只展示，不触发通知。
 */

function ScoreRing({ score }) {
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-20 w-20 shrink-0" aria-label={`换基分 ${pct}`}>
      <svg viewBox="0 0 72 72" className="h-20 w-20 -rotate-90">
        <circle cx="36" cy="36" r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="7" />
        <circle
          cx="36" cy="36" r={r} fill="none" stroke="#fbbf24" strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <b className="text-2xl font-extrabold leading-none tabular-nums">{pct}</b>
        <span className="mt-0.5 text-[10px] text-indigo-100">换基分</span>
      </div>
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

  return (
    <article
      data-testid="radar-score-hero"
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-950 via-indigo-800 to-violet-700 p-5 text-white shadow-lg shadow-indigo-200/60 sm:p-6"
    >
      <div className="relative mb-4 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-indigo-100">今日换基建议</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {triggered ? (
            <span className="rounded-full bg-amber-300/20 px-2.5 py-1 text-[11px] font-bold text-amber-200">⚡ 份额事件触发</span>
          ) : null}
          <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] text-indigo-100">
            评分 v2 · 试运行{data?.date ? ` · ${data.date} 收盘溢价` : ''}{data?.scoring?.quotaDate && data.scoring.quotaDate !== data.date ? ` · ${data.scoring.quotaDate} 份额` : ''}
          </span>
        </span>
      </div>
      {pair ? (
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
          <ScoreRing score={pair.score} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xl font-extrabold leading-tight sm:text-2xl">
              <span>卖 {shortName(pair.sell.code, pair.sell.name)}</span>
              <span className="tabular-nums text-rose-300">{pair.sell.premium?.toFixed(2)}%</span>
              <span aria-hidden="true" className="text-indigo-200">→</span>
              {buyHidden ? (
                <DemoLockedValue className="rounded-lg bg-white/10 px-2 text-base text-indigo-100">买 ●●●● 升级查看</DemoLockedValue>
              ) : (
                <>
                  <span>买 {shortName(pair.buy.code, pair.buy.name)}</span>
                  <span className="tabular-nums text-emerald-300">{pair.buy.premium?.toFixed(2)}%</span>
                </>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-5 text-indigo-100">
              <span className="tabular-nums">{pair.sell.code}</span>
              {buyHidden ? null : <> → <span className="tabular-nums">{pair.buy.code}</span></>}
              {' · '}净价差 <b className="tabular-nums text-white">{pair.netSpread?.toFixed(2)} pp</b>（已扣点差与佣金 {pair.costPct?.toFixed(2)}%）
              {' · '}卖出 {pair.sellScore} / 买入 {pair.buyScore}
            </p>
          </div>
        </div>
      ) : (
        <p className="rounded-xl bg-white/10 px-4 py-4 text-sm text-indigo-50">
          今天没有通过评分的换基组合（价差不足或候选买入方都在放开中）。
        </p>
      )}
      {notes.length ? (
        <ul className="relative mt-4 space-y-2">
          {notes.map((note) => (
            <li key={`${note.kind}-${note.tag}`} className="flex items-start gap-2 rounded-xl bg-white/10 px-3 py-2 text-xs leading-5 text-indigo-50">
              <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold', NOTE_STYLES[note.kind])}>{note.tag}</span>
              <span className="min-w-0">{note.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="relative mt-3 text-[11px] leading-5 text-indigo-200">
        换基分 = 45% 净价差 + 30% 卖出紧迫度 + 25% 买入吸引力。试运行期间只展示、不发通知，实盘效果见「切换复盘」。
      </p>
    </article>
  );
}

export default RadarScoreHero;
