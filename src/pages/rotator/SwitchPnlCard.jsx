import { useEffect, useMemo, useState } from 'react';
import {
  Area, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.jsx';
import { getSeries } from './rotatorApi.js';
import ImportPanel from './ImportPanel.jsx';
import { minuteLabel, priceAt, rotationPortfolio, shanghaiTs, shortName } from './rotatorCharts.js';

// 换车收益：按天记录「起始持仓 + 依次换车」（成交价自己填，只存本机 localStorage），
// 用当天 5 秒价格算「我（换了 N 次）」和「一直拿起始那只」各赚多少，以及每一次换车单独比不换多赚多少。
const STORE_KEY = 'aidca.rotator.days.v2';
const OLD_KEY = 'aidca.rotator.switches.v1';
const MAX_DAYS = 60;
const RED = '#dc2626';
const GREEN = '#059669';
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const mark = (n) => CIRCLED[n - 1] || `(${n})`;

function todayShanghai() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function loadDays() {
  try {
    const days = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (days && typeof days === 'object') return days;
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || '[]');
    const out = {};
    for (const r of Array.isArray(old) ? old : []) {
      if (!r?.day || out[r.day]) continue;
      out[r.day] = {
        startCode: r.sellCode,
        startShares: r.sellShares,
        switches: [{ id: r.id || String(Date.now()), time: r.time, buyCode: r.buyCode, sellPx: r.sellPx, buyPx: r.buyPx, buyShares: r.buyShares }]
      };
    }
    return out;
  } catch {
    return {};
  }
}

function storeDays(days) {
  const keep = Object.keys(days).sort().reverse().slice(0, MAX_DAYS);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(keep.map((k) => [k, days[k]])))); } catch { /* 隐私模式 */ }
}

const yuan = (v) => Math.round(Math.abs(v)).toLocaleString('zh-CN');
const signed = (v) => `${v < 0 ? '−' : '+'}${yuan(v)}`;
const verdict = (v) => (v >= 0 ? `多赚 ${yuan(v)} 元` : `少赚 ${yuan(v)} 元`);
const tone = (v) => (v >= 0 ? 'text-red-600' : 'text-emerald-600');
const px3 = (v) => (Number(v) > 0 ? Number(v).toFixed(3) : '—');
const inputCls = 'h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground tabular-nums';
const yTick = (v) => `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('zh-CN')}`;

function Field({ label, children, className = '' }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-xs text-muted-foreground ${className}`}>
      {label}
      {children}
    </label>
  );
}

function axis(points) {
  const xMin = points.length ? points[0].x : 0;
  const xMax = points.length ? points[points.length - 1].x : 240;
  const ticks = [0, 60, 120, 180, 240].filter((t) => t > xMin + 15 && t < xMax - 15);
  return { xMin, xMax, ticks: [xMin, ...ticks, xMax] };
}

function XAx({ points }) {
  const { xMin, xMax, ticks } = axis(points);
  return <XAxis dataKey="x" type="number" domain={[xMin, xMax]} ticks={ticks} tickFormatter={(x) => (x === 120 ? '午休' : minuteLabel(x))} tick={{ fontSize: 10 }} interval={0} />;
}

function AllTip({ active, payload, baseName }) {
  const p = active && payload?.[0]?.payload;
  if (!p) return null;
  return (
    <div className="rounded-lg border border-border bg-background/95 px-2.5 py-2 text-[11px] shadow-lg tabular-nums">
      <div className="text-muted-foreground">{minuteLabel(p.x)}</div>
      <div className="mt-0.5 font-semibold">我 {signed(p.mine)} 元</div>
      <div className="text-muted-foreground">一直拿{baseName} {signed(p.base)} 元</div>
      <div className={`mt-0.5 ${tone(p.mine - p.base)}`}>{verdict(p.mine - p.base)}</div>
    </div>
  );
}

function LegTip({ active, payload }) {
  const p = active && payload?.[0]?.payload;
  if (!p) return null;
  return (
    <div className="rounded-lg border border-border bg-background/95 px-2.5 py-2 text-[11px] shadow-lg tabular-nums">
      <div className="text-muted-foreground">{minuteLabel(p.x)}</div>
      <div className={`mt-0.5 font-semibold ${tone(p.v)}`}>{verdict(p.v)}</div>
    </div>
  );
}

function AllChart({ result, nameOf }) {
  const { points, legs, last, startCode } = result;
  const { xMin, xMax } = axis(points);
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><i className="inline-block h-0.5 w-4 bg-foreground" />我（换了 {legs.length} 次）</span>
        <span className="flex items-center gap-1"><i className="inline-block w-4 border-t border-dashed border-muted-foreground" />一直拿{nameOf(startCode)}</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-3 rounded-sm bg-red-500/20" />多赚</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-3 rounded-sm bg-emerald-500/20" />少赚</span>
      </div>
      <div className="mt-1 h-60 w-full min-w-0 sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 16, right: 20, bottom: 0, left: 0 }}>
            <XAx points={points} />
            <YAxis width={48} tick={{ fontSize: 10 }} tickFormatter={yTick} />
            <Tooltip content={<AllTip baseName={nameOf(startCode)} />} />
            {xMin < 120 && xMax > 120 ? <ReferenceLine x={120} stroke="currentColor" strokeOpacity={0.2} strokeDasharray="2 3" /> : null}
            <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.25} />
            <Area dataKey="up" type="linear" stroke="none" fill={RED} fillOpacity={0.18} isAnimationActive={false} />
            <Area dataKey="down" type="linear" stroke="none" fill={GREEN} fillOpacity={0.18} isAnimationActive={false} />
            <Line dataKey="base" type="linear" stroke="#9ca3af" strokeWidth={1.2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            <Line dataKey="mine" type="linear" stroke="currentColor" strokeWidth={1.8} dot={false} isAnimationActive={false} />
            {legs.map((l) => (
              <ReferenceDot key={l.n} ifOverflow="visible" x={l.x} y={l.y} r={8} fill="var(--background, #fff)" stroke="currentColor" strokeWidth={1.2}
                label={{ value: String(l.n), position: 'center', fontSize: 10, fontWeight: 600, fill: 'currentColor' }} />
            ))}
            {last ? <ReferenceDot x={last.x} y={last.mine} r={3} fill="currentColor" stroke="none" /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

function LegChart({ leg, nameOf }) {
  const res = leg.single;
  const points = (res?.points || []).map((p) => ({ ...p, pos: Math.max(p.v, 0), neg: Math.min(p.v, 0) }));
  if (!points.length) return <div className="mt-6 text-center text-sm text-muted-foreground">这次换车之后没有价格数据</div>;
  const { min, max, last } = res;
  const { xMin, xMax } = axis(points);
  return (
    <>
      <div className="mt-3 text-xs text-muted-foreground">
        {mark(leg.n)} {nameOf(leg.from)} → {nameOf(leg.to)}，比拿着{nameOf(leg.from)}不换多赚/少赚多少（元）
      </div>
      <div className="mt-1 h-60 w-full min-w-0 sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 16, right: 20, bottom: 0, left: 0 }}>
            <XAx points={points} />
            <YAxis width={48} tick={{ fontSize: 10 }} tickFormatter={yTick} />
            <Tooltip content={<LegTip />} />
            {xMin < 120 && xMax > 120 ? <ReferenceLine x={120} stroke="currentColor" strokeOpacity={0.2} strokeDasharray="2 3" /> : null}
            <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.5} strokeDasharray="4 3" />
            <Area dataKey="pos" type="linear" stroke="none" fill={RED} fillOpacity={0.15} isAnimationActive={false} />
            <Area dataKey="neg" type="linear" stroke="none" fill={GREEN} fillOpacity={0.15} isAnimationActive={false} />
            <Line dataKey="v" type="linear" stroke="currentColor" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {min.v < 0 ? <ReferenceDot x={min.x} y={min.v} r={4} fill={GREEN} stroke="none" /> : null}
            {max.v > 0 ? <ReferenceDot x={max.x} y={max.v} r={4} fill={RED} stroke="none" /> : null}
            <ReferenceDot x={last.x} y={last.v} r={4} fill={last.v >= 0 ? RED : GREEN} stroke="none" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-xs tabular-nums">
        这一次在 <span className="font-semibold text-emerald-600">{signed(min.v)}</span> 和 <span className="font-semibold text-red-600">{signed(max.v)}</span> 之间来回摆
        {min.v < 0 ? `（${minuteLabel(min.x)} 最多少赚 ${yuan(min.v)}）` : ''}，{minuteLabel(last.x) >= '15:00' ? '收盘' : minuteLabel(last.x)}
        <span className={`ml-1 font-semibold ${tone(last.v)}`}>{verdict(last.v)}</span>
      </div>
    </>
  );
}

function SwitchForm({ draft, setDraft, fromCode, pool, nameOf, marketSell, marketBuy, onSave, onCancel, onDelete }) {
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="mb-2 text-xs text-muted-foreground">卖出全部 <span className="font-medium text-foreground">{nameOf(fromCode) || '—'}</span>，换成：</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="时间"><input type="time" step="1" className={inputCls} value={draft.time} onChange={set('time')} /></Field>
        <Field label="换成">
          <select className={inputCls} value={draft.buyCode} onChange={set('buyCode')}>
            <option value="">选择</option>
            {pool.filter((r) => r.code !== fromCode).map((r) => <option key={r.code} value={r.code}>{shortName(r.name, r.code)} {r.code}</option>)}
          </select>
        </Field>
        <Field label="卖出成交价"><input type="number" inputMode="decimal" step="0.001" className={inputCls} value={draft.sellPx} placeholder={marketSell ? `行情 ${px3(marketSell)}` : ''} onChange={set('sellPx')} /></Field>
        <Field label="买入成交价"><input type="number" inputMode="decimal" step="0.001" className={inputCls} value={draft.buyPx} placeholder={marketBuy ? `行情 ${px3(marketBuy)}` : ''} onChange={set('buyPx')} /></Field>
        <Field label="买入份额" className="col-span-2"><input type="number" inputMode="numeric" step="100" className={inputCls} value={draft.buyShares} placeholder="留空按卖出金额折整百" onChange={set('buyShares')} /></Field>
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground">成交价留空按该时刻行情价算</div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={onSave} disabled={!draft.time || !draft.buyCode}>保存</Button>
        <Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
        {onDelete ? <Button size="sm" variant="ghost" className="ml-auto text-red-600" onClick={onDelete}>删除</Button> : null}
      </div>
    </div>
  );
}

export default function SwitchPnlCard({ pool, holding = '', commBps = 0 }) {
  const [days, setDays] = useState(loadDays);
  const [day, setDay] = useState(todayShanghai);
  const [draft, setDraft] = useState(null);
  const [view, setView] = useState(0);
  const [cache, setCache] = useState({});
  const [err, setErr] = useState('');

  const rec = days[day] || { startCode: holding, startShares: '', switches: [] };
  const nameOf = (c) => (c ? shortName(pool.find((r) => r.code === c)?.name, c) : '');
  const sorted = useMemo(() => (rec.switches || [])
    .map((s) => ({ ...s, ts: shanghaiTs(day, s.time) }))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)), [rec.switches, day]);

  function update(next) {
    const all = { ...days, [day]: { ...rec, ...next } };
    setDays(all);
    storeDays(all);
  }

  const draftTs = draft ? shanghaiTs(day, draft.time) : null;
  const heldAt = (ts, skipId) => {
    let c = rec.startCode;
    for (const s of sorted) if (s.id !== skipId && Number.isFinite(s.ts) && s.ts <= ts) c = s.buyCode;
    return c;
  };
  const draftFrom = draft ? heldAt(Number.isFinite(draftTs) ? draftTs : Infinity, draft.id) : '';

  const needed = [...new Set([rec.startCode, ...sorted.map((s) => s.buyCode), draftFrom, draft?.buyCode].filter(Boolean))];
  const missing = needed.filter((c) => !cache[`${day}|${c}`]);
  const missingKey = missing.join(',');

  useEffect(() => {
    if (!missingKey) return undefined;
    const codes = missingKey.split(',');
    const ctrl = new AbortController();
    setErr('');
    const chunks = [];
    for (let i = 0; i < codes.length; i += 4) chunks.push(codes.slice(i, i + 4));
    Promise.all(chunks.map((c) => getSeries(day, c, ctrl.signal)))
      .then((parts) => setCache((m) => {
        const next = { ...m };
        for (const c of codes) next[`${day}|${c}`] = parts.find((p) => p[c])?.[c] || [];
        return next;
      }))
      .catch((e) => { if (e?.name !== 'AbortError') setErr(e?.message || '读取行情失败'); });
    return () => ctrl.abort();
  }, [day, missingKey]);

  const seriesByCode = useMemo(() => Object.fromEntries(needed.map((c) => [c, cache[`${day}|${c}`] || []])), [needed.join(','), cache, day]); // eslint-disable-line react-hooks/exhaustive-deps
  const loading = missing.length > 0;
  const result = useMemo(() => (loading ? null : rotationPortfolio({
    seriesByCode, startCode: rec.startCode, startShares: rec.startShares, switches: sorted, commBps
  })), [loading, seriesByCode, rec.startCode, rec.startShares, sorted, commBps]);
  const ok = result && !result.error && result.points.length;
  const legs = ok ? result.legs : [];
  const shownView = view > legs.length ? 0 : view;

  function saveDraft() {
    const prev = (rec.switches || []).find((x) => x.id === draft.id);
    const s = { ...draft, id: draft.id || String(Date.now()), est: Boolean(prev?.est && prev.time === draft.time) };
    update({ switches: [...(rec.switches || []).filter((x) => x.id !== s.id), s] });
    setDraft(null);
  }
  function removeDraft() {
    update({ switches: (rec.switches || []).filter((x) => x.id !== draft.id) });
    setDraft(null);
  }
  function applyImport(plan) {
    const d = plan.day || day;
    const base = Date.now();
    const all = { ...days, [d]: { startCode: plan.startCode, startShares: String(plan.startShares), switches: plan.switches.map((x, i) => ({ ...x, id: String(base + i) })) } };
    setDays(all);
    storeDays(all);
    setDay(d);
    setDraft(null);
    setView(0);
  }
  function addSwitch() {
    const lastTime = sorted.length ? sorted[sorted.length - 1].time : '10:00:00';
    setDraft({ id: '', time: lastTime, buyCode: '', sellPx: '', buyPx: '', buyShares: '' });
  }

  const marketSell = Number.isFinite(draftTs) ? priceAt(cache[`${day}|${draftFrom}`], draftTs) : null;
  const marketBuy = Number.isFinite(draftTs) && draft?.buyCode ? priceAt(cache[`${day}|${draft.buyCode}`], draftTs) : null;
  const legById = (id) => legs.find((l) => l.ts === sorted.find((s) => s.id === id)?.ts && l.to === sorted.find((s) => s.id === id)?.buyCode);
  const last = ok ? result.last : null;
  const endLabel = last ? (minuteLabel(last.x) >= '15:00' ? '收盘' : `最新 ${minuteLabel(last.x)}`) : '';

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
        <ImportPanel day={day} pool={pool} onApply={applyImport} />
        <div className="mt-3 grid grid-cols-[1fr_1fr] gap-2 sm:grid-cols-[10rem_1fr_8rem]">
          <Field label="日期" className="col-span-2 sm:col-span-1">
            <input type="date" className={inputCls} value={day} onChange={(e) => { setDay(e.target.value); setDraft(null); setView(0); }} />
          </Field>
          <Field label="起始持仓">
            <select className={inputCls} value={rec.startCode || ''} onChange={(e) => update({ startCode: e.target.value })}>
              <option value="">选择</option>
              {pool.map((r) => <option key={r.code} value={r.code}>{shortName(r.name, r.code)} {r.code}</option>)}
            </select>
          </Field>
          <Field label="份额">
            <input type="number" inputMode="numeric" step="100" className={inputCls} value={rec.startShares || ''} placeholder="如 52000" onChange={(e) => update({ startShares: e.target.value })} />
          </Field>
        </div>

        <div className="mt-3 divide-y divide-border">
          {sorted.map((s, i) => {
            if (draft && draft.id === s.id) return null;
            const leg = legById(s.id);
            return (
              <button key={s.id} type="button" onClick={() => setDraft({ ...s })} className="flex w-full items-center gap-2 py-2 text-left text-sm">
                <span className="w-5 shrink-0 text-base leading-none">{mark(i + 1)}</span>
                <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{s.est ? '约 ' : ''}{String(s.time).slice(0, 5)}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{nameOf(leg?.from || heldAt(s.ts ?? 0, s.id))} → {nameOf(s.buyCode)}</span>
                  <span className="block truncate text-[11px] text-muted-foreground tabular-nums">
                    卖 {px3(leg?.sellPx ?? s.sellPx)} · 买 {px3(leg?.buyPx ?? s.buyPx)}{leg ? ` × ${leg.buyShares.toLocaleString('zh-CN')}` : ''}
                  </span>
                </span>
                {leg?.single?.last ? <span className={`shrink-0 text-xs tabular-nums ${tone(leg.single.last.v)}`}>{signed(leg.single.last.v)}</span> : null}
                <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
        {draft ? (
          <div className="mt-2">
            <SwitchForm
              draft={draft} setDraft={setDraft} fromCode={draftFrom} pool={pool} nameOf={nameOf}
              marketSell={marketSell} marketBuy={marketBuy}
              onSave={saveDraft} onCancel={() => setDraft(null)} onDelete={draft.id ? removeDraft : null}
            />
          </div>
        ) : (
          <button type="button" onClick={addSwitch} disabled={!rec.startCode} className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-2 text-sm text-muted-foreground disabled:opacity-50">
            <Plus className="h-4 w-4" />添加一次换车
          </button>
        )}
        <div className="mt-2 text-[11px] text-muted-foreground">每次都是卖出全部当前持仓再买入；只存在这台设备，已扣双边佣金（万{commBps}）</div>
      </div>

      <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
        {legs.length ? (
          <div className="flex gap-1 overflow-x-auto text-xs">
            {[0, ...legs.map((l) => l.n)].map((n) => (
              <button key={n} type="button" onClick={() => setView(n)}
                className={`shrink-0 rounded-full border px-3 py-1 ${shownView === n ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground'}`}
              >{n ? `${mark(n)} 这一次` : '全天'}</button>
            ))}
          </div>
        ) : null}
        {err ? <div className="mt-2 text-sm text-red-600">{err}</div> : null}
        {!rec.startCode || !(Number(rec.startShares) > 0) ? <div className="py-8 text-center text-sm text-muted-foreground">先填起始持仓和份额</div>
          : !sorted.length ? <div className="py-8 text-center text-sm text-muted-foreground">添加换车后显示曲线</div>
            : loading ? <div className="py-8 text-center text-sm text-muted-foreground">加载行情…</div>
              : result?.error ? <div className="py-8 text-center text-sm text-red-600">{result.error}</div>
                : !ok ? <div className="py-8 text-center text-sm text-muted-foreground">这一天没有价格数据</div>
                  : shownView ? <LegChart leg={legs[shownView - 1]} nameOf={nameOf} />
                    : <AllChart result={result} nameOf={nameOf} />}
      </div>

      {ok ? (
        <div className="rounded-xl border border-border bg-card px-3 py-1 text-sm sm:px-4">
          {legs.map((l) => (
            <div key={l.n} className="flex gap-2 border-b border-dashed border-border py-2 tabular-nums">
              <span className="w-[4.5rem] shrink-0 font-medium">{mark(l.n)} {minuteLabel(l.x)}</span>
              <span className="min-w-0 flex-1">
                {nameOf(l.from)} → {nameOf(l.to)}：这一次到{endLabel}
                <span className={`ml-1 font-medium ${tone(l.single?.last?.v ?? 0)}`}>{verdict(l.single?.last?.v ?? 0)}</span>
                {l.single?.min?.v < 0 ? <span className="block text-[11px] text-muted-foreground">{minuteLabel(l.single.min.x)} 一度少赚 {yuan(l.single.min.v)} 元</span> : null}
              </span>
            </div>
          ))}
          <div className="flex gap-2 py-2 tabular-nums">
            <span className="w-[4.5rem] shrink-0 font-medium">{endLabel}</span>
            <span className="min-w-0 flex-1">
              一直拿{nameOf(result.startCode)} <span className={tone(last.base)}>{signed(last.base)}</span> 元，换了 {legs.length} 次
              <span className={`ml-1 font-semibold ${tone(last.mine)}`}>{signed(last.mine)} 元</span>
              <span className="block text-[11px] text-muted-foreground">换车合计{verdict(last.mine - last.base)}</span>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
