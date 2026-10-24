import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';

// 换基演示「用真实溢价试一组」：只请求服务端预告接口（游客可读、每天限 3 组），
// 只展示用户自选这一组的价差结论；当日最优组合是谁不下发，只给差距。
export const SWITCH_TEASER_RADAR = '/api/notify/demo-teaser/radar';
export const SWITCH_TEASER_PAIR = '/api/notify/demo-teaser/switch';

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(json?.error || '公开数据暂不可用');
  return json.data;
}

export function formatYuan(value) {
  return `¥${Math.round(Number(value) || 0).toLocaleString('zh-CN')}`;
}

export function SwitchDemoTeaserCard({ onUpgrade }) {
  const [options, setOptions] = useState([]);
  const [sell, setSell] = useState('');
  const [buy, setBuy] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    getJson(SWITCH_TEASER_RADAR)
      .then((data) => {
        if (!alive) return;
        const list = (data.codes || []).map((code) => ({ code, name: data.names?.[code] || '' }));
        setOptions(list);
        setSell(list[0]?.code || '');
        setBuy(list[1]?.code || '');
      })
      .catch((err) => alive && setError(err.message));
    return () => { alive = false; };
  }, []);

  const check = async () => {
    if (!sell || !buy || sell === buy) { setError('请选择两只不同的纳指 ETF'); return; }
    setLoading(true);
    setError('');
    try {
      setResult(await getJson(`${SWITCH_TEASER_PAIR}?sell=${encodeURIComponent(sell)}&buy=${encodeURIComponent(buy)}`));
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const select = 'min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-slate-800';
  return (
    <section className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50 to-white p-4 shadow-xs sm:p-5">
      <div className="flex items-center gap-2 text-sm font-bold text-indigo-900">
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        用今天的真实溢价试一组
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">选你手里的（卖出）和想换的（买入），看今天换一次能多换回多少。演示每天可查 3 组。</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select aria-label="卖出" className={select} value={sell} onChange={(e) => setSell(e.target.value)}>
          {options.map((o) => <option key={o.code} value={o.code}>卖 {o.code} {o.name}</option>)}
        </select>
        <span className="hidden text-slate-400 sm:inline" aria-hidden="true">→</span>
        <select aria-label="买入" className={select} value={buy} onChange={(e) => setBuy(e.target.value)}>
          {options.map((o) => <option key={o.code} value={o.code}>买 {o.code} {o.name}</option>)}
        </select>
        <button type="button" onClick={check} disabled={loading || !options.length} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {loading ? '计算中…' : '算一下'}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
      {result ? (
        <div className="mt-3 rounded-xl bg-white p-3 text-sm leading-6 text-slate-700 ring-1 ring-slate-100">
          <div>
            {result.date} 收盘口径，价差 <b className={result.spread > 0 ? 'text-rose-600' : 'text-slate-800'}>{result.spread.toFixed(2)}%</b>
            {result.triggered ? '，已达到换基阈值' : `，未达到 ${result.threshold}% 阈值`}。
          </div>
          {result.spread > 0 ? <div>10 万元本金换一次约多换回 <b className="text-rose-600">{formatYuan(result.per100k)}</b> 的溢价差。</div> : null}
          {result.gapToBest > 0 ? (
            <div className="mt-1 text-indigo-700">
              今天的最优组合比你选的还高 <b>{result.gapToBest.toFixed(2)}%</b>。
              {onUpgrade ? <button type="button" onClick={onUpgrade} className="ml-1 font-semibold underline">升级查看是哪一组</button> : '升级查看是哪一组。'}
            </div>
          ) : null}
          <div className="mt-1 text-[11px] text-slate-400">还可查 {result.remaining} 组 · 升级 VIP 后可保存方案并在触发时推送提醒</div>
        </div>
      ) : null}
    </section>
  );
}

export default SwitchDemoTeaserCard;
