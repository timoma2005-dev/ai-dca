import { cx } from '../../components/experience-ui.jsx';
import { quotaEvents } from '../../app/radarScoreModel.js';

/** 侧栏「份额动态」：今天哪些基金放开 / 收紧 / 暂停申购 */
const TONES = {
  rose: 'bg-rose-100 text-rose-700',
  amber: 'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-700',
  indigo: 'bg-indigo-100 text-indigo-700',
  slate: 'bg-slate-100 text-slate-600',
};

export function RadarQuotaCard({ data }) {
  const { events, steadyCount } = quotaEvents(data);
  return (
    <section data-testid="radar-quota-card" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-900">份额动态</h3>
        <span className="text-[11px] text-slate-400">{data?.scoring?.date || data?.date || ''} 申购上限</span>
      </div>
      <ul className="space-y-2">
        {events.map((event) => (
          <li key={event.code} className="flex items-start gap-2 text-xs leading-5 text-slate-700">
            <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold', TONES[event.tone])}>{event.label}</span>
            <span className="min-w-0">{event.text}</span>
          </li>
        ))}
        <li className="flex items-start gap-2 text-xs leading-5 text-slate-500">
          <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-600">不变</span>
          <span>其余 {steadyCount} 只</span>
        </li>
      </ul>
      <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] leading-5 text-slate-400">
        回测（近一年深市 7 只）：额度放大 ≥2 倍后 5 日，相对同类溢价平均回落 0.39pp（29 次中 21 次回落）；收紧后平均上升 0.59pp。
      </p>
    </section>
  );
}

export default RadarQuotaCard;
