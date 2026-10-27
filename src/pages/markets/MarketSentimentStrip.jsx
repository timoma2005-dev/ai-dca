import { useEffect, useState } from 'react';
import { Sliders, X } from 'lucide-react';
import { cx } from '../../components/experience-ui.jsx';
import { BREADTH_ITEMS, DEFAULT_RULES, useMarketSentimentWeather } from './marketSentimentWeather.js';
import { setMobileBottomSheetOpen } from '../../app/mobileBottomSheet.js';
import { changeToneClass } from './marketDisplayUtils.js';
import { formatSentimentTime, sentimentCellState } from './marketSentimentSnapshot.js';

function createDefaultSettings() {
  return { rules: { ...DEFAULT_RULES } };
}


function fearGreedLabel(value) {
  if (value <= 25) return '极度恐慌';
  if (value <= 45) return '恐慌避险';
  if (value < 55) return '中性';
  if (value < 75) return '贪婪';
  return '极度贪婪';
}

function vixLabel(value) {
  if (value < 15) return '极度平静';
  if (value < 20) return '平静';
  if (value < 25) return '正常波动';
  if (value < 30) return '警戒升温';
  return '恐慌升温';
}

function formatChangePercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '暂无';
  const percent = Number(value);
  return (percent > 0 ? '+' : '') + percent.toFixed(2) + '%';
}

export function MarketSentimentStrip() {
  const [settings, setSettings] = useState(createDefaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    error, fearGreed, vix, breadth, tempLabel, weather, snapshot,
  } = useMarketSentimentWeather(settings.rules);
  const snapshotTime = formatSentimentTime(snapshot.lastSuccessAt);

  useEffect(() => {
    setMobileBottomSheetOpen('market-sentiment-settings', settingsOpen);
    return () => setMobileBottomSheetOpen('market-sentiment-settings', false);
  }, [settingsOpen]);

  const updateRule = (key, fallback, value) => {
    const parsed = Number(value);
    setSettings((previous) => ({
      ...previous,
      rules: { ...previous.rules, [key]: Number.isFinite(parsed) ? parsed : fallback },
    }));
  };

  return (
    <>
      <div className="market-collapsible">
      {/* 情绪条：一行展示。天气为主指标在左，其余指标横向滑动，右侧只留设置；刷新统一用列表头的刷新按钮。 */}
      <section className={cx('market-sentiment-strip relative z-10 isolate overflow-hidden rounded-2xl border px-2.5 py-2 shadow-sm transition-colors sm:px-3', weather.surfaceClass)} aria-label="市场情绪指标">
        <span className={cx('pointer-events-none absolute -right-1 -top-4 select-none text-6xl opacity-20', weather.decorClass)} aria-hidden="true">{weather.icon}</span>
        <span className={cx('pointer-events-none absolute -bottom-12 -left-4 h-28 w-28 rounded-full blur-3xl', weather.orbClass)} aria-hidden="true" />
        <div className="market-sentiment-strip__row relative z-[1] flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-1.5 border-r border-[var(--market-border)] pr-2.5" title="市场情绪：由纳指、F&G、VIX 和 ETF 晴雨比综合计算">
            <span className={cx('text-xl leading-none', weather.glow)}>{weather.icon}</span>
            <div className="leading-tight">
              <div className="text-xs font-bold text-[var(--market-text-strong)]">{weather.name}</div>
              <div className="font-mono text-[11px] font-black text-[var(--market-rise)]">{tempLabel}</div>
            </div>
          </div>
          <div className="market-sentiment-strip__chips flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap" role="group" aria-label="市场情绪指标（可横向滑动）">
            <div className="flex shrink-0 items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 backdrop-blur-sm dark:bg-slate-900/40" title="CNN 贪婪与恐慌指数">
              <span className="text-[10px] text-[var(--market-text-muted)]">F&G</span>
              <span className="font-mono text-xs font-black text-sky-500">{fearGreed ?? '—'}</span>
              {fearGreed != null ? <span className="text-[10px] font-bold text-sky-600 dark:text-sky-400">{fearGreedLabel(fearGreed)}</span> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 backdrop-blur-sm dark:bg-slate-900/40" title="CBOE 波动率指数">
              <span className="text-[10px] text-[var(--market-text-muted)]">VIX</span>
              <span className="font-mono text-xs font-black text-emerald-500">{vix == null ? '—' : vix.toFixed(1)}</span>
              {vix != null ? <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">{vixLabel(vix)}</span> : null}
            </div>
            {[
              ['QQQ', snapshot.qqq],
              ['VOO', snapshot.voo],
            ].map(([symbol, view]) => {
              const cell = sentimentCellState(view, { loading: snapshot.loading, format: formatChangePercent });
              return (
                <div key={symbol} className="flex shrink-0 items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 backdrop-blur-sm dark:bg-slate-900/40" title={symbol + ' 当日涨幅 · ' + cell.title} data-testid={'sentiment-' + symbol}>
                  <span className="text-[10px] text-[var(--market-text-muted)]">{symbol}</span>
                  <span className={cx('font-mono text-xs font-black', changeToneClass(view.value))}>{cell.text}</span>
                  {cell.note ? <span className="text-[10px] font-bold text-amber-600">{cell.note}</span> : null}
                </div>
              );
            })}
            <div className="flex shrink-0 items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 backdrop-blur-sm dark:bg-slate-900/40" title="纳指 ETF 当日涨跌家数">
              <span className="text-[10px] text-[var(--market-text-muted)]">晴雨比</span>
              <span className="font-mono text-xs font-bold text-[var(--market-rise)]">{breadth.up}晴</span>
              <div className="h-1.5 w-6 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <div className="h-full rounded-full bg-[var(--market-rise)]" style={{ width: (breadth.up / BREADTH_ITEMS.length) * 100 + '%' }} />
              </div>
              <span className="font-mono text-xs font-bold text-[var(--market-text-muted)]">{breadth.down}雨</span>
            </div>
          </div>
          <button type="button" aria-label="市场情绪设置" title="设置天气分界线" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/70 text-[var(--market-text-muted)] transition hover:text-[var(--market-text-strong)] dark:bg-slate-900/40" onClick={() => setSettingsOpen(true)}>
            <Sliders size={13} />
          </button>
        </div>
        {error || snapshot.stale ? <div className="relative z-[1] mt-1 text-[10px] text-amber-600">{snapshotTime ? `数据延迟，显示 ${snapshotTime} 的最近可用值` : '行情指标暂不可用'}</div> : null}
      </section>
      </div>

      {settingsOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-end bg-slate-900/45 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="市场情绪设置">
          <div className="h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 shadow-2xl dark:bg-slate-900 sm:h-full sm:w-[420px] sm:rounded-none">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 dark:border-slate-800">
              <div><h3 className="text-sm font-bold text-slate-900 dark:text-white">市场情绪设置</h3><p className="mt-1 text-[10px] text-slate-400">调整天气状态的显示分界线</p></div>
              <button type="button" aria-label="关闭设置" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setSettingsOpen(false)}><X size={16} /></button>
            </div>
            <div className="mt-4 space-y-2">
              {[
                ['blazingSunTemp', '☀️ 艳阳高照，温标 ≥', 25],
                ['partlyCloudyTemp', '🌤️ 多云见晴，温标 ≥', 10],
                ['overcastTemp', '☁️ 阴云密布，温标 ≥', 0],
                ['rainyTemp', '🌧️ 细雨连绵，温标 ≥', -10],
                ['fgGreed', 'F&G 贪婪阈值 ≥', 75],
                ['fgStorm', 'F&G 恐慌阈值 ≤', 20],
                ['vixStorm', 'VIX 恐慌阈值 ≥', 30],
              ].map(([key, label, fallback]) => (
                <label key={key} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] dark:border-slate-800 dark:bg-slate-800/60">
                  <span className="text-slate-700 dark:text-slate-200">{label}</span>
                  <input type="number" value={settings.rules[key]} onChange={(event) => updateRule(key, fallback, event.target.value)} className="w-16 rounded border border-slate-200 bg-white px-1.5 py-1 text-right font-mono font-bold dark:border-slate-700 dark:bg-slate-900" />
                </label>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
              <button type="button" className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800" onClick={() => setSettings(createDefaultSettings())}>恢复默认</button>
              <button type="button" className="rounded-lg bg-[var(--market-accent)] px-4 py-1.5 text-xs font-bold text-white hover:opacity-90" onClick={() => setSettingsOpen(false)}>保存设置</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
