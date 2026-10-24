import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { useDemoActive, useFeatureDemo } from '../../components/rbac/demo-lock.jsx';

// 通知演示：用当天真实雷达结论生成一条「如果你开了预警，你会收到」的预览。
// 只用服务端预告接口（卖出侧 + 价差），买入侧本就不下发，这里显示为「升级查看」。
export const NOTIFY_TEASER_PATH = '/api/notify/demo-teaser/radar';

export function buildNotifyTeaserMessage(teaser) {
  const pair = teaser?.bestPair;
  if (!pair?.sell || !Number.isFinite(Number(pair.spread))) return null;
  const spread = Number(pair.spread);
  const pct = Number.isFinite(Number(pair.percentile)) ? `（近 ${pair.historyDays ?? 20} 日 ${pair.percentile} 分位）` : '';
  return {
    date: teaser.date || '',
    title: `纳指溢价轮动提醒 · 价差 ${spread.toFixed(2)}%`,
    body: `卖出 ${pair.sell.code} ${pair.sell.name}（溢价 ${Number(pair.sell.premium).toFixed(2)}%）→ 买入 ●●●●●●，价差 ${spread.toFixed(2)}%${pct}。10 万元本金约多换回 ¥${Math.round(spread * 1000).toLocaleString('zh-CN')}。`,
  };
}

export function NotifyDemoTeaserCard() {
  const active = useDemoActive();
  const demo = useFeatureDemo();
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    fetch(NOTIFY_TEASER_PATH, { headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (alive && json?.ok) setMessage(buildNotifyTeaserMessage(json.data)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [active]);

  if (!active || !message) return null;
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 sm:p-5">
      <div className="flex items-center gap-2 text-sm font-bold text-amber-900">
        <BellRing className="h-4 w-4" aria-hidden="true" />
        如果你开了溢价预警，{message.date} 收盘后你会收到：
      </div>
      <div className="mt-3 rounded-xl bg-white p-3 shadow-xs ring-1 ring-amber-100">
        <div className="text-sm font-semibold text-slate-900">{message.title}</div>
        <p className="mt-1 text-xs leading-5 text-slate-600">{message.body}</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-800">
        <span>这是今天的真实数据。开通后推送到微信 / Bark / 邮箱，不用每天盯盘。</span>
        {demo?.onUpgrade ? (
          <button type="button" onClick={() => demo.onUpgrade()} className="rounded-lg bg-amber-500 px-3 py-1.5 font-bold text-white hover:bg-amber-600">
            开通提醒
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default NotifyDemoTeaserCard;
