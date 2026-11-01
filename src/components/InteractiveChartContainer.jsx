import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './experience-ui.jsx';
import { BarChart3, LineChart, TrendingUp, Maximize2, Minimize2 } from 'lucide-react';

/**
 * InteractiveChartContainer - 交互式图表容器
 * 提供视图切换和图表控制，优化移动端。
 * 全屏用 portal 挂到 body：抽屉/侧栏带 transform 或 overflow 时，fixed 会被困在祖先里导致按钮被遮挡、无法退出（2026-11-01 修复）。
 * 全屏时可点右上角、按 Esc 或点遮罩退出。children 可为函数 ({ fullscreen }) => node，用于全屏时加高图表。
 */
export function InteractiveChartContainer({
  children,
  views = [],
  activeView,
  onViewChange,
  className
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) return undefined;
    const onKey = (ev) => { if (ev.key === 'Escape') setIsFullscreen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [isFullscreen]);

  const viewIcons = {
    equity: LineChart,
    kline: BarChart3,
    premium: TrendingUp
  };

  const body = typeof children === 'function' ? children({ fullscreen: isFullscreen }) : children;

  const card = (
    <div className={cx(
      'rounded-xl sm:rounded-2xl border-2 border-slate-200 bg-white shadow-sm overflow-hidden',
      isFullscreen ? 'fixed inset-2 sm:inset-4 z-[1001] flex flex-col shadow-2xl' : className
    )}>
      {/* 图表控制栏 */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 sm:px-4 py-2 sm:py-3 flex-shrink-0">
        <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto scrollbar-hide">
          {views.map(view => {
            const Icon = viewIcons[view.id] || BarChart3;
            const isActive = activeView === view.id;
            return (
              <button
                key={view.id}
                type="button"
                onClick={() => onViewChange(view.id)}
                className={cx(
                  'flex items-center gap-1 sm:gap-1.5 rounded-lg px-2 sm:px-3 py-1.5 text-xs font-semibold transition-all whitespace-nowrap flex-shrink-0',
                  isActive
                    ? 'bg-indigo-100 text-indigo-700 shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className={isFullscreen ? 'inline' : 'hidden sm:inline'}>{view.label}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setIsFullscreen(!isFullscreen)}
          className={cx(
            'flex-shrink-0 ml-2 inline-flex items-center gap-1 rounded-lg',
            isFullscreen ? 'bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-700' : 'text-slate-600 hover:text-slate-900'
          )}
          aria-label={isFullscreen ? '退出全屏' : '全屏'}
          title={isFullscreen ? '退出全屏（Esc）' : '全屏'}
        >
          {isFullscreen ? (
            <><Minimize2 className="h-4 w-4" /><span>退出全屏</span></>
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* 图表内容区 */}
      <div className={cx('p-3 sm:p-6', isFullscreen && 'flex-1 overflow-auto')}>
        {body}
      </div>
    </div>
  );

  if (!isFullscreen || typeof document === 'undefined') return card;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[1000] bg-slate-900/50" onClick={() => setIsFullscreen(false)} aria-hidden="true" />
      {card}
    </>,
    document.body
  );
}
