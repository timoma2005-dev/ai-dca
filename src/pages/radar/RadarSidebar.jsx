import { cx } from '../../components/experience-ui.jsx';
import { DemoLockedRows, useDemoVisibleRows } from '../../components/rbac/demo-lock.jsx';
import {
  RADAR_PIPELINE_STAGES,
  computedAtEpoch,
  expectedPipelineStage,
  maturityView,
  recentOpportunities,
  shanghaiDateStr,
  shanghaiTimeStr
} from '../../app/radarModel.js';

/**
 * 右栏（plan §4）：计算控制台 → 预期流水线 → 数据成熟度 → 近期机会。
 * 空态时流水线已由左栏空卡片展示，此处不再重复；成熟度与历史缺数据时显示缺数据，不展示假值。
 */

function ConsoleRow({ label, value, valueClass = 'text-slate-700' }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-slate-500">{label}</span>
      <b className={cx('min-w-0 break-words text-right font-semibold tabular-nums', valueClass)}>{value}</b>
    </div>
  );
}

export function RadarSidebar({
  data,
  receivedAt,
  session,
  clockNow,
  computeState,
  onRequestCompute,
  showPipeline
}) {
  const maturity = maturityView(data);
  const recent = recentOpportunities(data);
  // count 类演示：近期套利对多指向不可见的低溢价标的，整块用占位行遮罩。
  const visibleRows = useDemoVisibleRows();
  const computedAt = computedAtEpoch(data);
  const stageIndex = expectedPipelineStage(clockNow);
  const submitting = computeState === 'submitting';
  const hasSnapshot = Boolean(data);

  return (
    <div className="min-w-0 space-y-5">
      <section className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">计算控制台</h3>
          <span className="text-[11px] text-slate-400">时段感知 · 分级确认</span>
        </div>
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <ConsoleRow label="当前时段感知" value={session.label} />
          <ConsoleRow label="当日定时任务" value="工作日 21:35 计划触发，节假日可能跳过" />
          <ConsoleRow label="溢价数据源" value="东方财富 fundmob 收盘价 × 净值自算（净值日期未验证）" />
          <ConsoleRow label="当前快照" value={data?.date ? `${data.date} 正式快照` : '暂无有效快照'} />
          <ConsoleRow label="快照计算时间" value={computedAt == null ? '—' : `${shanghaiDateStr(computedAt)} ${shanghaiTimeStr(computedAt)}`} />
          <ConsoleRow label="本地读取时间" value={receivedAt == null ? '—' : `${shanghaiDateStr(receivedAt)} ${shanghaiTimeStr(receivedAt)}`} />
        </div>
        {onRequestCompute ? (
        <button
          type="button"
          onClick={onRequestCompute}
          disabled={submitting}
          className={cx(
            'mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition-colors',
            submitting
              ? 'cursor-not-allowed bg-indigo-400 opacity-70'
              : 'bg-indigo-600 hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2'
          )}
        >
          {submitting ? '计算中…' : '手动执行雷达计算'}
        </button>
        ) : null}
        <p className="mt-2 text-center text-[11px] leading-5 text-slate-400">
          盘中 / 盘前 / 休市点击将唤起高危风险确认；确认后会覆盖当日正式快照及历史。
        </p>
      </section>

      {showPipeline && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-900">每日 21:35 数据生产流水线</h3>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">预期时间线</span>
          </div>
          <p className="mb-3 text-[11px] leading-5 text-slate-400">
            阶段仅为时间预期，界面无运行日志接口，不显示“已运行 / 已入库”实况；实际结果以快照数据为准。
          </p>
          <ol className="space-y-3">
            {RADAR_PIPELINE_STAGES.map((stage, index) => {
              const reached = stageIndex > index;
              const active = stageIndex === index;
              return (
                <li key={stage.key} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={cx(
                      'mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                      reached
                        ? 'bg-emerald-600 text-white'
                        : active
                          ? 'bg-indigo-600 text-white ring-4 ring-indigo-100'
                          : 'bg-slate-100 text-slate-500'
                    )}
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-slate-800">{stage.title}</span>
                      <span className="font-mono text-[11px] text-slate-400 tabular-nums">{stage.time}</span>
                      <span
                        className={cx(
                          'rounded-full px-1.5 py-px text-[10px] font-semibold',
                          reached ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'
                        )}
                      >
                        {reached ? '已到预期时间' : active ? '预期进行中' : '未到预期时间'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-5 text-slate-500">{stage.desc}</p>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
            {hasSnapshot
              ? `已有 ${data.date} 正式快照，作为流水线产出结果的证据。`
              : '暂无有效快照；流水线完成不代表已产出结果。'}
          </p>
        </section>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">数据成熟度</h3>
          <span className="text-[11px] text-slate-400">历史覆盖 · 权重未启用</span>
        </div>
        {maturity ? (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
                <div className="text-[11px] text-slate-400">特征历史覆盖</div>
                <div className="mt-0.5 text-lg font-bold text-slate-800 tabular-nums">
                  {maturity.days ?? '—'} <span className="text-xs font-normal text-slate-400">天</span>
                </div>
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
                <div className="text-[11px] text-slate-400">已具备权重组</div>
                <div className="mt-0.5 text-lg font-bold text-indigo-600 tabular-nums">
                  {maturity.enabledCount} <span className="text-xs font-normal text-slate-400">组</span>
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{maturity.label || '—'}</span>
              {maturity.dots && <span aria-hidden="true" className="tracking-widest text-indigo-500">{maturity.dots}</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {maturity.groups.map((group) =>
                group.items.length ? (
                  group.items.map((item) => (
                    <span key={`${group.key}-${item}`} className="rounded-lg bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700">
                      {item}
                    </span>
                  ))
                ) : (
                  <span key={group.key} className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] text-slate-400">
                    {group.label}：待积累
                  </span>
                )
              )}
            </div>
            <p className="mt-3 text-[11px] leading-5 text-slate-400">
              当前仅积累历史覆盖，评分权重尚未启用；以上为“已具备的权重组”，不代表已参与评分。
            </p>
          </>
        ) : (
          <p className="text-xs leading-5 text-slate-400">暂无成熟度数据（等待快照与特征历史积累）。</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">近期套利机会</h3>
          <span className="text-[11px] text-slate-400">近 5 个记录</span>
        </div>
        {recent.length ? (
          <ul className="space-y-1.5">
            {recent.map((item) => (
              <li
                key={item.date}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs"
              >
                <span className="font-mono text-slate-400 tabular-nums">{item.date}</span>
                {Number.isFinite(visibleRows) ? (
                  <span className="min-w-0 flex-1 truncate font-semibold text-slate-400">●●●●●● → ●●●●●● 升级查看</span>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">{item.pair}</span>
                )}
                <span className="font-bold text-rose-600 tabular-nums">
                  {item.spread == null ? '—' : `价差 ${item.spread.toFixed(2)}%`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs leading-5 text-slate-400">暂无近期机会记录。</p>
        )}
      </section>
    </div>
  );
}

export default RadarSidebar;
