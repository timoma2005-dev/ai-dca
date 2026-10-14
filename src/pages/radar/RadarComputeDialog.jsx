import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cx } from '../../components/experience-ui.jsx';
import { setMobileBottomSheetOpen } from '../../app/mobileBottomSheet.js';
import { RADAR_COMPUTE_STATE } from './useRadarData.js';

/** 底部导航联动的唯一稳定 source（plan §5.3）。 */
export const RADAR_COMPUTE_SHEET_SOURCE = 'admin-radar-compute';

const MOBILE_MEDIA_QUERY = '(max-width: 639px)';

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return matches;
}

// 各高危时段的针对性说明（plan §2 / §3.1 定案；后端 force 会绕过节假日检查并按当前自然日写日期）。
const RISK_INTRO = {
  'intraday-risk':
    '当前处于盘中风险窗口（09:30–15:00，含午休）。盘中现价与尚未披露的当日净值错配，溢价会严重失真。',
  'pre-market':
    '当前处于盘前时段（00:00–09:30）。当日收盘数据尚未形成，而后端会按当前自然日写入快照日期，不能把昨日净值当作今日收盘。',
  'market-closed':
    '当前为休市日。后端强制计算会绕过节假日检查，把休市日写成正式快照日期并写入历史。',
  'calendar-unconfirmed':
    '当前日期的交易日历待确认。后端强制计算会绕过节假日检查；若实际为节假日，休市日将被写成正式快照。'
};

const RISK_ITEMS = [
  {
    title: '净值与现价错配',
    desc: '净值披露时间可能晚于现价，两者日期可能不同日，计算出的溢价参考严重失真。'
  },
  {
    title: '污染正式历史',
    desc: '计算会写入价差历史（最多 20 条）与特征历史（最长 90 条），错误样本可能影响后续分位与统计。'
  },
  {
    title: '定时任务复用',
    desc: '可能使今晚定时任务复用当天快照，无法自动纠正；后续可通过再次强制重算修复，但不保证立即生效。'
  }
];

const MODE_META = {
  [RADAR_COMPUTE_STATE.WAITING_NOTICE]: {
    title: '已进入收盘后等待窗口',
    description: '当前处于 15:00–21:35 的净值披露等待期，此窗口不提供手动计算。'
  },
  [RADAR_COMPUTE_STATE.REGULAR_CONFIRM]: {
    title: '确认执行雷达计算',
    description: '当前已到工作日 21:35 计划计算窗口；净值披露可能延迟，界面不验证净值与价格是否同日。'
  },
  [RADAR_COMPUTE_STATE.RISK_CONFIRM]: {
    title: '高危操作：当前时段不适合计算',
    description: '强制计算会立即写入正式快照与历史，请确认已理解以下影响。'
  }
};

export function RadarComputeDialog({
  computeState,
  session,
  riskAcknowledged,
  onRiskAcknowledgedChange,
  onCancel,
  onSubmit
}) {
  const open =
    computeState === RADAR_COMPUTE_STATE.WAITING_NOTICE ||
    computeState === RADAR_COMPUTE_STATE.REGULAR_CONFIRM ||
    computeState === RADAR_COMPUTE_STATE.RISK_CONFIRM;
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const meta = MODE_META[computeState] || MODE_META[RADAR_COMPUTE_STATE.REGULAR_CONFIRM];

  // 统一 open 生命周期 + effect cleanup：打开（任意形态）注册 source，
  // 所有关闭路径（取消 / Esc / 遮罩 / 提交 / 权限变化 / Tab 切换 / 卸载）经状态回落触发注销。
  useEffect(() => {
    setMobileBottomSheetOpen(RADAR_COMPUTE_SHEET_SOURCE, open);
    return () => setMobileBottomSheetOpen(RADAR_COMPUTE_SHEET_SOURCE, false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel?.(); }}>
      <DialogContent
        showCloseButton={!isMobile}
        className={
          isMobile
            ? // 移动底部浮窗：max-h 90dvh、正文可滚动、按钮留安全区。
              'fixed inset-x-0 bottom-0 top-auto z-50 flex max-h-[90dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-2xl border bg-background p-0 shadow-lg data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom'
            : 'sm:max-w-lg'
        }
      >
        <div className={cx(isMobile && 'border-b border-slate-100 px-5 pb-3 pt-4')}>
          <DialogTitle
            className={cx(
              'flex items-center gap-2 text-base font-bold leading-6',
              computeState === RADAR_COMPUTE_STATE.RISK_CONFIRM ? 'text-rose-700' : 'text-slate-900'
            )}
          >
            {computeState === RADAR_COMPUTE_STATE.RISK_CONFIRM && (
              <span aria-hidden="true" className="text-rose-600">
                ⚠
              </span>
            )}
            {meta.title}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm leading-6 text-slate-500">{meta.description}</DialogDescription>
        </div>

        <div
          className={cx(
            'min-h-0 flex-1 overflow-y-auto text-sm leading-6 text-slate-600',
            isMobile ? 'px-5 py-4' : ''
          )}
        >
          {computeState === RADAR_COMPUTE_STATE.WAITING_NOTICE && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-[13px] text-blue-800">
              建议等待 21:35 定时任务自动计算。若确有盘前 / 休市日调试需要，请在对应时段使用高危确认入口，
              界面不把任何时段标注为“安全期”。
            </div>
          )}

          {computeState === RADAR_COMPUTE_STATE.REGULAR_CONFIRM && (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[13px]">
                <p className="font-semibold text-slate-700">本次计算将执行：</p>
                <ol className="mt-1.5 list-decimal space-y-1 pl-5">
                  <li>抓取纳指 ETF 收盘价与最新净值并计算溢价；</li>
                  <li>覆盖写入当日正式快照（nasdaq-radar:latest）；</li>
                  <li>更新价差历史（最多 20 条）与特征历史（最长 90 条）。</li>
                </ol>
              </div>
              <p className="text-[13px] text-slate-500">
                若今日已计算，本次覆盖可能使今晚定时任务复用当天快照；净值披露若延迟，结果可能需再次重算。
              </p>
            </div>
          )}

          {computeState === RADAR_COMPUTE_STATE.RISK_CONFIRM && (
            <div className="space-y-3">
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-medium text-rose-800">
                {RISK_INTRO[session.key] || RISK_INTRO['market-closed']}
              </div>
              <div>
                <p className="mb-1.5 text-[13px] font-semibold text-slate-800">强制执行的后果：</p>
                <ol className="list-decimal space-y-2 pl-5 text-[13px]">
                  {RISK_ITEMS.map((item) => (
                    <li key={item.title}>
                      <b className="text-rose-700">{item.title}：</b>
                      {item.desc}
                    </li>
                  ))}
                </ol>
              </div>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3">
                <input
                  type="checkbox"
                  checked={riskAcknowledged}
                  onChange={(event) => onRiskAcknowledgedChange?.(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-rose-600"
                />
                <span className="text-[13px] font-semibold leading-5 text-rose-800">
                  我已知晓会覆盖正式快照及历史，并可能影响今晚自动更新
                </span>
              </label>
            </div>
          )}
        </div>

        <div
          className={cx(
            'flex items-center justify-end gap-2.5',
            isMobile ? 'border-t border-slate-100 bg-slate-50 px-5 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3' : ''
          )}
        >
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
          >
            {computeState === RADAR_COMPUTE_STATE.RISK_CONFIRM ? '放弃操作（推荐）' : computeState === RADAR_COMPUTE_STATE.WAITING_NOTICE ? '知道了' : '取消'}
          </button>
          {computeState === RADAR_COMPUTE_STATE.REGULAR_CONFIRM && (
            <button
              type="button"
              onClick={onSubmit}
              className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
            >
              开始计算
            </button>
          )}
          {computeState === RADAR_COMPUTE_STATE.RISK_CONFIRM && (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!riskAcknowledged}
              className="inline-flex min-h-10 items-center justify-center rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              强制覆盖正式数据
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default RadarComputeDialog;
