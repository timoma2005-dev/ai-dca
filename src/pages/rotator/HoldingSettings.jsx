import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import { shortName } from './rotatorCharts.js';

// 顶部「我拿着 X · 阈值 N bps」：平时一行，点开后点基金即保存持仓，阈值步进/快捷档改完自动保存。
const PRESETS = [20, 30, 50];
const STEP = 5;

export default function HoldingSettings({ pool, code, enter, settings, isOwner, onHolding, onEnter }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState('');
  const [holdMsg, setHoldMsg] = useState('');
  const [val, setVal] = useState('');
  const [enterMsg, setEnterMsg] = useState('');
  const dirty = useRef(false);
  const timer = useRef(null);
  const min = settings?.min ?? 1;
  const max = settings?.max ?? 500;
  const nameOf = (c) => shortName(pool.find((r) => r.code === c)?.name, c);
  const shown = pending || code;

  useEffect(() => {
    if (!dirty.current && enter !== null && enter !== undefined) setVal(String(enter));
  }, [enter]);
  useEffect(() => { if (pending && pending === code) setPending(''); }, [code, pending]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function pick(c) {
    if (c === shown) return;
    setPending(c);
    setHoldMsg('保存中…');
    try {
      await onHolding(c);
      setHoldMsg(`已换成 ${nameOf(c)}，约 5 秒内生效`);
    } catch (err) {
      setPending('');
      setHoldMsg(err?.message || '保存失败');
    }
  }

  function changeEnter(next) {
    const s = String(next);
    dirty.current = true;
    setVal(s);
    clearTimeout(timer.current);
    const v = Number(s);
    if (s === '' || !Number.isFinite(v) || v < min || v > max) {
      setEnterMsg(`阈值须在 ${min}~${max} bps 之间`);
      return;
    }
    setEnterMsg('');
    timer.current = setTimeout(async () => {
      setEnterMsg('保存中…');
      try {
        const json = await onEnter(v);
        dirty.current = false;
        setEnterMsg(json?.applies_to_process ? '已保存，轮动进程下个交易日 10:25 启动时生效' : '已保存');
      } catch (err) {
        setEnterMsg(err?.message || '保存失败');
      }
    }, 700);
  }

  const cur = Number(val);
  const bump = (d) => changeEnter(Math.min(max, Math.max(min, (Number.isFinite(cur) ? cur : 30) + d)));
  const def = settings?.default_enter_bps ?? 30;

  return (
    <div className="rounded-xl border border-border bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm sm:px-4">
        {shown ? (
          <span className="min-w-0 flex-1 truncate">
            我拿着 <span className="rounded-md bg-sky-500/15 px-1.5 py-0.5 font-semibold text-sky-700">{nameOf(shown)}</span>
            <span className="mx-1.5 text-muted-foreground">·</span>
            阈值 <span className="font-semibold tabular-nums">{val || '—'}</span> bps
          </span>
        ) : <span className="flex-1 text-amber-700">还没设持仓，点这里选</span>}
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
          {open ? '收起' : '修改'}<ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-border px-3 pb-3 pt-3 sm:px-4">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs text-muted-foreground">
              <span className="font-medium text-foreground">我的持仓</span>
              <span>点一下就保存</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
              {pool.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  onClick={() => pick(r.code)}
                  className={`truncate rounded-lg border px-1 py-2 text-sm ${r.code === shown ? 'border-sky-600 bg-sky-600 font-medium text-white' : 'border-border bg-background'}`}
                >{shortName(r.name, r.code)}</button>
              ))}
            </div>
            {holdMsg ? <div className="mt-1.5 text-xs text-muted-foreground">{holdMsg}</div> : null}
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs text-muted-foreground">
              <span className="font-medium text-foreground">入场阈值</span>
              <span>持仓比最便宜贵过阈值就提示换</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex h-10 items-center rounded-lg border border-input bg-background">
                <button type="button" aria-label="减少" onClick={() => bump(-STEP)} className="flex h-full w-10 items-center justify-center text-muted-foreground"><Minus className="h-4 w-4" /></button>
                <input
                  type="number"
                  inputMode="numeric"
                  className="h-full w-12 border-x border-input bg-transparent text-center text-base font-semibold tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  value={val}
                  onChange={(e) => changeEnter(e.target.value)}
                />
                <button type="button" aria-label="增加" onClick={() => bump(STEP)} className="flex h-full w-10 items-center justify-center text-muted-foreground"><Plus className="h-4 w-4" /></button>
              </div>
              <span className="text-sm text-muted-foreground">bps</span>
              <div className="ml-auto flex gap-1">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => changeEnter(p)}
                    className={`rounded-full border px-2.5 py-1 text-xs tabular-nums ${cur === p ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground'}`}
                  >{p}{p === def ? ' 默认' : ''}</button>
                ))}
              </div>
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground">
              {enterMsg || '100 bps = 1%，改完自动保存'}
              {isOwner && settings ? ` · 进程当前 ${settings.process_enter_bps ?? '—'} · 下次启动 ${settings.next_enter_bps ?? '—'}` : ''}
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground">按账户保存，只影响你自己的视图</div>
        </div>
      ) : null}
    </div>
  );
}
