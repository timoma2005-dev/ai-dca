import { LayoutGrid, List, Plus, Search } from 'lucide-react';
import { cx } from '../../components/experience-ui.jsx';
import SegmentedControl from '../../components/arc/segmented-control/segmented-control.jsx';
import AnimatedCounter from '../../components/arc/animated-counter/animated-counter.jsx';

export function SwitchStrategyMetricsBar({
  total = 3,
  monitoring = 2,
  triggeredToday = 3,
  keyword = '',
  onKeywordChange,
  viewMode = 'grid',
  onViewModeChange,
  onCreate
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4 space-y-2.5 sm:space-y-0 sm:flex sm:items-center sm:justify-between shadow-xs">
      {/* 3 个指标：中性底色 + 彩色圆点，数字变化时按位滚动（Arc AnimatedCounter） */}
      <div className="grid grid-cols-3 sm:flex sm:flex-wrap sm:items-center gap-1.5 sm:gap-2 text-left">
        {[
          { key: 'total', label: '方案总数', value: total, dot: 'bg-slate-400' },
          { key: 'monitoring', label: '监控中', value: monitoring, dot: 'bg-emerald-500' },
          { key: 'triggered', label: '今日触发', value: triggeredToday, dot: 'bg-amber-500', suffix: '\u00a0次' }
        ].map((item) => (
          <div key={item.key} className="min-w-[84px] rounded-xl border border-slate-200/80 bg-slate-50/60 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className={cx('h-1.5 w-1.5 rounded-full', item.dot)} aria-hidden="true" />
              {item.label}
            </div>
            <AnimatedCounter className="mt-1 !text-base font-medium text-slate-900 sm:!text-lg" value={Number(item.value) || 0} suffix={item.suffix || ''} />
          </div>
        ))}
      </div>

      {/* 搜索框与新建方案按钮 */}
      <div className="flex items-center space-x-2 pt-1 sm:pt-0">
        <div className="relative flex-1 sm:w-44">
          <input
            type="text"
            placeholder="搜索标的..."
            value={keyword}
            onChange={(e) => onKeywordChange?.(e.target.value)}
            className="w-full pl-7 pr-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
          />
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-2 pointer-events-none" />
        </div>

        {/* 视图切换 */}
        <div className="hidden sm:block">
          <SegmentedControl
            className="arc-seg-brand arc-seg-icon"
            label="视图"
            value={viewMode}
            onValueChange={(next) => onViewModeChange?.(next)}
            options={[
              { value: 'grid', label: <><LayoutGrid aria-hidden="true" /><span className="sr-only">卡片视图</span></> },
              { value: 'table', label: <><List aria-hidden="true" /><span className="sr-only">列表视图</span></> }
            ]}
          />
        </div>

        <button
          type="button"
          onClick={onCreate}
          data-onboarding="switch-create"
          className="shrink-0 flex items-center space-x-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-lg text-xs font-medium shadow-xs shadow-indigo-200 transition-[background-color,transform] duration-150 active:scale-[0.97] cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建方案</span>
        </button>
      </div>
    </div>
  );
}
