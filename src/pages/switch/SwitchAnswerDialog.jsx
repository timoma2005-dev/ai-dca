import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.jsx';
import { cx } from '../../components/experience-ui.jsx';
import { formatSwitchPercent } from '../switchStrategyHelpers.js';
import { estimateBuyShares } from '../../app/switchSignalAnswer.js';

function toInput(value) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? '' : String(value);
}

function Field({ label, value, onChange, inputMode = 'decimal' }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      <span className="w-8 shrink-0">{label}</span>
      <input
        className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-sm text-slate-900 focus:border-indigo-400 focus:outline-none"
        value={value}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/**
 * 「我换了」确认：把方案的持仓翻到对面，可选同时往账本记一卖一买。
 * prompt: resolveSignalPrompt 的结果；available: 账本里卖出方现有份数。
 */
export function SwitchAnswerDialog({ open, onOpenChange, row, prompt, available = 0, saving = false, onConfirm }) {
  const [sellPrice, setSellPrice] = useState('');
  const [buyPrice, setBuyPrice] = useState('');
  const [sellShares, setSellShares] = useState('');
  const [buyShares, setBuyShares] = useState('');
  const [buyTouched, setBuyTouched] = useState(false);
  const [writeLedger, setWriteLedger] = useState(true);

  useEffect(() => {
    if (!open || !prompt) return;
    setSellPrice(toInput(prompt.fromPrice));
    setBuyPrice(toInput(prompt.toPrice));
    setSellShares(available > 0 ? String(available) : '');
    setBuyTouched(false);
    setWriteLedger(available > 0);
  }, [open, prompt, available]);

  useEffect(() => {
    if (buyTouched) return;
    const estimate = estimateBuyShares({ sellPrice, sellShares, buyPrice });
    setBuyShares(estimate ? String(estimate) : '');
  }, [sellPrice, sellShares, buyPrice, buyTouched]);

  const nextSide = row?.holdingSide === 'L' ? 'H' : 'L';
  const nextLine = nextSide === 'L' ? row?.lowerPct : row?.upperPct;
  const ledgerValid = useMemo(() => [sellPrice, sellShares, buyPrice, buyShares].every((v) => Number(v) > 0), [sellPrice, sellShares, buyPrice, buyShares]);
  if (!prompt) return null;

  const submit = (withLedger) => {
    onConfirm?.({
      writeLedger: withLedger && ledgerValid,
      sellPrice: Number(sellPrice) || null,
      sellShares: Number(sellShares) || null,
      buyPrice: Number(buyPrice) || null,
      buyShares: Number(buyShares) || null
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>确认这次换基</DialogTitle>
          <DialogDescription>{row?.name || '换基方案'}，卖 {prompt.fromCode} 买 {prompt.toCode}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <div className="space-y-1.5 rounded-xl bg-rose-50 p-2.5">
            <div className="text-[11px] text-rose-600">卖出</div>
            <div className="truncate text-sm font-bold text-slate-900">{prompt.fromCode} {prompt.fromName}</div>
            <Field label="价格" value={sellPrice} onChange={setSellPrice} />
            <Field label="份数" value={sellShares} onChange={setSellShares} inputMode="numeric" />
          </div>
          <div className="text-center text-slate-400">
            <span className="hidden sm:inline">→</span>
            <span className="sm:hidden">↓</span>
          </div>
          <div className="space-y-1.5 rounded-xl bg-emerald-50 p-2.5">
            <div className="text-[11px] text-emerald-600">买入</div>
            <div className="truncate text-sm font-bold text-slate-900">{prompt.toCode} {prompt.toName}</div>
            <Field label="价格" value={buyPrice} onChange={setBuyPrice} />
            <Field label="份数" value={buyShares} onChange={(v) => { setBuyTouched(true); setBuyShares(v); }} inputMode="numeric" />
          </div>
        </div>
        <label className={cx('flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-sm', !ledgerValid && 'opacity-80')}>
          <input type="checkbox" className="mt-0.5" checked={writeLedger} onChange={(e) => setWriteLedger(e.target.checked)} />
          <span>
            <span className="font-medium text-slate-800">同时记到持仓账本</span>
            <span className="block text-xs text-slate-500">
              {available > 0
                ? `账本里有 ${prompt.fromCode} · ${available} 份，按卖出金额估算买入份数`
                : `账本里还没有 ${prompt.fromCode}，填好份数也可以记一卖一买`}
            </span>
          </span>
        </label>
        <p className="text-xs text-slate-500">
          保存后方案改为持有 {prompt.toCode}，盯 {nextSide === 'L' ? 'L→H' : 'H→L'}
          {Number.isFinite(Number(nextLine)) ? `，到 ${formatSwitchPercent(Number(nextLine), 2, true)} 才会再提醒` : ''}。
        </p>
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <button type="button" disabled={saving} onClick={() => onOpenChange?.(false)} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">取消</button>
          <button
            type="button"
            disabled={saving || (writeLedger && !ledgerValid)}
            onClick={() => submit(writeLedger)}
            className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? '保存中…' : (writeLedger ? '换好了，记账' : '换好了')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SwitchAnswerDialog;
