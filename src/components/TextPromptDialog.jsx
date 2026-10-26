import { useEffect, useId, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.jsx';
import { cx, primaryButtonClass, secondaryButtonClass } from './experience-ui.jsx';
import { validatePromptText } from '../app/textPromptValidation.js';

// 项目内文本输入弹窗：替代 window.prompt。名称必填并 trim，回车提交，Esc/取消关闭。
export function TextPromptDialog({
  open,
  title,
  description = '',
  label = '名称',
  defaultValue = '',
  placeholder = '',
  maxLength = 0,
  submitLabel = '确定',
  onSubmit,
  onCancel,
}) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    setError('');
  }, [open, defaultValue]);

  function handleSubmit(event) {
    event.preventDefault();
    const result = validatePromptText(value, { maxLength, label });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSubmit?.(result.value);
  }

  return (
    <Dialog open={Boolean(open)} onOpenChange={(next) => { if (!next) onCancel?.(); }}>
      <DialogContent className="z-[160] border-slate-200 bg-white text-slate-900 sm:max-w-sm">
        <DialogTitle className="text-base font-bold text-slate-950">{title}</DialogTitle>
        {description ? <DialogDescription className="text-sm text-slate-500">{description}</DialogDescription> : <DialogDescription className="sr-only">{`输入${label}后保存`}</DialogDescription>}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={inputId} className="block text-xs font-semibold text-slate-600">{label}</label>
            <input
              id={inputId}
              name="name"
              autoFocus
              required
              value={value}
              placeholder={placeholder || `输入${label}`}
              maxLength={maxLength > 0 ? maxLength : undefined}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => { setValue(event.target.value); if (error) setError(''); }}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
            <div id={errorId} aria-live="polite" className="min-h-[1rem] text-xs text-red-600">{error}</div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className={cx(secondaryButtonClass)} onClick={() => onCancel?.()}>取消</button>
            <button type="submit" className={cx(primaryButtonClass)}>{submitLabel}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
