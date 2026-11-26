import { useCallback, useEffect, useRef, useState } from 'react';
import { Repeat } from 'lucide-react';
import { apiUrl } from '../app/apiBase.js';
import { Button } from '../components/ui/button.jsx';
import DeviationBars from './rotator/DeviationBars.jsx';
import SwitchPnlCard from './rotator/SwitchPnlCard.jsx';
import { authHeaders } from './rotator/rotatorApi.js';

// 日内轮动看板（adminRotator，SVIP 及以上）：cn 上腾讯行情源的 ratio_rotator 影子实例。
// 读：GET /api/rotator/status（每 5 秒）、GET /api/rotator/series（换车收益曲线的当日价格）；写：POST /api/rotator/holding 设置当前账户的持仓，
// POST /api/rotator/settings 设置当前账户的入场阈值 bps（默认 30；进程账户保存后下个交易日启动时生效）。
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
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const editedRef = useRef(false);
  const [enterInput, setEnterInput] = useState('');
  const [savingEnter, setSavingEnter] = useState(false);
  const [enterMsg, setEnterMsg] = useState('');
  const enterEditedRef = useRef(false);
  const [tab, setTab] = useState('live');

  const load = useCallback(async (signal) => {
    try {
      const json = await getStatus(signal);
      setData(json);
      setError('');
      if (!editedRef.current) {
        const h = json?.manual?.holdings || {};
        const [c] = Object.keys(h);
        if (c) setCode(c);
      }
      const userEnter = json?.settings?.enter_bps;
      if (!enterEditedRef.current && userEnter !== null && userEnter !== undefined) setEnterInput(String(userEnter));
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
  const pool = poolRows.map((r) => r.code);
  const stale = data?.age_s === null || data?.age_s === undefined || data.age_s > STALE_S;
  const holding = st?.holding;
  const settings = data?.settings || null;
  const enter = settings?.enter_bps ?? st?.params?.enter;
  const gap = st?.gap_bps;

  async function save() {
    if (!code) {
      setSaveMsg('请先选择代码');
      return;
    }
    setSaving(true);
    setSaveMsg('');
    try {
      await postHolding(code);
      editedRef.current = false;
      setSaveMsg('已保存，约 5 秒内生效');
      load();
    } catch (err) {
      setSaveMsg(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function saveEnter() {
    const v = Number(enterInput);
    const min = settings?.min ?? 1;
    const max = settings?.max ?? 500;
    if (enterInput === '' || !Number.isFinite(v) || v < min || v > max) {
      setEnterMsg(`阈值须在 ${min}~${max} bps 之间`);
      return;
    }
    setSavingEnter(true);
    setEnterMsg('');
    try {
      const json = await postSettings(v);
      enterEditedRef.current = false;
      setEnterMsg(json?.applies_to_process ? '已保存，轮动进程下个交易日 10:25 启动时生效' : '已保存，只影响你自己的视图');
      load();
    } catch (err) {
      setEnterMsg(err?.message || '保存失败');
    } finally {
      setSavingEnter(false);
    }
  }

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

      <div className="space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-10 shrink-0 text-sm font-medium">持仓</span>
          <select
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm sm:max-w-xs sm:flex-none"
            value={code}
            onChange={(e) => { editedRef.current = true; setCode(e.target.value); }}
          >
            {!code ? <option value="">选择代码</option> : null}
            {(pool.length ? pool : [code].filter(Boolean)).map((c) => (
              <option key={c} value={c}>{c} {poolRows.find((r) => r.code === c)?.name || ''}</option>
            ))}
          </select>
          <Button size="sm" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
          {saveMsg ? <span className="basis-full text-xs text-muted-foreground sm:basis-auto">{saveMsg}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-10 shrink-0 text-sm font-medium">阈值</span>
          <input
            type="number"
            inputMode="decimal"
            min={settings?.min ?? 1}
            max={settings?.max ?? 500}
            step="1"
            className="h-9 w-20 rounded-md border border-input bg-background px-2 text-sm tabular-nums"
            value={enterInput}
            onChange={(e) => { enterEditedRef.current = true; setEnterInput(e.target.value); }}
          />
          <span className="text-sm text-muted-foreground">bps</span>
          <Button size="sm" onClick={saveEnter} disabled={savingEnter}>{savingEnter ? '保存中…' : '保存'}</Button>
          {enterMsg ? <span className="basis-full text-xs text-muted-foreground sm:basis-auto">{enterMsg}</span> : null}
        </div>
        <div className="text-xs text-muted-foreground">
          持仓 − 最便宜 ≥ 阈值时提示换车（默认 {settings?.default_enter_bps ?? 30} bps），按账户保存
          {data?.is_owner && settings ? `；进程当前 ${settings.process_enter_bps ?? '—'} bps · 下次启动 ${settings.next_enter_bps ?? '—'} bps` : ''}
        </div>
      </div>

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
    </div>
  );
}
