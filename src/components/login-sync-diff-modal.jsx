import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, ChevronDown, CloudCog, GitMerge, Loader2, RefreshCw } from 'lucide-react';
import { CLOUD_SYNC_SESSION_EVENT, loadCloudSession } from '../app/authSession.js';
import { LOGIN_SYNC_DIFF_EVENT } from '../app/loginSyncGate.js';
import { confirmLoginSync, getPendingLoginSyncDiff } from '../app/loginSyncFlow.js';
import { defaultLoginSyncChoices, LOGIN_SYNC_CHOICES, uniformLoginSyncChoices } from '../app/loginSyncDiff.js';
import { setMobileBottomSheetOpen } from '../app/mobileBottomSheet.js';
import { showToast } from '../app/toast.js';
import { cx } from './experience-ui.jsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

const SHEET_SOURCE = 'login-sync-diff';
const ROW_LIMIT = 12;

const CHOICE_META = {
  [LOGIN_SYNC_CHOICES.LOCAL]: { label: '保留本地', hint: '用本机数据覆盖云端，云端多出的条目会被删除。' },
  [LOGIN_SYNC_CHOICES.REMOTE]: { label: '保留云端', hint: '用云端数据替换本机，本机独有的条目会被删除。' },
  [LOGIN_SYNC_CHOICES.MERGE]: { label: '合并', hint: '两边都保留；同一条目两边不同时以云端为准。' }
};
const CHOICE_ORDER = [LOGIN_SYNC_CHOICES.LOCAL, LOGIN_SYNC_CHOICES.REMOTE, LOGIN_SYNC_CHOICES.MERGE];

const GLOBAL_ACTIONS = [
  { choice: LOGIN_SYNC_CHOICES.LOCAL, label: '全部本地覆盖云端', icon: ArrowUpFromLine },
  { choice: LOGIN_SYNC_CHOICES.REMOTE, label: '全部云端覆盖本地', icon: ArrowDownToLine },
  { choice: LOGIN_SYNC_CHOICES.MERGE, label: '全部合并', icon: GitMerge }
];

function formatTime(value = '') {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatNumber(value) {
  const number = Number(value) || 0;
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

function sideText(side, unit) {
  if (!side?.exists) return '无数据';
  return `${side.count} ${unit} · ${formatTime(side.updatedAt)}`;
}

function txText(tx = {}) {
  const direction = tx.type === 'SELL' ? '卖出' : tx.type === 'BUY' ? '买入' : (tx.type || '—');
  const size = tx.shares > 0 ? `${formatNumber(tx.shares)} 份` : tx.amount > 0 ? `${formatNumber(tx.amount)} 元` : '—';
  return { code: `${tx.code || '—'}${tx.name ? ` ${tx.name}` : ''}`, date: tx.date || '—', direction, size };
}

function TxLine({ tx, tone }) {
  const text = txText(tx);
  return (
    <li className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 rounded-lg bg-white px-2.5 py-1.5 text-xs ring-1 ring-slate-100 sm:grid-cols-[minmax(0,1fr)_6rem_3rem_7rem]">
      <span className="min-w-0 truncate font-semibold text-slate-800">{text.code}</span>
      <span className="text-right text-slate-500 sm:text-left">{text.date}</span>
      <span className={cx('font-semibold', tone)}>{text.direction}</span>
      <span className="text-right tabular-nums text-slate-700">{text.size}</span>
    </li>
  );
}

function LimitedList({ items, render, emptyText = '' }) {
  const [showAll, setShowAll] = useState(false);
  if (!items.length) return emptyText ? <div className="text-xs text-slate-400">{emptyText}</div> : null;
  const visible = showAll ? items : items.slice(0, ROW_LIMIT);
  return (
    <>
      <ul className="space-y-1">{visible.map(render)}</ul>
      {items.length > ROW_LIMIT ? (
        <button type="button" className="mt-1 text-xs font-semibold text-indigo-600" onClick={() => setShowAll((value) => !value)}>
          {showAll ? '收起' : `展开全部 ${items.length} 条`}
        </button>
      ) : null}
    </>
  );
}

function DiffGroup({ title, count, tone, children }) {
  if (!count) return null;
  return (
    <div>
      <div className={cx('mb-1 text-[11px] font-bold', tone)}>{title}（{count}）</div>
      {children}
    </div>
  );
}

function TransactionDetails({ rows }) {
  return (
    <div className="space-y-2.5">
      <DiffGroup title="仅本地" count={rows.localOnly.length} tone="text-indigo-700">
        <LimitedList items={rows.localOnly} render={(tx) => <TxLine key={`l-${tx.id}`} tx={tx} tone="text-indigo-700" />} />
      </DiffGroup>
      <DiffGroup title="仅云端" count={rows.remoteOnly.length} tone="text-sky-700">
        <LimitedList items={rows.remoteOnly} render={(tx) => <TxLine key={`r-${tx.id}`} tx={tx} tone="text-sky-700" />} />
      </DiffGroup>
      <DiffGroup title="两边内容不同" count={rows.changed.length} tone="text-amber-700">
        <LimitedList
          items={rows.changed}
          render={(pair) => (
            <li key={`c-${pair.id}`} className="space-y-1 rounded-lg bg-amber-50/60 p-1.5">
              <div className="text-[10px] font-semibold text-slate-400">本地</div>
              <ul><TxLine tx={pair.local} tone="text-slate-700" /></ul>
              <div className="text-[10px] font-semibold text-slate-400">云端</div>
              <ul><TxLine tx={pair.remote} tone="text-slate-700" /></ul>
            </li>
          )}
        />
      </DiffGroup>
    </div>
  );
}

function EntryChip({ entry, tone }) {
  return <li className={cx('inline-flex max-w-full truncate rounded-md px-2 py-0.5 text-xs', tone)} title={entry.label}>{entry.label}</li>;
}

function ResourceDetails({ item }) {
  const { localOnly, remoteOnly, changed } = item.entries;
  if (!localOnly.length && !remoteOnly.length && !changed.length) {
    return <div className="text-xs leading-5 text-slate-500">两边的设置内容不同（非列表数据，无法逐条对比）。</div>;
  }
  const chipList = (list, tone, prefix) => (
    <LimitedList items={list} render={(entry) => <EntryChip key={`${prefix}-${entry.key}`} entry={entry} tone={tone} />} />
  );
  return (
    <div className="space-y-2.5 [&_ul]:flex [&_ul]:flex-wrap [&_ul]:gap-1 [&_ul]:space-y-0">
      <DiffGroup title="仅本地" count={localOnly.length} tone="text-indigo-700">{chipList(localOnly, 'bg-indigo-50 text-indigo-800', 'l')}</DiffGroup>
      <DiffGroup title="仅云端" count={remoteOnly.length} tone="text-sky-700">{chipList(remoteOnly, 'bg-sky-50 text-sky-800', 'r')}</DiffGroup>
      <DiffGroup title="两边内容不同" count={changed.length} tone="text-amber-700">{chipList(changed, 'bg-amber-50 text-amber-900', 'c')}</DiffGroup>
    </div>
  );
}

function ChoiceSwitch({ value, onChange, disabled }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 text-xs font-semibold" role="radiogroup">
      {CHOICE_ORDER.map((choice) => (
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={value === choice}
          disabled={disabled}
          className={cx(
            'h-8 rounded-lg px-2 transition-colors disabled:opacity-60',
            value === choice ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'
          )}
          onClick={() => onChange(choice)}
        >
          {CHOICE_META[choice].label}
        </button>
      ))}
    </div>
  );
}

function DiffItemCard({ item, choice, onChoice, disabled }) {
  const [expanded, setExpanded] = useState(item.kind === 'transactions');
  const unit = item.kind === 'transactions' ? '行' : '项';
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-bold text-slate-950">{item.label}</div>
          <div className="mt-1 grid gap-0.5 text-xs text-slate-500">
            <span><span className="font-semibold text-indigo-700">本地</span> {sideText(item.local, unit)}</span>
            <span><span className="font-semibold text-sky-700">云端</span> {sideText(item.remote, unit)}</span>
          </div>
        </div>
        <div className="sm:w-60 sm:flex-none">
          <ChoiceSwitch value={choice} onChange={onChoice} disabled={disabled} />
        </div>
      </div>
      <div className="mt-2 text-[11px] leading-5 text-slate-400">{CHOICE_META[choice].hint}</div>
      <button
        type="button"
        className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown className={cx('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
        {expanded ? '收起差异' : '查看差异'}
      </button>
      {expanded ? (
        <div className="mt-2 rounded-xl bg-slate-50 p-2.5">
          {item.kind === 'transactions' ? <TransactionDetails rows={item.rows} /> : <ResourceDetails item={item} />}
        </div>
      ) : null}
    </section>
  );
}

export function LoginSyncDiffModal() {
  const [pending, setPending] = useState(() => getPendingLoginSyncDiff());
  const [open, setOpen] = useState(() => Boolean(getPendingLoginSyncDiff()));
  const [choices, setChoices] = useState(() => defaultLoginSyncChoices(getPendingLoginSyncDiff()?.diff?.items || []));
  const [phase, setPhase] = useState('ready');
  const [error, setError] = useState('');
  const items = useMemo(() => pending?.diff?.items || [], [pending]);
  const busy = phase === 'applying' || phase === 'checking';

  const show = useCallback((next) => {
    if (!next) return;
    setPending(next);
    setChoices(defaultLoginSyncChoices(next.diff?.items || []));
    setPhase('ready');
    setError('');
    setOpen(true);
  }, []);

  useEffect(() => {
    function handleDiff() { show(getPendingLoginSyncDiff()); }
    function handleSession(event) {
      const session = event?.detail?.session || loadCloudSession();
      if (String(session?.userId || '') !== String(pending?.userId || '')) {
        setOpen(false);
        setPending(null);
      }
    }
    window.addEventListener(LOGIN_SYNC_DIFF_EVENT, handleDiff);
    window.addEventListener(CLOUD_SYNC_SESSION_EVENT, handleSession);
    return () => {
      window.removeEventListener(LOGIN_SYNC_DIFF_EVENT, handleDiff);
      window.removeEventListener(CLOUD_SYNC_SESSION_EVENT, handleSession);
    };
  }, [show, pending?.userId]);

  useEffect(() => {
    setMobileBottomSheetOpen(SHEET_SOURCE, open);
    return () => setMobileBottomSheetOpen(SHEET_SOURCE, false);
  }, [open]);

  function cancel() {
    if (busy) return;
    setOpen(false);
    showToast({
      title: '数据未同步',
      description: '本机与云端数据尚未同步，自动同步已暂停。可从账户菜单「处理数据同步」再次打开。',
      tone: 'amber',
      durationMs: 6000
    });
  }

  async function confirm() {
    if (busy) return;
    setPhase('applying');
    setError('');
    try {
      await confirmLoginSync(choices);
      setOpen(false);
      setPending(null);
      setPhase('ready');
      showToast({ title: '数据已同步', description: '已按你的选择完成同步，并开启自动同步。', tone: 'emerald' });
    } catch (applyError) {
      setError(applyError?.message || '同步未完成，请重新检查后再试。');
      setPhase('failed');
    }
  }

  async function recheck() {
    setPhase('checking');
    setError('');
    try {
      const mod = await import('../app/postAuthSync.js');
      const outcome = await mod.ensureCloudSyncReady({ reopenLoginSync: true });
      const next = getPendingLoginSyncDiff();
      if (next) show(next);
      else {
        setOpen(false);
        setPending(null);
        setPhase('ready');
        if (outcome?.status !== 'error') showToast({ title: '数据已同步', tone: 'emerald' });
      }
    } catch (checkError) {
      setError(checkError?.message || '重新检查失败，请稍后重试。');
      setPhase('failed');
    }
  }

  if (!open || !pending) return null;
  const selectedUniform = CHOICE_ORDER.find((choice) => items.every((item) => choices[item.id] === choice)) || '';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) cancel(); }}>
      <DialogContent
        className="inset-0 left-0 top-0 z-[140] flex h-[100dvh] max-h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-white p-0 shadow-2xl sm:inset-auto sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[88vh] sm:w-[calc(100%-1.5rem)] sm:max-w-3xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-3xl"
        overlayClassName="z-[130] bg-slate-950/65 backdrop-blur-[1px]"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      >
        <header className="flex-none bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] text-white sm:px-7 sm:pb-5 sm:pt-6">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
              <CloudCog className="h-5 w-5 text-indigo-200" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-bold tracking-[0.18em] text-indigo-200">登录数据同步</div>
              <DialogTitle className="mt-1 text-lg font-bold leading-tight text-white sm:text-2xl">本机与云端数据有 {items.length} 处不同</DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5 text-slate-300 sm:text-sm">
                请逐项选择保留哪一边。确认前不会同步，自动同步也会暂停。
              </DialogDescription>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5 sm:gap-2">
            {GLOBAL_ACTIONS.map(({ choice, label, icon: Icon }) => (
              <button
                key={choice}
                type="button"
                disabled={busy}
                className={cx(
                  'flex min-h-9 items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 text-[11px] font-bold leading-tight ring-1 transition-colors disabled:opacity-60 sm:text-xs',
                  selectedUniform === choice ? 'bg-white text-indigo-800 ring-white' : 'bg-white/5 text-white ring-white/20 hover:bg-white/10'
                )}
                onClick={() => setChoices(uniformLoginSyncChoices(items, choice))}
              >
                <Icon className="hidden h-3.5 w-3.5 flex-none sm:block" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </header>

        <main className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain bg-slate-50/70 px-3 py-3 sm:px-7 sm:py-5">
          {items.map((item) => (
            <DiffItemCard
              key={item.id}
              item={item}
              choice={choices[item.id] || LOGIN_SYNC_CHOICES.MERGE}
              disabled={busy}
              onChoice={(choice) => setChoices((current) => ({ ...current, [item.id]: choice }))}
            />
          ))}
          {error ? (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
        </main>

        <footer className="flex flex-none flex-col-reverse gap-2 border-t border-slate-200 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:items-center sm:justify-end sm:px-7 sm:py-4">
          <button type="button" className="flex h-11 items-center justify-center rounded-xl border border-slate-200 px-5 text-sm font-semibold text-slate-600 disabled:opacity-50" onClick={cancel} disabled={busy}>
            暂不同步
          </button>
          {phase === 'failed' || phase === 'checking' ? (
            <button type="button" className="flex h-11 items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 text-sm font-bold text-white disabled:opacity-50" onClick={() => void recheck()} disabled={busy}>
              {phase === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {phase === 'checking' ? '正在重新检查…' : '重新检查差异'}
            </button>
          ) : (
            <button type="button" className="flex h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-bold text-white disabled:opacity-50" onClick={() => void confirm()} disabled={busy}>
              {phase === 'applying' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudCog className="h-4 w-4" />}
              {phase === 'applying' ? '正在同步…' : '确认并同步'}
            </button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
