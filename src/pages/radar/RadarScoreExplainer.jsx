// 评分「为什么是这个分」说明卡：移植 Detent「Metric explainer」（detentui.com，MIT）的做法——
// 大数字 + 一句话变化 + 一段原因 + 按贡献排好的分项；指到某一分项，大数字变成「去掉这一项」后的分数。
// 只读 Worker 快照里的 scoring / series，不在前端重新打分。
import { useEffect, useId, useState } from 'react';
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from 'motion/react';
import { cx } from '../../components/experience-ui.jsx';
import { rankRadarEtfs } from '../../app/radarModel.js';
import { scoreBreakdown, shortName } from '../../app/radarScoreModel.js';
import { useDemoVisibleRows } from '../../components/rbac/demo-lock.jsx';

const SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 };
const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(Math.abs(n) >= 10 || Number.isInteger(n) ? 0 : 1);
const signed = (n) => `${n < 0 ? '−' : '+'}${fmt1(Math.abs(n))}`;

function RollingNumber({ value, className = '' }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value);
  const [shown, setShown] = useState(value);
  useMotionValueEvent(mv, 'change', (v) => setShown(v));
  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return undefined;
    }
    const run = animate(mv, value, { type: 'spring', stiffness: 260, damping: 30 });
    return () => run.stop();
  }, [value, mv, reduce]);
  return <span className={cx('tabular-nums', className)}>{Math.round(shown)}</span>;
}

/** 上一交易日的值：series 末位若是今天就取倒数第二个，否则取最后一个 */
function previousOf(series, arr, date) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const dates = series?.dates || [];
  const lastIsToday = dates.length && dates[dates.length - 1] === date;
  const idx = lastIsToday ? arr.length - 2 : arr.length - 1;
  for (let i = idx; i >= 0 && i >= idx - 3; i -= 1) {
    if (arr[i] !== null && arr[i] !== undefined) return { value: arr[i], date: dates[i] };
  }
  return null;
}

export function buildExplainerMetrics(data, { buyHidden = false } = {}) {
  const scoring = data?.scoring;
  const pair = scoring?.recommendedPair;
  if (!pair) return [];
  const series = data?.series;
  const sellName = shortName(pair.sell.code, pair.sell.name);
  const buyName = buyHidden ? '买入方' : shortName(pair.buy.code, pair.buy.name);
  const w = scoring.weights?.switch || { spread: 45, sell: 30, buy: 25 };
  const prevPairRow = previousOf(series, series?.paper?.pair, data?.date);
  const prevPair = Array.isArray(prevPairRow?.value) ? prevPairRow.value : null;
  const samePair = prevPair && prevPair[0] === pair.sell.code && prevPair[1] === pair.buy.code;
  const spreadPhrase = `净价差 ${pair.netSpread?.toFixed(2)}pp`;
  const reasons = (pair.reasons || []).filter((r) => !(buyHidden && r.includes(pair.buy.name)));
  const switchMetric = {
    id: 'switch',
    name: '换基分',
    value: pair.score,
    previous: prevPair && Number.isFinite(prevPair[2]) ? prevPair[2] : null,
    vs: prevPair ? (samePair ? '上个交易日' : `上个交易日（当时是 ${shortName(prevPair[0])}→${shortName(prevPair[1])}）`) : '',
    reason: [
      `卖 ${sellName}、${buyHidden ? '买入方升级后可见' : `买 ${buyName}`}，溢价差 ${pair.spread?.toFixed(2)}pp，扣掉点差和佣金 ${pair.costPct?.toFixed(2)}% 后${spreadPhrase}。`,
      reasons.length ? `${reasons.join('；')}。` : '',
    ].join(''),
    drivers: [
      { name: '净价差', note: `${spreadPhrase} · 价差分 ${pair.spreadScore ?? '—'} × ${w.spread}%`, amount: ((pair.spreadScore ?? 0) * w.spread) / 100, phrase: spreadPhrase },
      { name: '卖出紧迫度', note: `${sellName} 卖出分 ${pair.sellScore} × ${w.sell}%`, amount: (pair.sellScore * w.sell) / 100, phrase: `卖 ${sellName}` },
      Number.isFinite(pair.buyScore)
        ? { name: '买入吸引力', note: `${buyName} 买入分 ${pair.buyScore} × ${w.buy}%`, amount: (pair.buyScore * w.buy) / 100, phrase: buyHidden ? undefined : `买 ${buyName}` }
        : {
            name: '买入吸引力',
            note: `买入方明细升级后可见 · × ${w.buy}%`,
            amount: Math.max(0, pair.score - ((pair.spreadScore ?? 0) * w.spread) / 100 - (pair.sellScore * w.sell) / 100),
          },
    ],
    basis: `换基分 = ${w.spread}% 净价差 + ${w.sell}% 卖出紧迫度 + ${w.buy}% 买入吸引力 · 试运行，只展示不发通知`,
  };
  const sideMetric = (side) => {
    const code = side === 'sell' ? pair.sell.code : pair.buy.code;
    const item = scoring.etfs?.[code];
    if (!item) return null;
    const rows = scoreBreakdown({ ...item, weights: scoring.weights }, side).filter((r) => Number.isFinite(r.points));
    const prev = previousOf(series, series?.etfs?.[code]?.[side], data?.date);
    const name = side === 'sell' ? sellName : buyName;
    const top = rows.slice().sort((a, b) => b.points - a.points)[0];
    return {
      id: side,
      name: side === 'sell' ? '卖出分' : '买入分',
      value: side === 'sell' ? item.sellScore : item.buyScore,
      previous: Number.isFinite(prev?.value) ? prev.value : null,
      vs: prev ? '上个交易日' : '',
      reason: `${name}${side === 'sell' ? '该不该卖' : '值不值得买'}，看溢价在自身 60 日里的位置、份额额度和流动性。${top ? `这次「${top.label}」拿分最多（${fmt1(top.points)} / ${top.max}）。` : ''}${item.sellTag && side === 'sell' ? `${item.sellTag}，卖出分至少 90。` : ''}${item.buyBlocked && side === 'buy' ? `${item.buyBlocked}，买入分封顶 20。` : ''}`,
      drivers: rows.map((r) => ({ name: r.label, note: `${r.detail} · 满分 ${r.max}`, amount: r.points })),
      basis: '单品分 = 自身 60 日分位 60 + 份额 25 + 流动性 15（同类溢价只参考不计分）',
    };
  };
  return [switchMetric, sideMetric('sell'), buyHidden ? null : sideMetric('buy')].filter(Boolean);
}

export function RadarScoreExplainer({ data }) {
  const visibleRows = useDemoVisibleRows();
  const pair = data?.scoring?.recommendedPair;
  const buyHidden = Boolean(pair && !rankRadarEtfs(data).slice(0, visibleRows).some((etf) => etf.code === pair.buy.code));
  const metrics = buildExplainerMetrics(data, { buyHidden });
  const [at, setAt] = useState('switch');
  const [aim, setAim] = useState(null);
  const reduce = useReducedMotion();
  const group = useId();
  const m = metrics.find((x) => x.id === at) || metrics[0];
  if (!m) return null;
  const drivers = m.drivers.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const lit = aim && aim.metric === m.id ? aim.name : null;
  const without = drivers.find((d) => d.name === lit);
  const point = (name) => setAim(name ? { metric: m.id, name } : null);
  const pointers = (name) => ({ onPointerEnter: () => point(name), onPointerLeave: () => point(null), onFocus: () => point(name), onBlur: () => point(null) });
  const diff = m.previous !== null ? m.value - m.previous : null;

  // 原因句里提到分项的词加下划线，指上去与分项联动
  const parts = [];
  let rest = m.reason;
  for (;;) {
    const hits = drivers.filter((d) => d.phrase && rest.includes(d.phrase)).map((d) => ({ d, at: rest.indexOf(d.phrase) }));
    if (!hits.length) break;
    const first = hits.reduce((a, b) => (b.at < a.at ? b : a));
    if (first.at) parts.push({ text: rest.slice(0, first.at) });
    parts.push({ text: first.d.phrase, driver: first.d.name });
    rest = rest.slice(first.at + first.d.phrase.length);
  }
  if (rest) parts.push({ text: rest });

  return (
    <section data-testid="radar-score-explainer" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LayoutGroup id={group}>
          <div role="tablist" aria-label="评分" className="-ml-1 flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none]">
            {metrics.map((x) => {
              const on = x.id === m.id;
              return (
                <button
                  key={x.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setAt(x.id)}
                  className={cx('relative h-8 shrink-0 rounded-full px-3 text-[13px] font-semibold transition-colors', on ? 'text-indigo-700' : 'text-slate-500 hover:text-slate-700')}
                >
                  {on && <motion.span layoutId="radar-explainer-tab" className="absolute inset-0 rounded-full bg-indigo-50" transition={reduce ? { duration: 0 } : SPRING} />}
                  <span className="relative z-[1]">{x.name}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>
        <span className="text-[11px] text-slate-400">为什么是这个分{data?.date ? ` · ${data.date} 收盘` : ''}</span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-1">
        <p className={cx('text-[44px] font-semibold leading-none tracking-[-0.04em] transition-colors duration-300 sm:text-[52px]', without ? 'text-slate-300' : 'text-slate-900')}>
          <RollingNumber value={without ? m.value - without.amount : m.value} />
        </p>
        <p className="pb-1 text-[13px] text-slate-500">
          {without ? (
            <>
              <span className="text-slate-900">去掉「{without.name}」</span> 少 {fmt1(Math.abs(without.amount))} 分，其余不变
            </>
          ) : diff !== null ? (
            <>
              比{m.vs}
              <span className={cx('mx-1 font-semibold', diff > 0 ? 'text-rose-600' : diff < 0 ? 'text-emerald-600' : 'text-slate-700')}>
                {diff === 0 ? '持平' : `${diff > 0 ? '高' : '低'} ${fmt1(Math.abs(diff))} 分`}
              </span>
              （{m.previous}）
            </>
          ) : (
            <>满分 100，越高越该行动</>
          )}
        </p>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={m.id}
          className="mt-4 text-[14px] leading-6 text-slate-700"
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
        >
          {parts.map((part, k) => {
            if (!part.driver) {
              return (
                <motion.span key={k} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: reduce ? 0 : 0.05 + k * 0.04 }}>
                  {part.text}
                </motion.span>
              );
            }
            const on = lit === part.driver;
            return (
              <span
                key={k}
                {...pointers(part.driver)}
                className={cx('cursor-default rounded-[4px] underline decoration-1 underline-offset-[5px] transition-colors', on ? 'bg-indigo-50 decoration-indigo-500' : 'decoration-slate-300')}
              >
                {part.text}
              </span>
            );
          })}
        </motion.p>
      </AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        <motion.ul key={m.id} className="mt-3" exit={{ opacity: 0, transition: { duration: 0.12 } }}>
          {drivers.map((d, i) => (
            <motion.li
              key={d.name}
              tabIndex={0}
              aria-label={`${d.name}，${signed(d.amount)} 分。显示去掉这一项后的分数`}
              {...pointers(d.name)}
              className="grid cursor-default grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 border-t border-slate-100 py-2.5 outline-none focus-visible:bg-slate-50 sm:grid-cols-[minmax(96px,140px)_minmax(0,1fr)_auto]"
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: lit && lit !== d.name ? 0.45 : 1, y: 0, transition: { ...SPRING, delay: reduce || lit ? 0 : 0.05 + i * 0.04, opacity: { duration: 0.2 } } }}
            >
              <span className="truncate text-[13px] font-medium text-slate-900">{d.name}</span>
              <span className="col-span-2 row-start-2 truncate text-[12px] text-slate-400 sm:col-span-1 sm:row-start-auto">{d.note}</span>
              <span className="text-right text-[13px] font-semibold tabular-nums text-slate-900">{signed(d.amount)}</span>
            </motion.li>
          ))}
        </motion.ul>
      </AnimatePresence>
      <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-5 text-slate-400">{m.basis}</p>
    </section>
  );
}

export default RadarScoreExplainer;
