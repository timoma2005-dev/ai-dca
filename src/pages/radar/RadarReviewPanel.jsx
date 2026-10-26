import { useEffect, useMemo, useState } from 'react';
import { cx } from '../../components/experience-ui.jsx';
import { readLedgerState } from '../../app/holdingsLedger.js';
import { loadCloudSession } from '../../app/authSession.js';
import { pullHoldingTransactions } from '../../app/holdingTransactionsSync.js';
import { reviewFromLedger } from '../../app/radarReview.js';
import { useDemoActive } from '../../components/rbac/demo-lock.jsx';

/**
 * 切换复盘：用账户流水里配对的 SELL/BUY（switchPairId）算每次切换「换了比不换多赚多少」，
 * 并拆出钱赚 / 亏在哪一步。数据只在本机计算，不上传。
 */

function pctText(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

function toneOf(v) {
  if (!Number.isFinite(v) || v === 0) return 'text-slate-600';
  return v > 0 ? 'text-rose-600' : 'text-emerald-600';
}

function Tile({ label, value, sub, tone = 'text-slate-900' }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-100 bg-white px-3 py-2.5">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className={cx('mt-0.5 truncate text-lg font-extrabold tabular-nums', tone)}>{value}</p>
      {sub ? <p className="truncate text-[11px] text-slate-400">{sub}</p> : null}
    </div>
  );
}

function Sparkline({ path }) {
  if (!path || path.length < 2) return null;
  const vals = path.map((p) => p.rel);
  const min = Math.min(0, ...vals); const max = Math.max(0, ...vals);
  const range = max - min || 1;
  const W = 240; const H = 44;
  const x = (i) => (i / (path.length - 1)) * W;
  const y = (v) => H - 4 - ((v - min) / range) * (H - 8);
  const d = path.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.rel).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-11 w-full" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke={last >= 0 ? '#e11d48' : '#059669'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Attribution({ parts }) {
  const max = Math.max(0.5, ...parts.map((p) => Math.abs(p.value || 0)));
  return (
    <ul className="space-y-1.5">
      {parts.map((p) => (
        <li key={p.key} className="grid grid-cols-[7.5rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-[11px]">
          <span className={cx('text-slate-600', p.context && 'text-slate-400')}>{p.label}{p.context ? '*' : ''}</span>
          <span className="relative h-2 rounded-full bg-slate-100">
            <span className="absolute inset-y-0 left-1/2 w-px bg-slate-300" />
            {Number.isFinite(p.value) ? (
              <span
                className={cx('absolute inset-y-0 rounded-full', p.value >= 0 ? 'bg-rose-400' : 'bg-emerald-500')}
                style={p.value >= 0
                  ? { left: '50%', width: `${(p.value / max) * 50}%` }
                  : { right: '50%', width: `${(-p.value / max) * 50}%` }}
              />
            ) : null}
          </span>
          <b className={cx('text-right tabular-nums', toneOf(p.value))}>{pctText(p.value)}</b>
        </li>
      ))}
    </ul>
  );
}

function RoundCard({ round, expanded, onToggle }) {
  if (round.status !== 'ok') {
    return (
      <li className="rounded-xl border border-dashed border-slate-200 px-3 py-2.5 text-xs text-slate-500">
        <b className="text-slate-700">{round.date}</b> 卖 {round.sell.short} → 买 {round.buy.short}：{round.note}
      </li>
    );
  }
  return (
    <li className={cx('rounded-xl border px-3 py-3', expanded ? 'border-indigo-300 bg-indigo-50/40' : 'border-slate-100 bg-white')}>
      <button type="button" className="w-full text-left" onClick={onToggle} aria-expanded={expanded}>
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
            <span className="text-[11px] tabular-nums text-slate-400">{round.date.slice(5)}</span>
            <b className="text-slate-800">卖 {round.sell.short} → 买 {round.buy.short}</b>
            <span className={cx('rounded-md px-1.5 py-0.5 text-[10px] font-bold', round.open ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500')}>
              {round.open ? `持有中 ${round.holdDays ?? '—'} 天` : `已切出 ${round.endDate.slice(5)}`}
            </span>
            {round.reason ? <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{round.reason.label}</span> : null}
          </span>
          <span className="text-right">
            <b className={cx('text-lg font-extrabold tabular-nums', toneOf(round.netPct))}>{pctText(round.netPct)}%</b>
            <span className="block text-[10px] text-slate-400">
              比不换{round.extraYuan != null ? `${round.extraYuan >= 0 ? '多赚' : '少赚'} ¥${Math.abs(round.extraYuan).toLocaleString('zh-CN')}` : '的相对收益'}
            </span>
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="mt-3 grid gap-4 border-t border-slate-100 pt-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="mb-2 text-[11px] font-bold text-slate-700">收益拆解（百分点）</p>
            <Attribution parts={round.parts} />
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              *执行损耗 = 成交时的溢价差 {pctText(round.execSpread)} − 前一晚信号价差 {pctText(round.signalSpread)}，单独列示、不计入合计。
            </p>
          </div>
          <div className="min-w-0 space-y-2 text-[11px] text-slate-600">
            <p className="font-bold text-slate-700">持有期相对收益</p>
            <Sparkline path={round.path} />
            <p>
              卖出 {round.sell.code} @ {round.sell.price.toFixed(3)} → 期末 {round.aEnd?.toFixed(3)}；
              买入 {round.buy.code} @ {round.buy.price.toFixed(3)} → {round.open ? '最新收盘' : '切出价'} {round.bEnd?.toFixed(3)}
            </p>
            <p>
              当时换基分 <b className="tabular-nums">{round.signalScore ?? '—'}</b> · 信号兑现率 <b className="tabular-nums">{round.realization != null ? `${Math.round(round.realization * 100)}%` : '—'}</b>
            </p>
            {round.events.length ? (
              <p className="text-amber-700">
                期间份额事件：{round.events.map((e) => `${e.code} ${e.date.slice(5)} ${e.kind === 'relax' ? '放开' : '收紧'}`).join('，')}
              </p>
            ) : null}
            {round.reason ? <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-amber-800">主因：{round.reason.label}{round.reason.detail ? `——${round.reason.detail}` : ''}</p> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function RadarReviewPanel({ data }) {
  const demo = useDemoActive();
  const [txs, setTxs] = useState(() => {
    try { return readLedgerState().transactions || []; } catch { return []; }
  });
  const [syncing, setSyncing] = useState(false);
  const [openId, setOpenId] = useState('');

  useEffect(() => {
    if (demo) return undefined;
    let cancelled = false;
    const session = loadCloudSession();
    if (!session?.accessToken) return undefined;
    setSyncing(true);
    pullHoldingTransactions({ session })
      .catch(() => {})
      .finally(() => {
        if (cancelled) return;
        setSyncing(false);
        try { setTxs(readLedgerState().transactions || []); } catch { /* 保留已有流水 */ }
      });
    return () => { cancelled = true; };
  }, [demo]);

  const { rounds, summary } = useMemo(() => reviewFromLedger(demo ? [] : txs, data), [txs, data, demo]);

  if (demo) {
    return <p className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center text-sm text-slate-500">演示模式不读取账户流水。登录后，在持仓里用「切换」记录的买卖会自动出现在这里。</p>;
  }

  return (
    <div data-testid="radar-review" className="min-w-0 space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">实盘切换复盘</h3>
          <span className="text-[11px] text-slate-400">{syncing ? '同步流水中…' : `收盘口径 · 截至 ${data?.series?.dates?.at(-1) || data?.date || '—'}`}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="切换次数" value={summary.total} sub={`可复盘 ${summary.reviewed}`} />
          <Tile label="进行中" value={summary.open} />
          <Tile label="胜率" value={summary.winRate != null ? `${Math.round(summary.winRate * 100)}%` : '—'} sub="相对收益 > 0" />
          <Tile label="平均相对收益" value={summary.avgNet != null ? `${pctText(summary.avgNet)}%` : '—'} tone={toneOf(summary.avgNet)} sub={summary.extraYuan ? `合计 ${summary.extraYuan >= 0 ? '+' : '−'}¥${Math.abs(summary.extraYuan).toLocaleString('zh-CN')}` : ''} />
          <Tile label="信号兑现率" value={summary.realization != null ? `${Math.round(summary.realization * 100)}%` : '—'} sub="实得 ÷ 信号价差" />
          <Tile label="最常见亏损原因" value={summary.topReason ? summary.topReason.label : '—'} sub={summary.topReason ? `${summary.topReason.count} 次` : '暂无亏损'} tone="text-amber-700" />
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h3 className="mb-3 text-sm font-bold text-slate-900">每次切换</h3>
        {rounds.length ? (
          <ul className="space-y-2">
            {rounds.map((round) => (
              <RoundCard key={round.id} round={round} expanded={openId === round.id} onToggle={() => setOpenId((cur) => (cur === round.id ? '' : round.id))} />
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-xs leading-6 text-slate-500">
            还没有可复盘的切换。在持仓里用「切换」记一笔（卖出与买入会自动配对），或在竞价看板点「记一笔切换」，之后会出现在这里。
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">换基分 vs 实际胜率</h3>
          <span className="text-[11px] text-slate-400">攒够 20 次后用于校准评分权重</span>
        </div>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[11px] text-slate-400"><th className="py-1.5 font-medium">当时换基分</th><th className="py-1.5 font-medium">次数</th><th className="py-1.5 font-medium">胜率</th><th className="py-1.5 font-medium">平均相对收益</th></tr>
          </thead>
          <tbody>
            {summary.buckets.map((b) => (
              <tr key={b.label} className="border-t border-slate-50">
                <td className="py-1.5 font-semibold text-slate-700">{b.label}</td>
                <td className="py-1.5 tabular-nums">{b.count}</td>
                <td className="py-1.5 tabular-nums">{b.winRate != null ? `${Math.round(b.winRate * 100)}%` : '—'}</td>
                <td className={cx('py-1.5 tabular-nums', toneOf(b.avgNet))}>{b.avgNet != null ? `${pctText(b.avgNet)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] leading-5 text-slate-400">
          相对收益 = 买入标的涨幅 ÷ 卖出标的同期涨幅 − 1 − 佣金（流水没有手续费时按单边万一估算）。价格与净值取雷达每日收盘快照，只在本机计算。
        </p>
      </section>
    </div>
  );
}

export default RadarReviewPanel;
