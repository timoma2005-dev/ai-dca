import { useMemo, useState } from 'react';
import { cx } from '../../components/experience-ui.jsx';
import { DemoLockedValue, useDemoActive } from '../../components/rbac/demo-lock.jsx';
import { hasPaper, paperSummary, PAPER_COST_PCT, PAPER_HOLD_DAYS, PAPER_KINDS } from '../../app/radarPaper.js';

/**
 * 纸面记录：雷达每天的换基建议「如果照做」的模拟切换，统计切换收益与胜率。
 * 口径见 src/app/radarPaper.js：T+1 收盘成交，持有 k 日，扣 0.15% 成本，收益 = 换了比不换多赚多少。
 */

const PAGE = 30;

function signed(v, digits = 2, unit = '') {
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}${unit}`;
}

function tone(v) {
  if (!Number.isFinite(v) || v === 0) return 'text-slate-600';
  return v > 0 ? 'text-rose-600' : 'text-emerald-600';
}

function Seg({ value, options, onChange, label }) {
  return (
    <div className="inline-flex rounded-xl bg-slate-100 p-0.5" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={String(key)}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={cx(
            'min-h-8 rounded-lg px-3 text-xs font-semibold transition-colors',
            value === key ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, value, sub, valueTone = 'text-slate-900' }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-100 bg-white px-3 py-2.5">
      <p className="truncate text-[11px] text-slate-400">{label}</p>
      <p className={cx('mt-0.5 truncate text-lg font-extrabold tabular-nums', valueTone)}>{value}</p>
      {sub ? <p className="truncate text-[11px] text-slate-400">{sub}</p> : null}
    </div>
  );
}

function StatsRow({ title, stats, hold }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-bold text-slate-600">
        {title}
        <span className="ml-1.5 font-normal text-slate-400">
          {stats.done} 笔已结算{stats.pending ? ` · ${stats.pending} 笔进行中` : ''}
        </span>
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="胜率" value={stats.winRate == null ? '—' : `${stats.winRate}%`} sub="扣成本后为正的比例" valueTone={stats.winRate == null ? 'text-slate-400' : stats.winRate >= 50 ? 'text-rose-600' : 'text-emerald-600'} />
        <Tile label="平均每笔" value={signed(stats.avgRet, 2, '%')} sub={`中位 ${signed(stats.medianRet, 2, '%')}`} valueTone={tone(stats.avgRet)} />
        <Tile label="逐笔累计" value={signed(stats.sumRet, 1, '%')} sub={`最好 ${signed(stats.best, 2)} · 最差 ${signed(stats.worst, 2)}`} valueTone={tone(stats.sumRet)} />
        <Tile label="溢价收敛" value={signed(stats.avgConvergence, 2, 'pp')} sub="买入减卖出的溢价变化" valueTone={tone(stats.avgConvergence)} />
      </div>
    </div>
  );
}

function StatusCell({ r }) {
  if (r.status === 'pending') return <span className="text-[11px] text-slate-400">进行中</span>;
  if (r.status === 'nodata') return <span className="text-[11px] text-slate-400">缺数据</span>;
  return <b className={cx('tabular-nums', tone(r.ret))}>{signed(r.ret, 2, '%')}</b>;
}

function SourceTag({ backfill }) {
  return backfill ? (
    <span className="rounded bg-slate-100 px-1 py-px text-[10px] text-slate-500">回算</span>
  ) : (
    <span className="rounded bg-indigo-50 px-1 py-px text-[10px] font-semibold text-indigo-600">实时</span>
  );
}

export default function RadarPaperPanel({ data }) {
  const demo = useDemoActive();
  const [kind, setKind] = useState('pair');
  const [hold, setHold] = useState(5);
  const [dedupe, setDedupe] = useState(true);
  const [source, setSource] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const summary = useMemo(() => paperSummary(data, { kind, hold, dedupe }), [data, kind, hold, dedupe]);

  if (!hasPaper(data)) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
        暂无纸面记录：等下一次雷达计算（每个交易日 21:35）写入后即可查看。
      </section>
    );
  }

  const list = summary.records
    .filter((r) => (source === 'live' ? !r.backfill : source === 'backfill' ? r.backfill : true))
    .slice()
    .reverse();

  return (
    <section data-testid="radar-paper" className="min-w-0 space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Seg label="建议类型" value={kind} onChange={(v) => { setKind(v); setShown(PAGE); }} options={Object.entries(PAPER_KINDS)} />
          <Seg label="持有期" value={hold} onChange={setHold} options={PAPER_HOLD_DAYS.map((d) => [d, `${d} 日`])} />
          <label className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-xl bg-slate-100 px-3 text-xs font-semibold text-slate-600">
            <input type="checkbox" className="accent-indigo-600" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} />
            同一建议连续出现只记首日
          </label>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <StatsRow title="实时（上线后每天的真实建议）" stats={summary.live} hold={hold} />
          <StatsRow title="回算（上线前用当时数据重算）" stats={summary.backfill} hold={hold} />
        </div>
        <p className="mt-3 text-[11px] leading-5 text-slate-400">
          口径：建议在 T 日收盘后算出，按 T+1 收盘价切换，持有 {hold} 个交易日后比较；切换收益 = 买入方涨幅 ÷ 卖出方涨幅 − 1 − {PAPER_COST_PCT}% 成本，即「换了比不换多赚多少」。
          回算记录用的是重算后的分数，参考意义低于实时记录。
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <p className="text-sm font-bold text-slate-800">
            逐笔记录 <span className="ml-1 text-xs font-normal text-slate-400">{list.length} 笔 · 新的在上</span>
          </p>
          <Seg label="来源" value={source} onChange={(v) => { setSource(v); setShown(PAGE); }} options={[['all', '全部'], ['live', '实时'], ['backfill', '回算']]} />
        </div>
        {demo ? (
          <div className="px-5 py-8 text-center"><DemoLockedValue className="rounded-lg bg-slate-100 px-3 py-1 text-sm text-slate-500">●●●● 升级查看逐笔记录</DemoLockedValue></div>
        ) : list.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-400">{source === 'live' ? '实时记录从 2026-10-29 起累积，暂时还没有。' : '没有记录。'}</p>
        ) : (
          <>
            <table className="hidden w-full text-left text-xs sm:table">
              <thead className="text-[11px] text-slate-400">
                <tr className="border-b border-slate-100">
                  <th className="px-5 py-2 font-normal">信号日</th>
                  <th className="px-2 py-2 font-normal">卖出 → 买入</th>
                  <th className="px-2 py-2 text-right font-normal">信号溢价</th>
                  <th className="px-2 py-2 text-right font-normal">{kind === 'pair' ? '换基分' : '分数差'}</th>
                  <th className="px-2 py-2 font-normal">成交 → 结算</th>
                  <th className="px-2 py-2 text-right font-normal">溢价收敛</th>
                  <th className="px-5 py-2 text-right font-normal">{hold} 日切换收益</th>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, shown).map((r) => (
                  <tr key={`${r.date}-${r.sell.code}-${r.buy.code}`} className="border-b border-slate-50 last:border-0">
                    <td className="whitespace-nowrap px-5 py-2 tabular-nums text-slate-700">{r.date} <SourceTag backfill={r.backfill} /></td>
                    <td className="whitespace-nowrap px-2 py-2"><b className="text-slate-800">{r.sell.short}</b><span className="mx-1 text-slate-300">→</span><b className="text-slate-800">{r.buy.short}</b></td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-slate-500">{r.sell.premium?.toFixed(2)}% / {r.buy.premium?.toFixed(2)}%</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-700">{r.score ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-slate-400">{r.entryDate ? r.entryDate.slice(5) : '—'} → {r.exitDate ? r.exitDate.slice(5) : '—'}</td>
                    <td className={cx('px-2 py-2 text-right tabular-nums', tone(r.convergence))}>{signed(r.convergence, 2, 'pp')}</td>
                    <td className="px-5 py-2 text-right"><StatusCell r={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-slate-50 sm:hidden">
              {list.slice(0, shown).map((r) => (
                <li key={`${r.date}-${r.sell.code}-${r.buy.code}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm"><b className="text-slate-800">{r.sell.short}</b><span className="mx-1 text-slate-300">→</span><b className="text-slate-800">{r.buy.short}</b> <SourceTag backfill={r.backfill} /></p>
                    <p className="mt-0.5 text-[11px] tabular-nums text-slate-400">
                      {r.date} · {r.sell.premium?.toFixed(2)}% / {r.buy.premium?.toFixed(2)}% · {kind === 'pair' ? '换基分' : '分数差'} {r.score ?? '—'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-sm"><StatusCell r={r} /></div>
                </li>
              ))}
            </ul>
            {list.length > shown ? (
              <button type="button" onClick={() => setShown((v) => v + PAGE)} className="w-full border-t border-slate-100 py-2.5 text-xs font-semibold text-indigo-600 hover:bg-slate-50">
                再显示 {Math.min(PAGE, list.length - shown)} 笔
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
