import { cx } from '../../components/experience-ui.jsx';
import { RADAR_FRESHNESS, computedAtEpoch, computedAtRiskNote, shanghaiDateStr, shanghaiTimeStr } from '../../app/radarModel.js';

/**
 * 顶部新鲜度横条（plan §4）：数据日期、秒级倒计时与时段胶囊。
 * 倒计时不在 aria-live 内，避免每秒朗读；仅日期/时段状态变化被读出。
 */

const FRESHNESS_TONE = {
  [RADAR_FRESHNESS.OK]: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  [RADAR_FRESHNESS.STALE]: 'bg-amber-50 text-amber-700 border border-amber-200',
  [RADAR_FRESHNESS.ANOMALY]: 'bg-rose-50 text-rose-700 border border-rose-200',
  [RADAR_FRESHNESS.UNKNOWN]: 'bg-slate-100 text-slate-600 border border-slate-200'
};

const SESSION_TONE = {
  'pre-market': 'bg-sky-50 text-sky-700 border border-sky-200',
  'intraday-risk': 'bg-amber-50 text-amber-800 border border-amber-300',
  'wait-nav': 'bg-blue-50 text-blue-700 border border-blue-200',
  'post-close': 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  'market-closed': 'bg-slate-100 text-slate-600 border border-slate-300',
  'calendar-unconfirmed': 'bg-amber-50 text-amber-800 border border-amber-300'
};

function formatBeijingDateTime(epochMs) {
  if (epochMs == null) return '—';
  return `${shanghaiDateStr(epochMs)} ${shanghaiTimeStr(epochMs)}`;
}

export function RadarFreshnessBanner({ data, session, countdown, freshness, receivedAt }) {
  const computedAt = computedAtEpoch(data);
  const riskNote = computedAtRiskNote(data);
  const showFreshnessPill = !data || freshness.status !== RADAR_FRESHNESS.OK;
  return (
    <section
      aria-label="数据新鲜度与计算倒计时"
      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:px-5"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-xl bg-slate-100 px-2.5 py-1 text-[13px] font-semibold text-slate-800">
          <span aria-hidden="true">📅</span>
          <span className="break-words">
            {data?.date ? `${data.date} 雷达快照 / 收盘口径，净值日期未验证` : '基准日期未知'}
          </span>
        </span>
        {showFreshnessPill && (
          <span className={cx('rounded-full px-2.5 py-1 text-xs font-semibold', FRESHNESS_TONE[freshness.status])}>
            {freshness.label}
          </span>
        )}
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-slate-600">
          <span>
            {countdown.label}还剩
          </span>
          <b className="rounded-lg bg-indigo-50 px-2 py-0.5 font-mono text-[13px] font-bold text-indigo-700 tabular-nums">
            {countdown.text}
          </b>
          <span className="text-slate-400">
            目标 {countdown.dateStr} 21:35 · {countdown.timezone}
          </span>
          {countdown.maySkip && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
              该日可能不执行定时计算
            </span>
          )}
        </span>
        <span
          className={cx(
            'ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
            SESSION_TONE[session.key] || SESSION_TONE['market-closed']
          )}
        >
          <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', session.key === 'intraday-risk' ? 'animate-pulse bg-amber-500' : 'bg-current')} />
          {session.label}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span>
          快照计算时间：
          <b className="font-medium text-slate-500">{computedAt == null ? '—' : formatBeijingDateTime(computedAt)}</b>
        </span>
        <span>
          本地读取时间：
          <b className="font-medium text-slate-500">{receivedAt == null ? '—' : formatBeijingDateTime(receivedAt)}</b>
        </span>
        <span>定时任务：工作日 21:35 计划触发，节假日可能跳过</span>
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
