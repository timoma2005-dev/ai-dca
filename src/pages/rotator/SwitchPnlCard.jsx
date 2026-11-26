import { useEffect, useMemo, useState } from 'react';
import {
  Area, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { Button } from '../../components/ui/button.jsx';
import { getSeries } from './rotatorApi.js';
import { defaultBuyShares, minuteLabel, shanghaiTs, shortName, switchPnlSeries } from './rotatorCharts.js';

// 换车收益曲线：用户自己填卖出/买入价和份额（只存本机 localStorage），
// 用当天 5 秒价格序列算「换了」比「拿着不换」多赚多少元。
const STORE_KEY = 'aidca.rotator.switches.v1';
const MAX_SAVED = 30;
const RED = '#dc2626';
const GREEN = '#059669';

function todayShanghai() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function loadSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function storeSaved(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_SAVED))); } catch { /* 隐私模式 */ }
}

const yuan = (v) => Math.round(Math.abs(v)).toLocaleString('zh-CN');
const verdict = (v) => (v >= 0 ? `多赚 ${yuan(v)} 元` : `少赚 ${yuan(v)} 元`);
const tone = (v) => (v >= 0 ? 'text-red-600' : 'text-emerald-600');

const EMPTY = { id: '', day: '', time: '', sellCode: '', sellPx: '', sellShares: '', buyCode: '', buyPx: '', buyShares: '' };

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

const inputCls = 'h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground tabular-nums';

function PnlTooltip({ active, payload, names }) {
  const p = active && payload?.[0]?.payload;
  if (!p) return null;
  return (
    <div className="rounded-lg border border-border bg-background/95 px-2.5 py-2 text-[11px] shadow-lg tabular-nums">
      <div className="text-muted-foreground">{minuteLabel(p.x)}</div>
      <div className={`mt-0.5 font-semibold ${tone(p.v)}`}>{verdict(p.v)}</div>
      <div className="mt-0.5 text-muted-foreground">{names.sell} {p.pa.toFixed(3)} · {names.buy} {p.pb.toFixed(3)}</div>
    </div>
  );
}

export default function SwitchPnlCard({ pool, commBps = 0 }) {
  const [saved, setSaved] = useState(loadSaved);
  const [form, setForm] = useState(() => loadSaved()[0] || { ...EMPTY, day: todayShanghai() });
  const [series, setSeries] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const nameOf = (c) => shortName(pool.find((r) => r.code === c)?.name, c);
  const autoBuy = defaultBuyShares(form.sellShares, form.sellPx, form.buyPx);
  const buyShares = Number(form.buyShares) > 0 ? Number(form.buyShares) : autoBuy;

  const codesKey = form.sellCode && form.buyCode && form.sellCode !== form.buyCode && form.day
    ? `${form.day}|${form.sellCode}|${form.buyCode}` : '';

  useEffect(() => {
    if (!codesKey) { setSeries(null); return undefined; }
    const [day, a, b] = codesKey.split('|');
    const ctrl = new AbortController();
    setLoading(true);
    setErr('');
    getSeries(day, [a, b], ctrl.signal)
      .then((s) => setSeries({ key: codesKey, a: s[a] || [], b: s[b] || [] }))
      .catch((e) => { if (e?.name !== 'AbortError') setErr(e?.message || '读取失败'); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [codesKey]);

  const result = useMemo(() => {
    if (!series || series.key !== codesKey) return null;
    return switchPnlSeries({
      seriesA: series.a,
      seriesB: series.b,
      switchTs: shanghaiTs(form.day, form.time),
      sellPx: form.sellPx,
      sellShares: form.sellShares,
      buyPx: form.buyPx,
      buyShares,
      commBps
    });
  }, [series, codesKey, form.day, form.time, form.sellPx, form.sellShares, form.buyPx, buyShares, commBps]);

  const data = useMemo(() => (result?.points || []).map((p) => ({ ...p, pos: Math.max(p.v, 0), neg: Math.min(p.v, 0) })), [result]);

  function save() {
    const rec = { ...form, id: form.id || String(Date.now()) };
    const list = [rec, ...saved.filter((s) => s.id !== rec.id)];
    setSaved(list);
    storeSaved(list);
    setForm(rec);
  }

  function remove() {
    const list = saved.filter((s) => s.id !== form.id);
    setSaved(list);
    storeSaved(list);
    setForm({ ...EMPTY, day: todayShanghai() });
  }

  const label = (s) => `${String(s.day).slice(5)} ${String(s.time).slice(0, 5)} ${nameOf(s.sellCode)}→${nameOf(s.buyCode)}`;
  const names = { sell: nameOf(form.sellCode), buy: nameOf(form.buyCode) };
  const { min, max, last } = result || {};
  const swingLow = min && min.v < 0 ? min : null;
  const swingHigh = max && max.v > 0 ? max : null;
  const xMin = data.length ? data[0].x : 0;
  const xMax = data.length ? data[data.length - 1].x : 240;
  const ticks = [0, 30, 60, 90, 120, 150, 180, 210, 240].filter((t) => t > xMin && t < xMax);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-sm font-medium">换车收益曲线<span className="ml-1 text-xs font-normal text-muted-foreground">（换了比拿着不换多赚/少赚多少元；成交价自己填，只存在本机）</span></div>

      {saved.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {saved.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setForm(s)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${s.id === form.id ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
            >{label(s)}</button>
          ))}
          <button type="button" onClick={() => setForm({ ...EMPTY, day: todayShanghai() })} className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground">＋ 新的一笔</button>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Field label="日期"><input type="date" className={inputCls} value={form.day} onChange={set('day')} /></Field>
        <Field label="换车时间"><input type="time" step="1" className={inputCls} value={form.time} onChange={set('time')} /></Field>
        <Field label="卖出（原持仓）">
          <select className={inputCls} value={form.sellCode} onChange={set('sellCode')}>
            <option value="">选择代码</option>
            {pool.map((r) => <option key={r.code} value={r.code}>{r.code} {shortName(r.name, r.code)}</option>)}
          </select>
        </Field>
        <Field label="买入（换成）">
          <select className={inputCls} value={form.buyCode} onChange={set('buyCode')}>
            <option value="">选择代码</option>
            {pool.map((r) => <option key={r.code} value={r.code}>{r.code} {shortName(r.name, r.code)}</option>)}
          </select>
        </Field>
        <Field label="卖出价"><input type="number" inputMode="decimal" step="0.001" className={inputCls} value={form.sellPx} onChange={set('sellPx')} /></Field>
        <Field label="卖出份额"><input type="number" inputMode="numeric" step="100" className={inputCls} value={form.sellShares} onChange={set('sellShares')} /></Field>
        <Field label="买入价"><input type="number" inputMode="decimal" step="0.001" className={inputCls} value={form.buyPx} onChange={set('buyPx')} /></Field>
        <Field label="买入份额（留空按卖出额折算）">
          <input type="number" inputMode="numeric" step="100" className={inputCls} value={form.buyShares} placeholder={autoBuy ? String(autoBuy) : ''} onChange={set('buyShares')} />
        </Field>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={!codesKey || !form.time}>{form.id ? '保存修改' : '保存这笔'}</Button>
        {form.id ? <Button size="sm" variant="outline" onClick={remove}>删除</Button> : null}
        <span className="text-xs text-muted-foreground">
          {result ? `找零 ${Math.round(result.cash).toLocaleString('zh-CN')} 元 · 已扣双边佣金 ${result.fees.toFixed(1)} 元（万${commBps}）` : ''}
        </span>
      </div>

      {err ? <div className="mt-3 text-sm text-red-600">{err}</div> : null}
      {!codesKey ? <div className="mt-6 text-center text-sm text-muted-foreground">选好卖出/买入代码、填上成交价和份额后显示曲线</div> : null}
      {codesKey && loading && !data.length ? <div className="mt-6 text-center text-sm text-muted-foreground">加载中…</div> : null}
      {codesKey && !loading && result === null && !err ? <div className="mt-6 text-center text-sm text-muted-foreground">请填写换车时间、成交价和份额</div> : null}
      {codesKey && !loading && result && !data.length ? <div className="mt-6 text-center text-sm text-muted-foreground">这一天换车时间之后没有价格数据</div> : null}

      {data.length ? (
        <>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm tabular-nums">
            <span className="text-muted-foreground">{names.sell} → {names.buy}</span>
            <span className={`font-semibold ${tone(last.v)}`}>{minuteLabel(last.x) >= '15:00' ? '收盘' : `最新 ${minuteLabel(last.x)}`} {verdict(last.v)}</span>
            {swingHigh ? <span className="text-red-600">最高 {minuteLabel(swingHigh.x)} 多赚 {yuan(swingHigh.v)}</span> : null}
            {swingLow ? <span className="text-emerald-600">最低 {minuteLabel(swingLow.x)} 少赚 {yuan(swingLow.v)}</span> : null}
          </div>
          <div className="mt-2 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: 4 }}>
                <XAxis dataKey="x" type="number" domain={[xMin, xMax]} ticks={[xMin, ...ticks, xMax]} tickFormatter={(x) => (x === 120 ? '午休' : minuteLabel(x))} tick={{ fontSize: 11 }} />
                <YAxis width={56} tick={{ fontSize: 11 }} tickFormatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('zh-CN')}`} />
                <Tooltip content={<PnlTooltip names={names} />} />
                {xMin < 120 && xMax > 120 ? <ReferenceLine x={120} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="2 3" /> : null}
                <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.6} strokeDasharray="4 3" />
                <Area dataKey="pos" type="linear" stroke="none" fill={RED} fillOpacity={0.15} isAnimationActive={false} />
                <Area dataKey="neg" type="linear" stroke="none" fill={GREEN} fillOpacity={0.15} isAnimationActive={false} />
                <Line dataKey="v" type="linear" stroke="currentColor" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                {swingLow ? <ReferenceDot x={swingLow.x} y={swingLow.v} r={4} fill={GREEN} stroke="none" /> : null}
                {swingHigh ? <ReferenceDot x={swingHigh.x} y={swingHigh.v} r={4} fill={RED} stroke="none" /> : null}
                <ReferenceDot x={last.x} y={last.v} r={4} fill={last.v >= 0 ? RED : GREEN} stroke="none" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 rounded-lg border border-border px-3 py-2 text-sm tabular-nums">
            同一笔交易，换车后在 <span className="font-semibold text-emerald-600">{min.v < 0 ? '−' : '+'}{yuan(min.v)}</span> 和 <span className="font-semibold text-red-600">{max.v < 0 ? '−' : '+'}{yuan(max.v)}</span> 之间来回摆；对错看规则，单次盈亏当噪声。
          </div>
        </>
      ) : null}
    </div>
  );
}
