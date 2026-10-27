/**
 * 份额页 PCF 弹窗「历史」页签（SVIP）：近一年每日总份额、新增、生效申购上限、收盘价、净值、溢价率。
 * - 权限：useRbac().perms 含 api:etf-history（svip 及以上）或管理员才请求数据；服务端 nginx 再次校验。
 * - 无权限时只渲染本地合成的模糊占位（不含真实数据）+ 开通引导；未登录引导登录。
 * - 图只讲一件事：额度放宽 → 溢价回落，收紧 → 溢价走高。上半溢价率、下半额度阶梯，按段画箭头（limitEpisodes）。
 * - 每日明细默认折叠。设计稿：mockups/history2/history3_app.png（gen2.py）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Diamond, Download } from 'lucide-react';
import { useRbac } from '../../app/rbac/useRbac.js';
import { openAccountAuth, openUpgradeQr } from '../../app/accountAuthEvents.js';
import {
  HISTORY_RANGES,
  canViewEtfHistory,
  etfHistoryClient,
  fmtLimit,
  fmtLimitShort,
  fmtPct,
  fmtShares,
  historyToCsv,
  limitEpisodes,
  limitEvents,
  limitValue,
  sliceRange
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

const yearOf = (d) => d.slice(0, 4);
/** 日期显示：与最新数据同年只显示月-日，跨年显示完整日期。 */
const dayLabel = (d, refYear) => (yearOf(d) === refYear ? d.slice(5) : d);

const C_PREM = '#f97316';
const C_QUOTA = '#8b5cf6';
const C_TIGHT = '#ef4444';
const C_RELAX = '#22c55e';
const kindColor = (k) => (k === 'tightened' ? C_TIGHT : C_RELAX);
const episodeWord = (ep) => (ep.kind === 'relaxed' ? '放宽' : ep.count > 1 ? `收紧${ep.count}次` : '收紧');

/**
 * 「额度变了，溢价怎么走」图：上半溢价率，下半每日申购额度（对数阶梯），共用时间轴。
 * 每段额度变动加底色 + 箭头（起点 → 终点溢价）+ 标签「放宽 溢价-3.0点」。
 * 手写 SVG（固定 viewBox 宽度，按设备选 360/720），不依赖图表库，便于精确控制标注。
 */
export function QuotaPremiumChart({ rows, episodes, mobile }) {
  const [hover, setHover] = useState(null);
  const W = mobile ? 360 : 720;
  const H = mobile ? 258 : 300;
  const L = 8, R = 38, T = 62; // 顶部两条标签道
  const PB = mobile ? 176 : 206; // 溢价区底
  const QT = PB + 26, QB = H - 30; // 额度区
  const n = rows.length;
  const x = (i) => L + ((W - L - R) * i) / Math.max(1, n - 1);
  const dx = n > 1 ? x(1) - x(0) : 0;
  const prem = rows.map((r) => r.prem);
  const vals = prem.filter((v) => v !== null);
  const lo = vals.length ? Math.floor(Math.min(...vals) / 2) * 2 - 1 : -1;
  const hi = vals.length ? Math.ceil(Math.max(...vals) / 2) * 2 + 1 : 5;
  const y = (v) => T + ((PB - T) * (hi - v)) / Math.max(1e-9, hi - lo);
  const lims = rows.map(limitValue);
  const finite = lims.filter((v) => v !== null && Number.isFinite(v) && v > 0);
  const qMaxFinite = finite.length ? Math.max(...finite) : 1;
  const qv = (v) => (v === Infinity ? qMaxFinite * 4 : v);
  const logs = lims.filter((v) => v !== null && v > 0).map((v) => Math.log10(qv(v)));
  const qlo = logs.length ? Math.min(...logs) - 0.35 : 0;
  const qhi = logs.length ? Math.max(...logs) : 1;
  const qy = (v) => QB - ((QB - QT) * (Math.log10(qv(v)) - qlo)) / Math.max(1e-9, qhi - qlo);
  const refYear = rows.length ? yearOf(rows[n - 1].d) : '';

  // 溢价折线：缺失处断开
  const premPaths = [];
  let seg = '';
  prem.forEach((p, i) => {
    if (p === null) {
      if (seg) premPaths.push(seg);
      seg = '';
      return;
    }
    seg += `${seg ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)} `;
  });
  if (seg) premPaths.push(seg);

  // 额度阶梯面积：未知处断开
  const quotaPaths = [];
  let qd = '';
  let qStart = null;
  const closeQ = (i) => {
    if (qd) quotaPaths.push(`${qd}L${Math.min(W - R, x(i) + dx / 2).toFixed(1)},${QB} L${qStart.toFixed(1)},${QB} Z`);
    qd = '';
  };
  lims.forEach((v, i) => {
    if (v === null || !(v > 0)) {
      closeQ(i - 1);
      return;
    }
    const xa = Math.max(L, x(i) - dx / 2), xb = Math.min(W - R, x(i) + dx / 2), q = qy(v).toFixed(1);
    if (!qd) {
      qStart = xa;
      qd = `M${xa.toFixed(1)},${QB} `;
    }
    qd += `L${xa.toFixed(1)},${q} L${xb.toFixed(1)},${q} `;
  });
  closeQ(n - 1);

  // 额度变化处的数字标签（太挤就略过）
  const qLabels = [];
  let lastLx = -99;
  lims.forEach((v, i) => {
    if (v === null || (i > 0 && v === lims[i - 1])) return;
    if (x(i) - lastLx < (mobile ? 30 : 40)) return;
    qLabels.push({ i, v });
    lastLx = x(i);
  });

  // 段标签放在图顶两条标签道里（不压折线），按影响大小优先放，放不下的只画箭头（下方卡片有完整数据）
  const pills = [];
  const pillW = mobile ? 100 : 112, pillH = 18;
  const lanes = [14, 38];
  [...episodes]
    .sort((a, b) => Math.abs(b.premChange) - Math.abs(a.premChange))
    .forEach((ep) => {
      const ax = x(ep.premToIndex);
      const cx = Math.min(Math.max(ax, L + pillW / 2), W - R - pillW / 2);
      for (const cy of lanes) {
        const box = { x0: cx - pillW / 2 - 4, x1: cx + pillW / 2 + 4, cy };
        if (!pills.some((p) => p.box.cy === cy && box.x0 < p.box.x1 && box.x1 > p.box.x0)) {
          pills.push({ ep, cx, cy, ax, ay: y(ep.premTo), box });
          break;
        }
      }
    });

  const step = Math.max(2, Math.ceil((hi - lo) / 4 / 2) * 2);
  const gridVals = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) gridVals.push(v);
  const xTickIdx = mobile ? [0, Math.floor((n - 1) / 2), n - 1] : [0, Math.floor((n - 1) / 3), Math.floor((2 * (n - 1)) / 3), n - 1];

  const onMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - L) / (W - L - R)) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const hr = hover !== null ? rows[hover] : null;
  const hEp = hr ? episodes.find((ep) => hover >= ep.startIndex && hover <= ep.lastIndex) : null;

  return (
    <div className="eh-chart" role="img" aria-label="申购额度变化与溢价率走势">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }}>
        <defs>
          {['tightened', 'relaxed'].map((k) => (
            <marker key={k} id={`eh-arrow-${k}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill={kindColor(k)} />
            </marker>
          ))}
        </defs>
        {episodes.map((ep) => {
          const x0 = Math.max(L, x(ep.startIndex) - dx / 2), x1 = Math.min(W - R, x(Math.max(ep.lastIndex, ep.premToIndex)) + dx / 2);
          return <rect key={`bg-${ep.startDate}`} x={x0} y={T - 8} width={Math.max(2, x1 - x0)} height={QB - T + 8} fill={kindColor(ep.kind)} opacity={0.1} />;
        })}
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="eh-grid" />
            <text x={W - R + 4} y={y(v) + 3} className="eh-ax">
              {v}%
            </text>
          </g>
        ))}
        {premPaths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={C_PREM} strokeWidth={2} strokeLinejoin="round" />
        ))}
        <line x1={L} x2={W - R} y1={QB} y2={QB} className="eh-grid" />
        <text x={L} y={QT - 8} className="eh-lab">
          每日申购额度
        </text>
        {quotaPaths.map((d, i) => (
          <path key={i} d={d} fill={C_QUOTA} fillOpacity={0.3} stroke={C_QUOTA} strokeWidth={1.2} />
        ))}
        {qLabels.map(({ i, v }) => (
          <text key={i} x={Math.min(x(i) + 2, W - R - 26)} y={qy(v) - 3} className="eh-ql">
            {fmtLimitShort(v)}
          </text>
        ))}
        {episodes.map((ep) => {
          const c = kindColor(ep.kind);
          const x0 = x(ep.premFromIndex), y0 = y(ep.premFrom), x1 = x(ep.premToIndex), y1 = y(ep.premTo);
          return (
            <g key={`ar-${ep.startDate}`}>
              <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={c} strokeWidth={1.5} strokeDasharray="3 2" markerEnd={`url(#eh-arrow-${ep.kind})`} />
              <circle cx={x0} cy={y0} r={3} fill="#fff" stroke={c} strokeWidth={1.5} />
              <circle cx={x1} cy={y1} r={3.5} fill={c} />
            </g>
          );
        })}
        {pills.map(({ ep, cx, cy, ax, ay }) => {
          const c = kindColor(ep.kind);
          return (
            <g key={`pl-${ep.startDate}`}>
              <line x1={ax} y1={cy + pillH / 2} x2={ax} y2={ay - 5} stroke={c} strokeOpacity={0.45} strokeWidth={1} strokeDasharray="1 2" />
              <rect x={cx - pillW / 2} y={cy - pillH / 2} width={pillW} height={pillH} rx={pillH / 2} fill={c} fillOpacity={0.16} stroke={c} strokeOpacity={0.6} />
              <text x={cx} y={cy + 3.5} textAnchor="middle" className="eh-pill" fill={c}>
                {episodeWord(ep)} 溢价{ep.premChange > 0 ? '+' : ''}
                {ep.premChange.toFixed(1)}点
              </text>
            </g>
          );
        })}
        {xTickIdx.map((i, k) => (
          <text key={i} x={x(i)} y={H - 12} className="eh-ax" textAnchor={k === 0 ? 'start' : k === xTickIdx.length - 1 ? 'end' : 'middle'}>
            {rows[i] ? dayLabel(rows[i].d, refYear) : ''}
          </text>
        ))}
        {hr ? <line x1={x(hover)} x2={x(hover)} y1={T - 6} y2={QB} stroke="currentColor" strokeOpacity={0.35} strokeWidth={0.8} /> : null}
      </svg>
      {hr ? (
        <div className="eh-tip" style={{ left: `${Math.min(Math.max((x(hover) / W) * 100, 18), 82)}%` }}>
          <b>{hr.d}</b>
          <div>
            溢价 <b className="eh-tip-prem">{fmtPct(hr.prem)}</b>
            {GAP}额度 {fmtLimit(limitValue(hr))}
          </div>
          {hEp ? <div className={hEp.kind === 'tightened' ? 'eh-tip-down' : 'eh-tip-up'}>{episodeWord(hEp)}中</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function EpisodeList({ episodes, refYear }) {
  if (!episodes.length) return <p className="eh-empty">所选区间内额度没有变动，可切换到更长的时间范围。</p>;
  return (
    <div className="eh-eps">
      {[...episodes].reverse().map((ep) => {
        const when = ep.startDate === ep.lastDate ? dayLabel(ep.startDate, refYear) : `${dayLabel(ep.startDate, refYear)} – ${dayLabel(ep.lastDate, refYear)}`;
        const word = ep.kind === 'relaxed' ? '放宽' : ep.count > 1 ? `连续收紧 ${ep.count} 次` : '收紧';
        return (
          <div key={ep.startDate} className="eh-ep">
            <span className={`eh-chip eh-chip-${ep.kind}`}>{word}</span>
            <span className="eh-ep-when">{when}</span>
            <span className="eh-ep-q">
              {fmtLimitShort(ep.from)} → {fmtLimitShort(ep.to)}
            </span>
            <span className="eh-ep-p">
              {fmtPct(ep.premFrom, { digits: 1 })} → <b className={ep.premChange > 0 ? 'eh-prem-up' : 'eh-prem-down'}>{fmtPct(ep.premTo, { digits: 1 })}</b>
            </span>
          </div>
        );
      })}
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
                  <td>{mobile && yearOf(r.d) === yearOf(rows[rows.length - 1]?.d || '') ? shortDate(r.d) : r.d}</td>
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
  const [range, setRange] = useState('3m');
  const [showDaily, setShowDaily] = useState(false);
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
  const episodes = useMemo(() => limitEpisodes(rows), [rows]);
  const refYear = rows.length ? yearOf(rows[rows.length - 1].d) : '';

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
        <div className="eh-title">
          <b>额度变了，溢价怎么走</b>
          <span>放得越开溢价越低，收得越紧溢价越高</span>
        </div>
        <div className="eh-seg" role="tablist" aria-label="时间范围">
          {HISTORY_RANGES.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <QuotaPremiumChart rows={rows} episodes={episodes} mobile={mobile} />
      <EpisodeList episodes={episodes} refYear={refYear} />
      <p className="eh-foot">放宽：变动前一日 → 之后 5 个交易日最低溢价；收紧：起点 → 最后一次收紧后 5 个交易日最高溢价。</p>
      <button type="button" className="eh-daily-toggle" aria-expanded={showDaily} onClick={() => setShowDaily((v) => !v)}>
        <span>每日明细（份额 / 新增 / 收盘 / 净值）</span>
        <span>{showDaily ? '收起 ▴' : '展开 ▾'}</span>
      </button>
      {showDaily ? (
        <>
          <div className="eh-tablehead">
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
        </>
      ) : null}
      <p className="eh-foot">
        溢价率 = 收盘价 ÷ 同日单位净值 − 1；申购额度为当日 PCF 生效值（净申购优先）。数据截至 {all[all.length - 1]?.d}。
      </p>
    </div>
  );
}
