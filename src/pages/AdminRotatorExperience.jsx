import { useCallback, useEffect, useRef, useState } from 'react';
import { Repeat } from 'lucide-react';
import { apiUrl } from '../app/apiBase.js';
import { loadCloudSession } from '../app/authSession.js';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';

// 日内轮动看板（adminRotator，仅超级管理员）：cn 上腾讯行情源的 ratio_rotator 影子实例。
// 读：GET /api/rotator/status（每 5 秒）；写：POST /api/rotator/holding 手动设置持仓。
// 权限由 nginx auth_request（api:rotator）校验，前端只负责展示。
export const ROTATOR_REFRESH_MS = 5000;
const STALE_S = 20;

function authHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  const s = loadCloudSession();
  if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;
  return headers;
}

async function getStatus(signal) {
  const res = await fetch(apiUrl('/api/rotator/status'), {
    method: 'GET', headers: authHeaders(), credentials: 'same-origin', redirect: 'manual', signal, cache: 'no-store'
  });
  if (res.status === 401) throw Error('未登录');
  if (res.status === 403) throw Error('需要超级管理员');
  if (!res.ok) throw Error(`读取失败（HTTP ${res.status}）`);
  return res.json();
}

async function postHolding(code, shares) {
  const res = await fetch(apiUrl('/api/rotator/holding'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    credentials: 'same-origin',
    redirect: 'manual',
    body: JSON.stringify({ code, shares })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(json?.message || `保存失败（HTTP ${res.status}）`);
  return json;
}

const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
const bps = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(0)}`);
const clock = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—');

function Stat({ label, value, hint, tone = '' }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export default function AdminRotatorExperience() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [shares, setShares] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const editedRef = useRef(false);

  const load = useCallback(async (signal) => {
    try {
      const json = await getStatus(signal);
      setData(json);
      setError('');
      if (!editedRef.current) {
        const h = json?.manual?.holdings || {};
        const [c, n] = Object.entries(h)[0] || [];
        if (c) { setCode(c); setShares(String(n)); }
      }
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
  const pool = rows.length ? rows.map((r) => r.code) : [];
  const stale = data?.age_s === null || data?.age_s === undefined || data.age_s > STALE_S;
  const holding = st?.holding;
  const enter = st?.params?.enter;
  const gap = st?.gap_bps;
  const sig = st?.last_signal;

  async function save() {
    const n = Number(shares);
    if (!code || !Number.isInteger(n) || n <= 0 || n % 100) {
      setSaveMsg('股数须为 100 的正整数倍');
      return;
    }
    setSaving(true);
    setSaveMsg('');
    try {
      await postHolding(code, n);
      editedRef.current = false;
      setSaveMsg('已保存，约 5 秒内生效');
      load();
    } catch (err) {
      setSaveMsg(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-2">
        <Repeat className="h-5 w-5" />
        <h1 className="text-xl font-semibold">日内轮动</h1>
        <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${data?.running ? 'bg-emerald-500/15 text-emerald-600' : 'bg-red-500/15 text-red-600'}`}>
          {data?.running ? '运行中' : '未运行'}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          腾讯行情 · 每 5 秒刷新 · 更新于 {clock(st?.updated_at)}{stale && st ? `（非实时，显示最近一条${st.note ? `：${st.note}` : ''}）` : ''}
        </span>
      </div>

      {error ? <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</div> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="持仓" value={holding || '—'}
          hint={holding && st?.holdings?.[holding] ? `${Number(st.holdings[holding]).toLocaleString()} 股 · 已持有 ${fmt(st?.held_min, 0)} 分钟` : ''} />
        <Stat label="最便宜" value={st?.cheapest || '—'} hint={rows[0]?.name || ''} />
        <Stat label="持仓 − 最便宜" value={gap === null || gap === undefined ? '—' : `${bps(gap)} bps`}
          hint={enter ? `阈值 ${enter} bps · 净 ${st?.params?.enter_net} bps` : ''}
          tone={enter && gap >= enter ? 'text-amber-600' : ''} />
        <Stat label="最近信号" value={sig ? `${sig.legs?.[0]?.from} → ${sig.legs?.[0]?.to}` : '—'}
          hint={sig ? `${sig.at} · ${bps(sig.gap_bps)} bps` : (st?.can_open ? '窗口内' : '窗口外 / 已过截止')} />
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 text-sm font-medium">手动设置持仓</div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={code}
            onChange={(e) => { editedRef.current = true; setCode(e.target.value); }}
          >
            {!code ? <option value="">选择代码</option> : null}
            {(pool.length ? pool : [code].filter(Boolean)).map((c) => (
              <option key={c} value={c}>{c} {rows.find((r) => r.code === c)?.name || ''}</option>
            ))}
          </select>
          <Input
            className="h-9 w-36"
            inputMode="numeric"
            placeholder="股数"
            value={shares}
            onChange={(e) => { editedRef.current = true; setShares(e.target.value.replace(/[^0-9]/g, '')); }}
          />
          <Button size="sm" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
          {saveMsg ? <span className="text-xs text-muted-foreground">{saveMsg}</span> : null}
          {data?.manual?.set_at ? (
            <span className="ml-auto text-xs text-muted-foreground">上次设置 {String(data.manual.set_at).replace('T', ' ').slice(0, 19)} · {data.manual.set_by}</span>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left">代码</th>
              <th className="px-3 py-2 text-left">名称</th>
              <th className="px-3 py-2 text-right">现价</th>
              <th className="px-3 py-2 text-right">IOPV</th>
              <th className="px-3 py-2 text-right">溢价 %</th>
              <th className="px-3 py-2 text-right">基准 %</th>
              <th className="px-3 py-2 text-right">偏离 bps</th>
              <th className="px-3 py-2 text-right">买一 / 卖一</th>
              <th className="px-3 py-2 text-right" title="半价差 + 让档 + 佣金">{`单边成本（让${st?.params?.slip_ticks ?? 0}档+佣金万${st?.params?.comm_bps ?? 0.5}）`}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const held = r.code === holding;
              const muted = (st?.muted || []).includes(r.code);
              return (
                <tr key={r.code} className={`border-b border-border/60 last:border-0 ${held ? 'bg-primary/10 font-medium' : ''} ${muted ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-1.5">{r.code}{held ? ' ◀ 持仓' : ''}{muted ? ' · 停用' : ''}</td>
                  <td className="px-3 py-1.5">{r.name}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(r.price)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(r.iopv, 4)}</td>
                  <td className="px-3 py-1.5 text-right">{r.prem_bps === null || r.prem_bps === undefined ? '—' : fmt(r.prem_bps / 100, 2)}</td>
                  <td className="px-3 py-1.5 text-right">{r.base_bps === null || r.base_bps === undefined ? '—' : fmt(r.base_bps / 100, 2)}</td>
                  <td className={`px-3 py-1.5 text-right ${r.dev_bps < 0 ? 'text-emerald-600' : r.dev_bps > 0 ? 'text-red-600' : ''}`}>{bps(r.dev_bps)}</td>
                  <td className="px-3 py-1.5 text-right">{r.bid || r.ask ? `${fmt(r.bid)} / ${fmt(r.ask)}` : '—'}</td>
                  <td className="px-3 py-1.5 text-right">{r.cost_bps === null || r.cost_bps === undefined ? '—' : fmt(r.cost_bps, 1)}</td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">暂无数据（10:31 开盘窗口后出现，午休暂停）</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <details className="rounded-xl border border-border bg-card p-4" open>
        <summary className="cursor-pointer text-sm font-medium">运行日志</summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{(data?.log || []).join('\n')}</pre>
      </details>
    </div>
  );
}
