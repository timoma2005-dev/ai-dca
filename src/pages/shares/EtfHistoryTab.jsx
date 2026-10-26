/**
 * 份额页 PCF 弹窗「历史」页签（SVIP）：近一年每日总份额、新增、生效申购上限、收盘价、净值、溢价率。
 * - 权限：useRbac().perms 含 api:etf-history（svip 及以上）或管理员才请求数据；服务端 nginx 再次校验。
 * - 无权限时只渲染本地合成的模糊占位（不含真实数据）+ 开通引导；未登录引导登录。
 * - 图：总份额（左轴）、溢价率（右轴）、日新增柱（独立隐藏轴）；生效申购上限变化日画竖线并标注「收/放」。
 * 设计稿：mockups/history/history_app.png、history_pc.png。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { Diamond, Download } from 'lucide-react';
import { useRbac } from '../../app/rbac/useRbac.js';
import { openAccountAuth, openUpgradeQr } from '../../app/accountAuthEvents.js';
import {
  HISTORY_RANGES,
  canViewEtfHistory,
  etfHistoryClient,
  fmtLimit,
  fmtPct,
  fmtShares,
  historyToCsv,
  limitEvents,
  limitValue,
  sliceRange,
  summarizeHistory
} from '../../app/etfHistoryClient.js';

const PAGE = 20;

function useIsMobile() {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 640px)');
    if (!mq) return undefined;
    const on = () => setM(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return Boolean(m);
}

const shortDate = (d) => d.slice(5);
const GAP = '\u3000';

function TipBox({ active, payload, events }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  const ev = events.find((e) => e.d === r.d);
  return (
    <div className="eh-tip">
      <b>{r.d}</b>
      <div>
        总份额 {fmtShares(r.sh)}{GAP}新增 {fmtShares(r.dsh, { sign: true })}
      </div>
      <div>
        申购上限{' '}
        {ev ? (
          <>
            {fmtLimit(ev.from)} → <b className={ev.kind === 'tightened' ? 'eh-tip-down' : 'eh-tip-up'}>{fmtLimit(ev.to)}</b>
          </>
        ) : (
          fmtLimit(limitValue(r))
        )}
        {r.allow === false ? '（暂停申购）' : ''}
      </div>
      <div>
        收盘 {r.close ?? '—'}{GAP}净值 {r.nav ?? '—'}
      </div>
      <div>
        溢价 <b className="eh-tip-prem">{fmtPct(r.prem)}</b>
        {r.dprem !== null ? `（${r.dprem > 0 ? '+' : ''}${r.dprem.toFixed(2)}）` : ''}
      </div>
    </div>
  );
}

function EventLabel({ viewBox, kind, text }) {
  if (!viewBox) return null;
  const { x, y } = viewBox;
  const c = kind === 'tightened' ? '#dc2626' : '#16a34a';
  return (
    <g>
      <circle cx={x} cy={y + 9} r={8} fill={c} />
      <text x={x} y={y + 12.5} fontSize={10} fill="#fff" textAnchor="middle" fontWeight={700}>
        {kind === 'tightened' ? '收' : '放'}
      </text>
      {text ? (
        <text x={x + 11} y={y + 12.5} fontSize={10.5} fill={c} fontWeight={700}>
          {text}
        </text>
      ) : null}
    </g>
  );
}

function HistoryChart({ rows, events, mobile }) {
  const prem = rows.map((r) => r.prem).filter((v) => v !== null);
  const pMin = prem.length ? Math.floor(Math.min(...prem, 0)) : -1;
  const pMax = prem.length ? Math.ceil(Math.max(...prem)) : 5;
  const dshMax = Math.max(1, ...rows.map((r) => Math.abs(r.dsh || 0)));
  const ticks = Math.min(mobile ? 4 : 7, rows.length);
  const step = Math.max(1, Math.floor((rows.length - 1) / Math.max(1, ticks - 1)));
  const xTicks = rows.filter((_, i) => i % step === 0).map((r) => r.d);
  return (
    <div className="eh-chart" role="img" aria-label="总份额、溢价率与每日新增走势">
      <ResponsiveContainer width="100%" height={mobile ? 220 : 300}>
        <ComposedChart data={rows} margin={{ top: 22, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#eef2f7" vertical={false} />
          <XAxis dataKey="d" ticks={xTicks} tickFormatter={shortDate} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
          <YAxis
            yAxisId="sh"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) => fmtShares(v)}
            tick={{ fontSize: 10, fill: '#4f46e5' }}
            width={mobile ? 50 : 62}
            tickLine={false}
            axisLine={false}
            tickCount={4}
          />
          <YAxis
            yAxisId="prem"
            orientation="right"
            domain={[pMin, pMax]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fontSize: 10, fill: '#f97316' }}
            width={34}
            tickLine={false}
            axisLine={false}
          />
          <YAxis yAxisId="dsh" hide domain={[-dshMax, dshMax * 3.2]} />
          <Tooltip content={<TipBox events={events} />} cursor={{ stroke: '#0f172a', strokeWidth: 0.7 }} />
          <Bar yAxisId="dsh" dataKey="dsh" isAnimationActive={false} shape={<DshBar />} />
          {events.map((e) => (
            <ReferenceLine
              key={e.d}
              yAxisId="sh"
              x={e.d}
              stroke={e.kind === 'tightened' ? '#dc2626' : '#16a34a'}
              strokeDasharray="3 3"
              label={<EventLabel kind={e.kind} text={mobile ? '' : `${fmtLimit(e.from)}→${fmtLimit(e.to)}`} />}
              ifOverflow="extendDomain"
            />
          ))}
          <Line yAxisId="sh" type="monotone" dataKey="sh" stroke="#4f46e5" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line yAxisId="prem" type="monotone" dataKey="prem" stroke="#f97316" strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function DshBar({ x, y, width, height, payload }) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !height) return null;
  const neg = (payload?.dsh || 0) < 0;
  return <rect x={x} y={height < 0 ? y + height : y} width={Math.max(1, width)} height={Math.abs(height)} fill={neg ? '#fca5a5' : '#93c5fd'} />;
}

function Legend() {
  return (
    <div className="eh-legend" aria-hidden="true">
      <i style={{ background: '#4f46e5' }} />
      份额
      <i style={{ background: '#f97316' }} />
      溢价
      <i style={{ background: '#93c5fd' }} />
      日新增
      <i style={{ background: '#fca5a5' }} />
      日减少
    </div>
  );
}

function HistoryTable({ rows, eventsByDate, mobile, onlyEvents }) {
  const [shown, setShown] = useState(PAGE);
  const [page, setPage] = useState(0);
  const desc = useMemo(() => {
    const list = [...rows].reverse();
    return onlyEvents ? list.filter((r) => eventsByDate.has(r.d)) : list;
  }, [rows, onlyEvents, eventsByDate]);
  useEffect(() => {
    setShown(PAGE);
    setPage(0);
  }, [rows, onlyEvents]);
  const pages = Math.max(1, Math.ceil(desc.length / PAGE));
  const view = mobile ? desc.slice(0, shown) : desc.slice(page * PAGE, page * PAGE + PAGE);
  if (!desc.length) return <p className="eh-empty">所选区间内没有申购上限变动。</p>;
  return (
    <>
      <div className="eh-table-wrap">
        <table className="eh-table">
          <thead>
            <tr>
              <th>日期</th>
              <th className="num">总份额</th>
              <th className="num">新增</th>
              <th className="num">申购上限</th>
              {mobile ? null : (
                <>
                  <th>额度变动</th>
                  <th>申购</th>
                  <th className="num">收盘价</th>
                  <th className="num">净值</th>
                </>
              )}
              <th className="num">溢价</th>
              <th className="num">Δ溢价</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => {
              const ev = eventsByDate.get(r.d);
              return (
                <tr key={r.d} className={ev ? `eh-row-${ev.kind}` : undefined}>
                  <td>{mobile ? shortDate(r.d) : r.d}</td>
                  <td className="num">{fmtShares(r.sh)}</td>
                  <td className={`num ${r.dsh > 0 ? 'eh-up' : r.dsh < 0 ? 'eh-down' : ''}`}>{fmtShares(r.dsh, { sign: true })}</td>
                  <td className="num">
                    {fmtLimit(limitValue(r))}
                    {mobile && ev ? <span className={`eh-chip eh-chip-${ev.kind}`}>{ev.kind === 'tightened' ? '收紧' : '放宽'}</span> : null}
                  </td>
                  {mobile ? null : (
                    <>
                      <td>
                        {ev ? (
                          <span className={`eh-chip eh-chip-${ev.kind}`}>
                            {ev.kind === 'tightened' ? '收紧' : '放宽'} {fmtLimit(ev.from)}→{fmtLimit(ev.to)}
                          </span>
                        ) : (
                          <span className="eh-muted">—</span>
                        )}
                      </td>
                      <td>
                        {r.allow === null ? <span className="eh-muted">—</span> : <span className={`eh-chip ${r.allow ? 'eh-chip-gray' : 'eh-chip-tightened'}`}>{r.allow ? '允许' : '暂停'}</span>}
                      </td>
                      <td className="num">{r.close ?? '—'}</td>
                      <td className="num">{r.nav ?? '—'}</td>
                    </>
                  )}
                  <td className="num eh-b">{fmtPct(r.prem)}</td>
                  <td className={`num ${r.dprem > 0 ? 'eh-prem-up' : r.dprem < 0 ? 'eh-prem-down' : ''}`}>
                    {r.dprem === null ? '—' : `${r.dprem > 0 ? '+' : ''}${r.dprem.toFixed(2)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {mobile ? (
        shown < desc.length ? (
          <button type="button" className="eh-more" onClick={() => setShown((n) => n + PAGE)}>
            加载更早 ▾
          </button>
        ) : null
      ) : pages > 1 ? (
        <div className="eh-pager" role="navigation" aria-label="分页">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="上一页">
            ‹
          </button>
          <span>
            {page + 1} / {pages}
          </span>
          <button type="button" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} aria-label="下一页">
            ›
          </button>
        </div>
      ) : null}
    </>
  );
}

function downloadCsv(rows, meta) {
  const blob = new Blob([historyToCsv(rows, meta)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${meta.code}-历史份额与溢价.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 无权限占位：本地合成曲线，不含任何真实数据。
const FAKE = Array.from({ length: 60 }, (_, i) => ({
  a: 70 - i * 0.6 - Math.sin(i / 5) * 6,
  b: 110 - Math.sin(i / 7) * 18 - (i > 40 ? (i - 40) * 1.5 : 0),
  c: 8 + ((i * 37) % 23)
}));
function LockedPreview({ mobile }) {
  const w = 600;
  return (
    <div className="eh-blur" aria-hidden="true">
      <svg viewBox={`0 0 ${w} 160`} width="100%" height={mobile ? 150 : 220} preserveAspectRatio="none">
        {FAKE.map((p, i) => (
          <rect key={i} x={i * 10} y={160 - p.c} width={6} height={p.c} fill={i % 4 ? '#93c5fd' : '#fca5a5'} />
        ))}
        <polyline fill="none" stroke="#4f46e5" strokeWidth="3" points={FAKE.map((p, i) => `${i * 10},${p.a}`).join(' ')} />
        <polyline fill="none" stroke="#f97316" strokeWidth="3" points={FAKE.map((p, i) => `${i * 10},${p.b}`).join(' ')} />
      </svg>
      <div className="eh-fake-rows">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i}>
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        ))}
      </div>
    </div>
  );
}

function LockedCard({ loggedIn, onClose, mobile }) {
  return (
    <div className="eh-locked">
      <LockedPreview mobile={mobile} />
      <div className="eh-lockcard" role="group" aria-label="SVIP 专享">
        <div className="eh-lockicon">
          <Diamond size={20} aria-hidden="true" />
        </div>
        <div className="eh-locktitle">历史份额与溢价 · SVIP 专享</div>
        <p>近一年每日份额、新增、申购额度变化与溢价走势，看清每次限购前后溢价怎么变。</p>
        {loggedIn ? (
          <button
            type="button"
            className="eh-btn"
            onClick={() => {
              onClose?.();
              openUpgradeQr({ source: 'etf-history' });
            }}
          >
            开通 SVIP
          </button>
        ) : (
          <button
            type="button"
            className="eh-btn"
            onClick={() => {
              onClose?.();
              openAccountAuth({ mode: 'login', source: 'etf-history', trigger: 'shares' });
            }}
          >
            登录后查看
          </button>
        )}
        <div className="eh-locknote">{loggedIn ? '已是 SVIP？重新登录后刷新' : 'SVIP 会员可查看'}</div>
      </div>
    </div>
  );
}

export default function EtfHistoryTab({ code, onClose }) {
  const rbac = useRbac();
  const allowed = canViewEtfHistory(rbac);
  const mobile = useIsMobile();
  const [result, setResult] = useState({ state: allowed ? 'loading' : 'locked' });
  const [range, setRange] = useState('6m');
  const [onlyEvents, setOnlyEvents] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!allowed) {
      setResult({ state: rbac.loggedIn ? 'locked' : 'login' });
      return undefined;
    }
    let alive = true;
    setResult({ state: 'loading' });
    etfHistoryClient.load(code, { refresh: retry > 0 }).then((v) => alive && setResult(v));
    return () => {
      alive = false;
    };
  }, [allowed, code, retry, rbac.loggedIn]);

  const all = result.state === 'ready' ? result.data.rows : [];
  const rows = useMemo(() => sliceRange(all, range), [all, range]);
  const events = useMemo(() => limitEvents(rows), [rows]);
  const eventsByDate = useMemo(() => new Map(events.map((e) => [e.d, e])), [events]);
  const sum = useMemo(() => summarizeHistory(rows), [rows]);

  if (result.state === 'locked' || result.state === 'login')
    return <LockedCard loggedIn={result.state === 'locked'} onClose={onClose} mobile={mobile} />;
  if (result.state === 'loading') return <div className="eh-state">正在读取历史数据…</div>;
  if (result.state === 'empty') return <div className="eh-state">暂无该基金的历史数据。</div>;
  if (result.state !== 'ready')
    return (
      <div className="eh-state">
        历史数据读取失败。
        <button type="button" className="eh-link" onClick={() => setRetry((n) => n + 1)}>
          重试
        </button>
      </div>
    );

  return (
    <div className="eh">
      <div className="eh-toolbar">
        <div className="eh-seg" role="tablist" aria-label="时间范围">
          {HISTORY_RANGES.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>
              {label}
            </button>
          ))}
        </div>
        {mobile ? null : <Kpis sum={sum} inline />}
        <Legend />
      </div>
      {mobile ? <Kpis sum={sum} /> : null}
      <HistoryChart rows={rows} events={events} mobile={mobile} />
      <div className="eh-tablehead">
        <b>每日明细</b>
        <div className="eh-actions">
          <button type="button" className={`eh-chipbtn ${onlyEvents ? 'on' : ''}`} aria-pressed={onlyEvents} onClick={() => setOnlyEvents((v) => !v)}>
            只看额度变动日
          </button>
          {mobile ? null : (
            <button type="button" className="eh-dl" onClick={() => downloadCsv(rows, { code, name: result.data.name })}>
              <Download size={13} aria-hidden="true" /> 导出 CSV
            </button>
          )}
        </div>
      </div>
      <HistoryTable rows={rows} eventsByDate={eventsByDate} mobile={mobile} onlyEvents={onlyEvents} />
      <p className="eh-foot">
        溢价率 = 收盘价 ÷ 同日单位净值 − 1；申购上限为当日 PCF 生效值（净申购优先）。数据截至 {all[all.length - 1]?.d}。
      </p>
    </div>
  );
}

function Kpis({ sum, inline = false }) {
  return (
    <div className={inline ? 'eh-kpis-inline' : 'eh-kpis'}>
      <div>
        <span>区间份额</span>
        <b className={sum.sharesChange > 0 ? 'eh-up' : sum.sharesChange < 0 ? 'eh-down' : ''}>{fmtShares(sum.sharesChange, { sign: true })}</b>
      </div>
      <div>
        <span>当前溢价</span>
        <b>{fmtPct(sum.premium)}</b>
      </div>
      <div>
        <span>额度变动</span>
        <b>
          收紧 {sum.tightened} · 放宽 {sum.relaxed}
        </b>
      </div>
    </div>
  );
}
