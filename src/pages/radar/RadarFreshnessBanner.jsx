import { cx } from '../../components/experience-ui.jsx';
import { RADAR_FRESHNESS, computedAtRiskNote } from '../../app/radarModel.js';

/**
 * 顶部状态条（2026-10 重设计）：快照日期 · 新鲜度（异常时）· 下次计算倒计时 · 时段胶囊，压成一行。
 * 快照计算时间 / 本地读取时间 / 定时任务说明已移到「计算控制台」折叠区，这里不再重复。
 * 倒计时不在 aria-live 内，避免每秒朗读。
 */

const FRESHNESS_TONE = {
  [RADAR_FRESHNESS.OK]: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  [RADAR_FRESHNESS.STALE]: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  [RADAR_FRESHNESS.ANOMALY]: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  [RADAR_FRESHNESS.UNKNOWN]: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
};

const SESSION_TONE = {
  'pre-market': 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  'intraday-risk': 'bg-amber-50 text-amber-800 ring-1 ring-amber-300',
  'wait-nav': 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  'post-close': 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  'market-closed': 'bg-slate-100 text-slate-600 ring-1 ring-slate-300',
  'calendar-unconfirmed': 'bg-amber-50 text-amber-800 ring-1 ring-amber-300'
};

export function RadarFreshnessBanner({ data, session, countdown, freshness, className }) {
  const riskNote = computedAtRiskNote(data);
  const showFreshnessPill = !data || freshness.status !== RADAR_FRESHNESS.OK;
  return (
    <section aria-label="数据新鲜度与计算倒计时" className={cx('min-w-0', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 font-semibold text-slate-700 ring-1 ring-slate-200">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
          {data?.date ? `${data.date} 收盘快照` : '基准日期未知'}
        </span>
        {showFreshnessPill && (
          <span className={cx('rounded-full px-2.5 py-1 font-semibold', FRESHNESS_TONE[freshness.status])}>{freshness.label}</span>
        )}
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-slate-500 ring-1 ring-slate-200"
          title={`${countdown.label} · 目标 ${countdown.dateStr} 21:35 · ${countdown.timezone}`}
        >
          <span className="hidden sm:inline">{countdown.label}</span>
          <span className="sm:hidden">下次计算</span>
          <b className="font-mono text-[13px] font-bold text-indigo-700 tabular-nums">{countdown.text}</b>
        </span>
        {countdown.maySkip && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 ring-1 ring-amber-200">该日可能不执行定时计算</span>
        )}
        <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold', SESSION_TONE[session.key] || SESSION_TONE['market-closed'])}>
          <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', session.key === 'intraday-risk' ? 'animate-pulse bg-amber-500' : 'bg-current')} />
          {session.label}
        </span>
      </div>
      {riskNote && (
        <p className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700" role="note">
          {riskNote}
        </p>
      )}
    </section>
  );
}

export default RadarFreshnessBanner;
