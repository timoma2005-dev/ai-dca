import { useMemo, useRef, useState } from 'react';
import { ImageUp } from 'lucide-react';
import { Button } from '../../components/ui/button.jsx';
import { getSeries, recognizeTrades } from './rotatorApi.js';
import { shortName } from './rotatorCharts.js';
import { planImport } from './tradeImport.js';

// 换车收益：上传券商「历史成交 / 当日成交」截图 → 预览换车 → 填进这一天
const ALIAS_KEY = 'aidca.rotator.alias.v1';
const loadAlias = () => { try { return JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {}; } catch { return {}; } };
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

export default function ImportPanel({ day, pool, onApply }) {
  const fileRef = useRef(null);
  const [state, setState] = useState({ status: 'idle', msg: '' });
  const [src, setSrc] = useState(null);
  const [fixed, setFixed] = useState({});
  const nameOf = (c) => shortName(pool.find((r) => r.code === c)?.name, c);

  const plan = useMemo(() => (src ? planImport({ rows: src.rows, pool, seriesByCode: src.series, fixed }) : null), [src, pool, fixed]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSrc(null);
    try {
      setState({ status: 'loading', msg: '正在识别截图…' });
      const { rows, warnings } = await recognizeTrades(file);
      const dated = rows.map((r) => String(r?.date || '').match(/20\d{2}-\d{2}-\d{2}/)?.[0]).find(Boolean);
      const d = dated || day;
      setState({ status: 'loading', msg: '正在对当天行情…' });
      const codes = pool.map((r) => r.code);
      const chunks = [];
      for (let i = 0; i < codes.length; i += 4) chunks.push(codes.slice(i, i + 4));
      const parts = await Promise.all(chunks.map((c) => getSeries(d, c)));
      setFixed(loadAlias());
      setSrc({ rows, ocrWarnings: warnings, series: Object.assign({}, ...parts), day: d });
      setState({ status: 'idle', msg: '' });
    } catch (err) {
      setState({ status: 'error', msg: err?.message || '识别失败' });
    }
  }

  function apply() {
    const alias = { ...loadAlias(), ...Object.fromEntries(plan.names.map((n) => [n.name, n.code])) };
    try { localStorage.setItem(ALIAS_KEY, JSON.stringify(alias)); } catch { /* 隐私模式 */ }
    onApply({ ...plan, day: plan.day || src.day });
    setSrc(null);
  }

  const err = plan?.error;
  return (
    <div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      {!src ? (
        <button type="button" onClick={() => fileRef.current?.click()} disabled={state.status === 'loading'}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/50 py-2 text-sm disabled:opacity-60">
          <ImageUp className="h-4 w-4" />{state.status === 'loading' ? state.msg : '上传成交截图，自动填换车'}
        </button>
      ) : null}
      {state.status === 'error' ? <div className="mt-1.5 text-xs text-red-600">{state.msg}</div> : null}

      {src ? (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-medium">识别结果 · {plan?.day || src.day}</span>
            <span className="text-[11px] text-muted-foreground">核对后再填入</span>
          </div>
          {err ? <div className="text-red-600">{err}</div> : (
            <>
              <div className="space-y-1.5">
                {plan.names.map((n) => (
                  <label key={n.name} className="flex items-center gap-2 text-xs">
                    <span className="w-16 shrink-0 truncate text-muted-foreground">「{n.name}」</span>
                    <span className="text-muted-foreground">是</span>
                    <select className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-sm"
                      value={n.code} onChange={(e) => setFixed((f) => ({ ...f, [n.name]: e.target.value }))}>
                      {[...n.alts, ...pool.map((r) => r.code).filter((c) => !n.alts.includes(c))].map((c) => (
                        <option key={c} value={c}>{nameOf(c)} {c}{n.alts.length > 1 && n.alts.includes(c) ? '（价格也对得上）' : ''}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="mt-3 divide-y divide-border rounded-md bg-background px-2 text-xs tabular-nums">
                <div className="py-1.5 text-muted-foreground">起始 {nameOf(plan.startCode)} {plan.startShares.toLocaleString('zh-CN')} 份</div>
                {plan.switches.map((s, i) => (
                  <div key={i} className="flex gap-2 py-1.5">
                    <span>{CIRCLED[i] || i + 1}</span>
                    <span className="w-14 shrink-0 text-muted-foreground">{s.est ? '约 ' : ''}{s.time.slice(0, 5)}</span>
                    <span className="min-w-0 flex-1">{nameOf(i ? plan.switches[i - 1].buyCode : plan.startCode)} → {nameOf(s.buyCode)}
                      <span className="block text-muted-foreground">卖 {s.sellPx.toFixed(3)} · 买 {s.buyPx.toFixed(3)} × {s.buyShares.toLocaleString('zh-CN')}</span>
                    </span>
                  </div>
                ))}
              </div>
              {plan.switches.some((s) => s.est) ? <div className="mt-1.5 text-[11px] text-muted-foreground">截图没有成交时间，「约」是按成交价对当天行情估的，填入后可以点开改</div> : null}
            </>
          )}
          {[...(plan?.warnings || []), ...src.ocrWarnings].slice(0, 4).map((w) => <div key={w} className="mt-1 text-[11px] text-amber-700">{w}</div>)}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={apply} disabled={Boolean(err)}>填入这一天</Button>
            <Button size="sm" variant="outline" onClick={() => setSrc(null)}>取消</Button>
            <button type="button" className="ml-auto text-xs text-muted-foreground" onClick={() => fileRef.current?.click()}>换一张</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
