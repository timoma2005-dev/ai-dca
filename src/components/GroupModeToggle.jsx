import { useSyncExternalStore } from 'react';
import { cx } from './experience-ui.jsx';

export function useGroupMode(store) {
  const mode = useSyncExternalStore(store.subscribe, store.getSnapshot, () => 'company');
  return [mode, store.setMode];
}

export function GroupModeToggle({ value, onChange, label = '分组方式' }) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-slate-200 bg-slate-100 p-0.5">
      {[['company', '按公司'], ['list', '列表']].map(([mode, text]) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cx(
            'whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400',
            value === mode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >{text}</button>
      ))}
    </div>
  );
}
