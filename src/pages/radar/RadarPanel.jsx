import { useEffect, useMemo, useState } from 'react';
import { canAccessMenuFromSession, isAnalyticsAdmin } from '../../app/analytics.js';
import { countdownView, radarSession, snapshotFreshness } from '../../app/radarModel.js';
import { cx } from '../../components/experience-ui.jsx';
import { useDemoActive, useRequiredRoleLabel } from '../../components/rbac/demo-lock.jsx';
import { RADAR_COMPUTE_STATE, useRadarData } from './useRadarData.js';
import { useRadarClock } from './useRadarClock.js';
import RadarFreshnessBanner from './RadarFreshnessBanner.jsx';
import RadarOpportunityCards from './RadarOpportunityCards.jsx';
import RadarRanking from './RadarRanking.jsx';
import RadarSidebar from './RadarSidebar.jsx';
import RadarComputeDialog from './RadarComputeDialog.jsx';
import RadarScoreHero from './RadarScoreHero.jsx';
import RadarScoreTable from './RadarScoreTable.jsx';
import RadarReviewPanel from './RadarReviewPanel.jsx';
import { hasScoring } from '../../app/radarScoreModel.js';

/**
 * 雷达页编排（plan §4）：RadarPanel 只负责编排与状态分流，
 * 表现层在 src/pages/radar/*，纯函数在 src/app/radarModel.js。
 * 评分 v2 快照：单列堆叠（换基建议 → 评分表 → 折叠控制台），份额动态卡已下线（2026-10 重设计）；
 * 旧快照（无 scoring）仍走桌面 7:4 双列。顶部保留同一计算入口。
 */

function SkeletonBlock({ className }) {
  return (
    <div
      aria-hidden="true"
      className={cx('animate-pulse rounded-2xl bg-gradient-to-r from-slate-100 via-slate-200 to-slate-100 bg-[length:200%_100%]', className)}
    />
  );
}

function RadarSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] items-start">
        <div className="min-w-0 space-y-5">
          <SkeletonBlock className="h-52" />
          <SkeletonBlock className="h-36" />
          <SkeletonBlock className="h-72" />
        </div>
        <div className="min-w-0 space-y-5">
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-56" />
          <SkeletonBlock className="h-40" />
        </div>
      </div>
      <p className="text-center text-xs text-slate-400">正在读取雷达快照…</p>
    </div>
  );
}

export default function RadarPanel({ session }) {
  // 读取：menu:adminRadar:access（所需角色见服务端菜单 requiredRole，当前 SVIP）；手动计算：管理员（服务端 api:nasdaq-radar-compute 再次校验）。
  // 演示模式：只读可见（计算按钮仍只给管理员，见 canCompute）。
  const demo = useDemoActive();
  const roleLabel = useRequiredRoleLabel('adminRadar', 'SVIP');
  const isAdmin = isAnalyticsAdmin(session) || canAccessMenuFromSession(session, 'adminRadar') || demo;
  const canCompute = isAnalyticsAdmin(session);
  const clockNow = useRadarClock({ enabled: isAdmin });
  const radar = useRadarData({ enabled: isAdmin });
  const [view, setView] = useState('radar');

  const sessionInfo = useMemo(() => radarSession(clockNow), [clockNow]);
  const countdown = useMemo(() => countdownView(clockNow), [clockNow]);
  const freshness = useMemo(() => snapshotFreshness(radar.data, clockNow), [radar.data, clockNow]);

  const hasSnapshot = Boolean(radar.data);
  const firstLoading = radar.readState === 'loading' && !hasSnapshot;
  const readFailedWithoutData = radar.readState === 'error' && !hasSnapshot;
  const emptyWithoutData = radar.readState === 'empty' && !hasSnapshot;
  const showPipelineInSidebar = !emptyWithoutData;
  const submitting = radar.computeState === RADAR_COMPUTE_STATE.SUBMITTING;

  // 弹窗打开期间时段 / 日期变化 → 按当前时间重新分流并复位风险勾选（plan §5.1）；
  // 已开常规弹窗跨入盘中后不会直接提交（提交前还会再校验一次）。
  useEffect(() => {
    if (!radar.isDialogOpen || !canCompute) return;
    radar.requestCompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在时段键或开合变化时重分流
  }, [sessionInfo.key, radar.isDialogOpen, canCompute]);

  if (!isAdmin) {
    return <p className="p-5 text-sm text-slate-500">当前账号没有雷达权限（需要 {roleLabel}）。</p>;
  }

  const leftColumn = firstLoading ? (
    <RadarSkeleton />
  ) : readFailedWithoutData ? (
    <section
      role="alert"
      className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-8 text-center sm:px-6"
    >
      <p className="text-sm font-semibold text-rose-700">雷达快照读取失败</p>
      <p className="mt-1 text-xs leading-5 text-rose-600">{radar.readError}</p>
      <button
        type="button"
        onClick={radar.retryRead}
        disabled={radar.readPending}
        className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {radar.readPending ? '读取中…' : '重新读取'}
      </button>
    </section>
  ) : emptyWithoutData ? (
    <section className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center sm:px-6">
      <span
        aria-hidden="true"
        className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-2xl text-indigo-600"
      >
        ⓘ
      </span>
      <h3 className="text-base font-bold text-slate-800">今日雷达数据尚未计算</h3>
      <p className="mx-auto mt-2 max-w-xl text-[13px] leading-6 text-slate-500">
        套利雷达基于每日收盘价与各基金公司披露的单位净值计算。为避免盘中伪溢价误导决策，
        系统每日仅在净值披露完备后的计划窗口自动执行一次；当前没有可展示的有效快照。
      </p>
      <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-left">
        <p className="mb-3 text-[13px] font-bold text-slate-800">每日 21:35 数据生产流水线（预期时间线）：</p>
        <ol className="space-y-2.5 text-[13px] text-slate-600">
          <li>1. 场内交易收盘 —— 15:00，锁定当日收盘价。</li>
          <li>2. 净值通常披露 —— 21:00 ~ 21:30，披露时间可能延迟。</li>
          <li>3. 计划触发 —— 21:35，工作日定时触发；节假日可能跳过。</li>
          <li>4. 预期完成 —— 约 21:36，写入正式快照与历史。</li>
        </ol>
        <p className="mt-3 border-t border-slate-200 pt-2 text-[11px] leading-5 text-slate-400">
          阶段为时间预期，界面无运行日志接口；只有有效快照能证明已有结果。
        </p>
      </div>
      {canCompute ? <button
        type="button"
        onClick={radar.requestCompute}
        disabled={submitting}
        className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? '计算中…' : '手动触发计算（受时段分级保护）'}
      </button> : null}
    </section>
  ) : (
    <div className="min-w-0 space-y-5">
      {radar.readState === 'error' && hasSnapshot && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="min-w-0 text-xs leading-5 text-rose-700">
            本次读取失败：{radar.readError}。以下保留上次有效快照，不代表最新数据。
          </p>
          <button
            type="button"
            onClick={radar.retryRead}
            disabled={radar.readPending}
            className="inline-flex min-h-9 shrink-0 items-center rounded-lg border border-rose-300 bg-white px-3 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {radar.readPending ? '读取中…' : '重新读取'}
          </button>
        </div>
      )}
      {radar.readState === 'empty' && hasSnapshot && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
          本次读取未返回快照（远端暂无数据）；以下展示上次有效数据，不会自动视为“新鲜”。
        </div>
      )}
      {hasSnapshot && hasScoring(radar.data) ? (
        <>
          <RadarScoreHero data={radar.data} />
          <RadarScoreTable data={radar.data} />
        </>
      ) : (
        <>
          {hasSnapshot && <RadarOpportunityCards data={radar.data} />}
          <RadarRanking data={radar.data} selectedCode={radar.selectedCode} onToggleSelected={radar.toggleSelected} />
        </>
      )}
    </div>
  );

  return (
    <div className="min-w-0 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold tracking-tight text-slate-900 sm:text-xl">纳指 ETF 套利雷达</h2>
            <span className="rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">测试中</span>
            <span className="hidden text-xs text-slate-400 sm:inline">VIP 及以上可见</span>
          </div>
        </div>
        {canCompute ? <button
          type="button"
          onClick={radar.requestCompute}
          disabled={submitting}
          className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 text-xs font-semibold text-white shadow-sm shadow-indigo-200/70 transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-10 sm:px-4 sm:text-[13px]"
        >
          {submitting ? '计算中…' : '手动触发计算'}
        </button> : null}
      </header>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="inline-flex self-start rounded-xl bg-slate-100 p-0.5" role="tablist" aria-label="雷达视图">
          {[['radar', '今日雷达'], ['review', '切换复盘']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={cx(
                'min-h-8 rounded-lg px-4 text-xs font-semibold transition-colors',
                view === key ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <RadarFreshnessBanner
          data={radar.data}
          session={sessionInfo}
          countdown={countdown}
          freshness={freshness}
          className="lg:flex lg:justify-end"
        />
      </div>

      {radar.notice && (
        <div
          role="status"
          aria-live="polite"
          className={cx(
            'rounded-2xl border px-4 py-3 text-sm font-medium',
            radar.noticeKind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          )}
        >
          {radar.notice}
          {radar.noticeKind === 'failure' && (
            <button
              type="button"
              onClick={radar.retryRead}
              className="ml-3 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700"
            >
              重新读取核实
            </button>
          )}
        </div>
      )}

      {view === 'review' ? (
        <RadarReviewPanel data={radar.data} />
      ) : firstLoading ? (
        leftColumn
      ) : hasSnapshot && hasScoring(radar.data) ? (
        <div data-testid="radar-dashboard-stack" className="min-w-0 space-y-5">
          {leftColumn}
          <details data-testid="radar-sidebar-fold" className="group rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-bold text-slate-700 sm:px-5">
              <span>计算控制台 · 数据流水线 · 成熟度 · 近期机会</span>
              <span className="text-xs font-normal text-slate-400 group-open:hidden">展开</span>
              <span className="hidden text-xs font-normal text-slate-400 group-open:inline">收起</span>
            </summary>
            <div className="border-t border-slate-100 p-3">
              <RadarSidebar
                className="grid gap-5 space-y-0 lg:grid-cols-2"
                data={radar.data}
                receivedAt={radar.receivedAt}
                session={sessionInfo}
                clockNow={clockNow}
                computeState={radar.computeState}
                onRequestCompute={canCompute ? radar.requestCompute : undefined}
                showPipeline={showPipelineInSidebar}
              />
            </div>
          </details>
        </div>
      ) : (
        <div
          data-testid="radar-dashboard-grid"
          className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] items-start"
        >
          <div className="min-w-0">{leftColumn}</div>
          <div className="min-w-0 space-y-5">
            <RadarSidebar
              data={radar.data}
              receivedAt={radar.receivedAt}
              session={sessionInfo}
              clockNow={clockNow}
              computeState={radar.computeState}
              onRequestCompute={canCompute ? radar.requestCompute : undefined}
              showPipeline={showPipelineInSidebar}
            />
          </div>
        </div>
      )}

      <RadarComputeDialog
        computeState={radar.computeState}
        session={sessionInfo}
        riskAcknowledged={radar.riskAcknowledged}
        onRiskAcknowledgedChange={radar.setRiskAcknowledged}
        onCancel={radar.closeComputeDialog}
        onSubmit={radar.submitCompute}
      />
    </div>
  );
}
