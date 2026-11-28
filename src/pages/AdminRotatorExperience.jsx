import { useCallback, useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import { apiUrl } from '../app/apiBase.js';
import CloseAdvice from './rotator/CloseAdvice.jsx';
import DeviationBars from './rotator/DeviationBars.jsx';
import SwitchPnlCard from './rotator/SwitchPnlCard.jsx';
import HoldingSettings from './rotator/HoldingSettings.jsx';
import { authHeaders } from './rotator/rotatorApi.js';

// 日内轮动看板（adminRotator，SVIP 及以上）：cn 上腾讯行情源的 ratio_rotator 影子实例。
// 读：GET /api/rotator/status（每 5 秒）、GET /api/rotator/series（换车收益曲线的当日价格）；写：POST /api/rotator/holding 设置当前账户的持仓，
// POST /api/rotator/settings 设置当前账户的入场阈值 bps（默认 30；进程账户保存后下个交易日启动时生效）。
// status.close：14:56 全池偏离快照按当前账户持仓算出的收盘调仓建议（阈值 15bps，只提示）。
// 持仓按账户存 SQLite（rotator_api.py），行情/偏离全局共享；运行日志与进程信号只返回给驱动进程的账户（is_owner）。
// 权限由 nginx auth_request（api:rotator）校验，前端只负责展示。
export const ROTATOR_REFRESH_MS = 5000;
const STALE_S = 20;

async function getStatus(signal) {
  const res = await fetch(apiUrl('/api/rotator/status'), {
    method: 'GET', headers: authHeaders(), credentials: 'same-origin', redirect: 'manual', signal, cache: 'no-store'
  });
  if (res.status === 401) throw Error('未登录');
  if (res.status === 403) throw Error('需要 SVIP');
  if (!res.ok) throw Error(`读取失败（HTTP ${res.status}）`);
  return res.json();
}

async function postHolding(code) {
  const res = await fetch(apiUrl('/api/rotator/holding'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    credentials: 'same-origin',
    redirect: 'manual',
    body: JSON.stringify({ code })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(json?.message || `保存失败（HTTP ${res.status}）`);
  return json;
}

async function postSettings(enterBps) {
  const res = await fetch(apiUrl('/api/rotator/settings'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    credentials: 'same-origin',
    redirect: 'manual',
    body: JSON.stringify({ enter_bps: enterBps })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(json?.message || `保存失败（HTTP ${res.status}）`);
  return json;
}

const clock = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—');

export default function AdminRotatorExperience() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('live');

  const load = useCallback(async (signal) => {
    try {
      const json = await getStatus(signal);
      setData(json);
      setError('');
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err?.message || '读取失败');
    }
  }, []);

  useEffect(() => {
    let controller = new AbortController();
    load(controller.signal);
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      controller.abort();
      controller = new AbortController();
      load(controller.signal);
    }, ROTATOR_REFRESH_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [load]);

  const st = data?.status || null;
  const rows = st?.rows || [];
  // 盘前/午休没有行情行时，下拉框用接口给的默认池
  const poolRows = rows.length ? rows : (data?.pool || []);
  const stale = data?.age_s === null || data?.age_s === undefined || data.age_s > STALE_S;
  const holding = st?.holding;
  const savedCode = Object.keys(data?.manual?.holdings || {})[0] || holding || '';
  const settings = data?.settings || null;
  const enter = settings?.enter_bps ?? st?.params?.enter;
  const gap = st?.gap_bps;

  const statusText = `腾讯行情 · 每 5 秒刷新 · 更新于 ${clock(st?.updated_at)}${stale && st ? '（非实时）' : ''}`;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-3 px-3 py-4 sm:space-y-4 sm:px-4 sm:py-6">
      <div>
        <div className="flex items-center gap-2">
          <Repeat className="h-5 w-5 shrink-0" />
          <h1 className="whitespace-nowrap text-xl font-semibold">日内轮动</h1>
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${data?.running ? 'bg-emerald-500/15 text-emerald-600' : 'bg-red-500/15 text-red-600'}`}>
            {data?.running ? '运行中' : '未运行'}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground" title={st?.note || ''}>{statusText}</div>
      </div>

      {error ? <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</div> : null}

      <HoldingSettings
        pool={poolRows}
        code={savedCode}
        enter={enter}
        settings={settings}
        isOwner={!!data?.is_owner}
        onHolding={async (c) => { await postHolding(c); load(); }}
        onEnter={async (v) => { const json = await postSettings(v); load(); return json; }}
      />

      <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
        {[['live', '实时偏离'], ['pnl', '换车收益']].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`flex-1 rounded-md px-3 py-1.5 ${tab === k ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'}`}
          >{label}</button>
        ))}
      </div>

      {tab === 'pnl'
        ? <SwitchPnlCard pool={poolRows} holding={holding} commBps={st?.params?.comm_bps ?? 0.5} />
        : <DeviationBars rows={rows} holding={holding} cheapest={st?.cheapest} gap={gap} enter={enter} at={clock(st?.updated_at)} />}

      {tab === 'live' ? <CloseAdvice close={data?.close} rows={rows} holding={holding} cheapest={st?.cheapest} gap={gap} /> : null}
    </div>
  );
}
