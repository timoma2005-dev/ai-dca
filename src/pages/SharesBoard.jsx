/**
 * 份额页看板视图（tab=shares）。
 * - PC：顶部统计小块 + 搜索 + 卡片/表格切换 + 刷新（参考 tab=fundSwitch），卡片 auto-fill 270px；
 *   表格模式只替换卡片区，顶部、日期行、筛选不变；视图选择存 localStorage `etf-shares:view-mode`。
 * - 手机（≤640px）：Home 面板式紧凑列表，标题「N只基金收紧，对比 P → T。」+ 三行条目。
 * - 点「PCF 清单」/ 手机条目弹出居中弹窗（X、背景、Esc 关闭），内容复用 PcfDetailDrawer。
 * 数据：快照 sharesClient（worker 预计算 limitChanges / prevLimitDate / 沪市份额 / 行情名称）；
 * 老快照没有 limitChanges 时，按 code + 日期用 pcfDetailClient 读两天 PCF 自行对比（模块级缓存，失败重试一次）。
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Search, RefreshCw, Inbox, CircleAlert, X } from 'lucide-react';
import { previousSession } from '../../shared/etfPcfSharesSchema.js';
import { sharesClient, shanghaiAccessDay } from '../app/etfPcfSharesClient.js';
import { pcfDetailClient } from '../app/etfPcfDetailClient.js';
import './shares-board.css';

const isSz = (r) => r.code.startsWith('159');

const fetchedTime = (s) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(s));

const FIELDS = [
  ['total', '累计申购'],
  ['net', '净申购'],
  ['accountTotal', '单账户累计'],
  ['accountNet', '单账户净申购']
];
const SHORT = { total: '累计', net: '净申购', accountTotal: '单户累计', accountNet: '单户净' };
const MARK = { tightened: '▼收紧', relaxed: '▲放宽', unchanged: '—未变', mixed: '◆有升有降', incomparable: '—' };
const CLS = { tightened: 'tight', relaxed: 'relax', mixed: 'mixed' };
const ORDER = { tightened: 0, mixed: 1, relaxed: 2, unchanged: 3, incomparable: 4 };
const VIEW_KEY = 'etf-shares:view-mode';

function fmtShares(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const s = (v) => (Math.round(v * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  if (a >= 1e8) return `${s(n / 1e8)}亿份`;
  if (a >= 1e4) return `${s(n / 1e4)}万份`;
  return `${Math.round(n)}份`;
}
function fmtLimit(x) {
  if (!x || x.kind === 'unknown') return '—';
  if (x.kind === 'unlimited') return '不限';
  return fmtShares(x.shares);
}
const fmtRatio = (r) => (r >= 10 ? Math.round(r) : Math.round(r * 100) / 100);
const isMoved = (c) => c === 'tightened' || c === 'relaxed';
const md = (x) => (x ? String(x).slice(5) : '—');
const overallLabel = (ov) => (ov === 'incomparable' ? '待对比' : MARK[ov]);
const rowClass = (ov, prefix = 'is-') => (ov === 'tightened' ? `${prefix}tight` : ov === 'relaxed' ? `${prefix}relax` : '');

function deltaView(d, zeroText) {
  if (!Number.isFinite(d)) return { cls: 'muted', text: '暂无' };
  if (d > 0) return { cls: 'pos', text: `+${fmtShares(d)}` };
  if (d < 0) return { cls: 'neg', text: fmtShares(d) };
  return { cls: 'zero', text: zeroText };
}

function lim(kind, shares) {
  const k = ['limited', 'unlimited', 'unknown'].includes(kind) ? kind : 'unknown';
  return { kind: k, shares: k === 'limited' && Number.isSafeInteger(shares) && shares >= 0 ? shares : null };
}
function classify(before, after) {
  const out = (change, ratio = null) => ({ before, after, change, ratio });
  if (!before || !after || before.kind === 'unknown' || after.kind === 'unknown') return out('incomparable');
  if (before.kind === 'unlimited' && after.kind === 'unlimited') return out('unchanged');
  if (before.kind === 'unlimited') return out('tightened');
  if (after.kind === 'unlimited') return out('relaxed');
  if (before.shares === after.shares) return out('unchanged', 1);
  return out(
    after.shares < before.shares ? 'tightened' : 'relaxed',
    before.shares > 0 ? after.shares / before.shares : null
  );
}
function overallOf(changes) {
  if (!changes) return 'incomparable';
  const ks = Object.values(changes).map((c) => c.change);
  const t = ks.includes('tightened'),
    r = ks.includes('relaxed');
  if (t && r) return 'mixed';
  if (t) return 'tightened';
  if (r) return 'relaxed';
  if (ks.every((k) => k === 'incomparable')) return 'incomparable';
  return 'unchanged';
}
const fromPcf = (p) => ({
  total: lim(p.totalSubscribeLimitKind, p.totalSubscribeLimitShares),
  net: lim(p.netSubscribeLimitKind, p.netSubscribeLimitShares),
  accountTotal: lim(p.accountTotalSubscribeLimitKind, p.accountTotalSubscribeLimitShares),
  accountNet: lim(p.accountNetSubscribeLimitKind, p.accountNetSubscribeLimitShares)
});
const fromRow = (r) => ({
  total: lim(r.totalLimitKind, r.totalLimitShares),
  net: lim(r.netLimitKind, r.netLimitShares),
  accountTotal: lim(r.accountTotalLimitKind, r.accountTotalLimitShares),
  accountNet: lim(r.accountNetLimitKind, r.accountNetLimitShares)
});

// 单只基金的限额环比：优先用快照里的 limitChanges；没有时读两天 PCF 对比。
const CHANGE_CACHE = new Map();
function useLimitChanges(row, calendar) {
  const has = row.limitChanges && typeof row.limitChanges === 'object';
  const prevDay = has ? row.prevLimitDate : row.limitDate ? previousSession(row.limitDate, calendar) : null;
  const ck = `${row.code}:${row.limitDate}:${prevDay}`;
  const [state, setState] = useState(() => CHANGE_CACHE.get(ck) || null);
  useEffect(() => {
    if (has || !row.limitDate || !prevDay) {
      setState(null);
      return undefined;
    }
    if (CHANGE_CACHE.has(ck)) {
      setState(CHANGE_CACHE.get(ck));
      return undefined;
    }
    let alive = true;
    let subs = [];
    const fetchPair = () => {
      subs.forEach((x) => x.release());
      subs = [pcfDetailClient.subscribe(row.code, row.limitDate), pcfDetailClient.subscribe(row.code, prevDay)];
      return Promise.all(subs.map((x) => x.promise));
    };
    fetchPair()
      .then(([ra, rb]) =>
        ra.data && rb.data
          ? [ra, rb]
          : new Promise((r) => setTimeout(r, 600 + Math.random() * 900)).then(() =>
              alive ? fetchPair() : [ra, rb]
            )
      )
      .then(([ra, rb]) => {
        if (!alive) return;
        const after = ra.data ? fromPcf(ra.data) : fromRow(row);
        if (!rb.data) {
          setState({ after, changes: null });
          return;
        }
        const before = fromPcf(rb.data);
        const changes = {};
        for (const [k] of FIELDS) changes[k] = classify(before[k], after[k]);
        const st = { after, changes };
        CHANGE_CACHE.set(ck, st);
        setState(st);
      });
    return () => {
      alive = false;
      subs.forEach((x) => x.release());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [has, ck]);
  if (has) {
    const after = {};
    const base = fromRow(row);
    for (const [k] of FIELDS) after[k] = row.limitChanges[k]?.after || base[k];
    return { after, changes: row.limitChanges, prevDay, overall: row.limitChange || overallOf(row.limitChanges) };
  }
  if (state) return { after: state.after, changes: state.changes, prevDay, overall: overallOf(state.changes) };
  return { after: fromRow(row), changes: null, prevDay, overall: 'incomparable' };
}

function useReportOverall(row, onOverall, calendar) {
  const info = useLimitChanges(row, calendar);
  useEffect(() => {
    onOverall(row.code, info.overall);
  }, [row.code, info.overall, onOverall]);
  return info;
}

function useIsMobile() {
  const q = '(max-width: 640px)';
  const get = () => {
    try {
      return !!globalThis.matchMedia && globalThis.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  const [m, setM] = useState(get);
  useEffect(() => {
    if (!globalThis.matchMedia) return undefined;
    const mq = globalThis.matchMedia(q);
    const f = () => setM(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', f);
    else mq.addListener(f);
    f();
    return () => (mq.removeEventListener ? mq.removeEventListener('change', f) : mq.removeListener(f));
  }, []);
  return m;
}

function CodePills({ row }) {
  const sz = isSz(row);
  return (
    <div className="nx-title-line">
      <span className={`nx-pill code${sz ? '' : ' sse'}`}>{`${sz ? '深' : '沪'} ${row.code}`}</span>
      {row.subscriptionAllowed === false && <span className="nx-pill paused">仅赎回</span>}
    </div>
  );
}

function LimitCell({ label, after, change }) {
  const c = change?.change;
  const moved = isMoved(c);
  const ratio = moved && Number.isFinite(change.ratio) ? ` ×${fmtRatio(change.ratio)}` : '';
  return (
    <div
      className={`nx-limit ${CLS[c] || ''}`}
      title={moved ? `${fmtLimit(change.before)} → ${fmtLimit(change.after)}${ratio}` : undefined}
    >
      <div className="nx-limit-row">
        <span className="nx-limit-label">{label}</span>
        {c && c !== 'incomparable' && (
          <span className="nx-limit-mark">{moved ? `${c === 'tightened' ? '▼' : '▲'}${ratio}` : '—'}</span>
        )}
      </div>
      <span className="nx-limit-val">
        {fmtLimit(after)}
        {moved && <span className="nx-limit-was">{` ←${fmtLimit(change.before)}`}</span>}
      </span>
    </div>
  );
}

function BoardCard({ row, calendar, onOpen, onOverall }) {
  const info = useReportOverall(row, onOverall, calendar);
  const ov = info.overall;
  const delta = deltaView(row.deltaShares, '无变化');
  return (
    <article className={`nx-card ${rowClass(ov)}`}>
      <div className="nx-card-head">
        <div className="nx-head-row">
          <span className="nx-name" title={row.name}>
            {row.name}
          </span>
          <span className={`nx-pill ${CLS[ov] || ''}`}>{overallLabel(ov)}</span>
        </div>
        <CodePills row={row} />
      </div>
      <div className="nx-body">
        <div className="nx-limits">
          {FIELDS.map(([k, label]) => (
            <LimitCell key={k} label={label} after={info.after[k]} change={info.changes ? info.changes[k] : null} />
          ))}
        </div>
        <div className="nx-shares">
          <span className="nx-shares-label">盘前份额变化</span>
          <span>
            <span className={`nx-delta ${delta.cls}`}>{delta.text}</span>
            {row.atLimit === true && <span className="nx-full">额度用满</span>}
          </span>
        </div>
      </div>
      <div className="nx-foot">
        <span>{`总份额 ${fmtShares(row.shares)}`}</span>
        <button type="button" className="nx-link" aria-haspopup="dialog" onClick={onOpen}>
          PCF 清单 ›
        </button>
      </div>
    </article>
  );
}

function BoardRow({ row, calendar, onOpen, onOverall }) {
  const info = useReportOverall(row, onOverall, calendar);
  const ov = info.overall;
  const delta = deltaView(row.deltaShares, '无变化');
  return (
    <tr className={rowClass(ov)}>
      <td>
        <div className="nx-td-name">{row.name}</div>
        <CodePills row={row} />
      </td>
      <td>
        <span className={`nx-pill ${CLS[ov] || ''}`}>{overallLabel(ov)}</span>
      </td>
      {FIELDS.map(([k]) => {
        const ch = info.changes ? info.changes[k] : null;
        const moved = isMoved(ch?.change);
        return (
          <td key={k} className={`num ${moved ? CLS[ch.change] : ''}`}>
            <div className="nx-td-val">
              {moved && <span className="nx-td-mark">{ch.change === 'tightened' ? '▼ ' : '▲ '}</span>}
              {fmtLimit(info.after[k])}
            </div>
            {moved && <div className="nx-td-was">{`原 ${fmtLimit(ch.before)}`}</div>}
          </td>
        );
      })}
      <td className="num">
        <span className={`nx-delta ${delta.cls}`}>{delta.text}</span>
        {row.atLimit === true && (
          <div>
            <span className="nx-full">额度用满</span>
          </div>
        )}
      </td>
      <td className="num nx-td-muted">{fmtShares(row.shares)}</td>
      <td>
        <button type="button" className="nx-link" aria-haspopup="dialog" onClick={onOpen}>
          PCF 清单 ›
        </button>
      </td>
    </tr>
  );
}

// 手机端三行条目：代码+名称/结论；限额（变动在前）；盘前份额变化 · 额度用满 · 总份额。
const compact = (s) => s.replace(/,/g, '').replace(/份$/, '');
function MobileRow({ row, calendar, shareRange, onOpen, onOverall }) {
  const info = useReportOverall(row, onOverall, calendar);
  const ov = info.overall;
  const moved = [],
    rest = [];
  for (const [k] of FIELDS) {
    const ch = info.changes ? info.changes[k] : null;
    if (ch && isMoved(ch.change)) {
      const r = Number.isFinite(ch.ratio) ? `（×${fmtRatio(ch.ratio)}）` : '';
      moved.push({
        k,
        t: `${SHORT[k]} ${compact(fmtLimit(ch.before))}→${fmtLimit(ch.after).replace(/,/g, '')}${r}`,
        c: ch.change
      });
    } else {
      const v = fmtLimit(info.after[k]);
      if (v !== '不限' && v !== '—') rest.push(`${SHORT[k]} ${compact(v)}`);
    }
  }
  if (row.subscriptionAllowed === false) rest.push('仅允许赎回');
  if (!moved.length && !rest.length) rest.push('申购不限');
  const delta = deltaView(row.deltaShares, '0份');
  const sep = <span className="nx-m-dot"> • </span>;
  const parts = [
    ...moved.map((m) => (
      <span key={m.k} className={`nx-m-chg ${CLS[m.c]}`}>
        {m.t}
      </span>
    )),
    ...rest.map((t, i) => <span key={`r${i}`}>{t}</span>)
  ];
  return (
    <button type="button" className={`nx-m-row ${rowClass(ov)}`} onClick={onOpen} aria-haspopup="dialog">
      <div className="nx-m-l1">
        <span className="nx-m-name">
          <b>{row.code}</b>
          {` ${row.name}`}
        </span>
        <span className={`nx-m-status ${CLS[ov] || ''}`}>{overallLabel(ov)}</span>
      </div>
      <div className="nx-m-l2">
        {parts.map((p, i) => (
          <Fragment key={p.key}>
            {i > 0 && sep}
            {p}
          </Fragment>
        ))}
      </div>
      <div className="nx-m-l2">
        {`盘前 ${shareRange} `}
        <span className={`nx-m-delta ${delta.cls}`}>{delta.text}</span>
        {row.atLimit === true && (
          <>
            {sep}
            <span className="nx-m-full">额度用满</span>
          </>
        )}
        {Number.isFinite(row.shares) && (
          <>
            {sep}
            {compact(fmtShares(row.shares))}
          </>
        )}
      </div>
    </button>
  );
}

function PcfModal({ row, date, onClose, DetailDrawer }) {
  useEffect(() => {
    const k = (ev) => ev.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  const titleId = `nx-modal-title-${row.code}`;
  return (
    <div className="nx-modal-mask" onClick={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="nx-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="nx-modal-head">
          <h3 id={titleId}>{`${row.name} ${row.code} · PCF 清单`}</h3>
          <button type="button" className="nx-modal-close" aria-label="关闭" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="nx-modal-body">
          <DetailDrawer
            row={row}
            code={row.code}
            name={row.name}
            date={row.limitDate || date}
            id={`shares-detail-${row.code}`}
            labelledBy={titleId}
          />
        </div>
      </div>
    </div>
  );
}

const FILTERS = [
  ['all', '全部', () => true],
  ['changed', '限额有变化', (r, ov) => ['tightened', 'relaxed', 'mixed'].includes(ov[r.code])],
  ['full', '额度用满', (r) => r.atLimit === true],
  ['szse', '深市', (r) => isSz(r)],
  ['sse', '沪市', (r) => !isSz(r)]
];

function GridIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x={3} y={3} width={7} height={7} rx={1.5} />
      <rect x={14} y={3} width={7} height={7} rx={1.5} />
      <rect x={3} y={14} width={7} height={7} rx={1.5} />
      <rect x={14} y={14} width={7} height={7} rx={1.5} />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}
function ViewToggle({ mode, setMode }) {
  return (
    <div className="nx-toggle" role="group" aria-label="视图切换">
      <button
        type="button"
        className={mode === 'card' ? 'on' : ''}
        aria-pressed={mode === 'card'}
        title="卡片"
        onClick={() => setMode('card')}
      >
        <GridIcon />
      </button>
      <button
        type="button"
        className={mode === 'table' ? 'on' : ''}
        aria-pressed={mode === 'table'}
        title="表格"
        onClick={() => setMode('table')}
      >
        <ListIcon />
      </button>
    </div>
  );
}

function FilterChips({ rows, ov, filter, setFilter, className = '' }) {
  return (
    <div className={`filter-group ${className}`} role="group" aria-label="筛选">
      {FILTERS.map(([k, label, fn]) => (
        <button
          key={k}
          type="button"
          className={`filter-btn${filter === k ? ' active' : ''}`}
          aria-pressed={filter === k}
          onClick={() => setFilter(k)}
        >
          {label}
          <span className="filter-count">{rows.filter((r) => fn(r, ov)).length}</span>
        </button>
      ))}
    </div>
  );
}

function useViewMode() {
  const [mode, setModeRaw] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(VIEW_KEY) === 'table' ? 'table' : 'card';
    } catch {
      return 'card';
    }
  });
  const setMode = (m) => {
    setModeRaw(m);
    try {
      globalThis.localStorage?.setItem(VIEW_KEY, m);
    } catch {
      /* 隐私模式下 localStorage 不可用，仅本次生效 */
    }
  };
  return [mode, setMode];
}

export default function SharesBoard({ DetailDrawer }) {
  const [mode, setMode] = useViewMode();
  const mobile = useIsMobile();
  const [e, setE] = useState({ state: 'loading' });
  const [tick, setTick] = useState(0);
  const [today, setToday] = useState(() => shanghaiAccessDay());
  const [openKey, setOpenKey] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [ov, setOv] = useState({});

  useEffect(() => {
    const f = () => {
      if (document.visibilityState === 'visible') setToday(shanghaiAccessDay());
    };
    document.addEventListener('visibilitychange', f);
    window.addEventListener('focus', f);
    return () => {
      document.removeEventListener('visibilitychange', f);
      window.removeEventListener('focus', f);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const s = sharesClient.subscribe({ date: 'latest' });
    setE(
      s.stale
        ? { state: 'stale', data: s.stale, receivedAt: s.staleReceivedAt, reason: 'revalidating' }
        : { state: 'loading' }
    );
    s.promise.then((r) => {
      if (alive) setE(r);
    });
    return () => {
      alive = false;
      s.release();
    };
  }, [tick, today]);
  const onOverall = useCallback((code, v) => {
    setOv((o) => (o[code] === v ? o : { ...o, [code]: v }));
  }, []);
  const closeModal = useCallback(() => setOpenKey(null), []);

  const c = e.data;
  const rows = (c && c.records) || [];
  const refresh = () => setTick((x) => x + 1);
  const limitDate =
    (c && c.limitDate) || rows.reduce((a, r) => (r.limitDate && (!a || r.limitDate > a) ? r.limitDate : a), null);
  const prevLimitDate = (c && c.prevLimitDate) || (limitDate && c ? previousSession(limitDate, c.calendar) : null);
  const nTight = rows.filter((r) => ov[r.code] === 'tightened' || ov[r.code] === 'mixed').length;
  const nRelax = rows.filter((r) => ov[r.code] === 'relaxed' || ov[r.code] === 'mixed').length;
  const nFull = rows.filter((r) => r.atLimit === true).length;
  const fdef = FILTERS.find(([k]) => k === filter) || FILTERS[0];
  const ql = q.trim().toLowerCase();
  const list = rows
    .filter((r) => fdef[2](r, ov))
    .filter((r) => !ql || `${r.code} ${r.name}`.toLowerCase().includes(ql))
    .slice()
    .sort((a, b) => (ORDER[ov[a.code]] ?? 4) - (ORDER[ov[b.code]] ?? 4));
  const stale = e.state === 'stale';
  const open = (r) => () => setOpenKey(`${c.date}:${r.code}`);
  const openRow = c && openKey ? rows.find((x) => `${c.date}:${x.code}` === openKey) : null;
  const modal = openRow ? (
    <PcfModal row={openRow} date={c.date} onClose={closeModal} DetailDrawer={DetailDrawer} />
  ) : null;
  const stateTitle = e.state === 'loading' ? '正在读取份额与限额…' : e.state === 'error' ? '读取失败' : '暂无已验证快照';

  if (mobile) {
    const head =
      nTight || nRelax
        ? `${[nTight ? `${nTight}只基金收紧` : '', nRelax ? `${nRelax}只放宽` : ''].filter(Boolean).join('、')}，`
        : '限额均未变，';
    return (
      <div className="shares-panel nx-panel nx-m">
        {c && (
          <div className="nx-m-head">
            <p>
              <b>{head}</b>
              <span>对比 </span>
              <b>{`${md(prevLimitDate)} → ${md(limitDate)}`}</b>。
            </p>
            <button type="button" className="refresh-btn" aria-label="刷新" title="刷新" onClick={refresh}>
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        {c && <FilterChips rows={rows} ov={ov} filter={filter} setFilter={setFilter} className="nx-m-filters" />}
        {!c && (
          <div className={`state-view ${e.state}`} role={e.state === 'error' ? 'alert' : 'status'}>
            <h3>{stateTitle}</h3>
            {e.state !== 'loading' && (
              <button type="button" className="state-retry" onClick={refresh}>
                重试
              </button>
            )}
          </div>
        )}
        {c && (
          <div className="nx-m-list">
            {list.map((r) => (
              <MobileRow
                key={r.code}
                row={r}
                calendar={c.calendar}
                shareRange={`${md(c.prevDate)}→${md(c.date)}`}
                onOpen={open(r)}
                onOverall={onOverall}
              />
            ))}
          </div>
        )}
        {c && list.length === 0 && (
          <div className="no-match">
            <h3>没有符合条件的基金</h3>
          </div>
        )}
        {c && (
          <div className="nx-m-meta">{`抓取 ${fetchedTime(c.fetchedAt)}${stale ? ' · 本地缓存，待确认' : ''} · 点击查看 PCF 清单`}</div>
        )}
        {modal}
      </div>
    );
  }

  const tile = (key, label, n, cls) => (
    <button
      type="button"
      className={`nx-tile ${cls}${filter === key ? ' active' : ''}`}
      onClick={() => setFilter(filter === key ? 'all' : key)}
    >
      <span>{label}</span>
      <b>{n}</b>
    </button>
  );
  return (
    <div className="shares-panel nx-panel">
      <section className="nx-top">
        <div className="nx-tiles">
          {tile('all', '监控', rows.length, '')}
          {tile('changed', '限额收紧', nTight, nTight ? 'tight' : '')}
          {tile('changed', '限额放宽', nRelax, nRelax ? 'relax' : '')}
          {tile('full', '额度用满', nFull, nFull ? 'warn' : '')}
        </div>
        <div className="nx-tools">
          <label className="search-box">
            <Search size={14} aria-hidden="true" />
            <input
              type="text"
              aria-label="搜索代码或简称"
              placeholder="搜索代码或简称"
              value={q}
              onChange={(ev) => setQ(ev.target.value)}
            />
            {q && (
              <button type="button" className="search-clear" aria-label="清空搜索" onClick={() => setQ('')}>
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </label>
          <ViewToggle mode={mode} setMode={setMode} />
          <button type="button" className="refresh-btn" aria-label="刷新" title="刷新" onClick={refresh}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      </section>
      {c && (
        <div className="nx-meta">
          <span>
            限额日 <b>{limitDate || '—'}</b> 对比 {prevLimitDate || '—'}
          </span>
          <span>
            份额 {c.prevDate || '—'} → <b>{c.date}</b>
          </span>
          <span>{`抓取 ${fetchedTime(c.fetchedAt)}`}</span>
          {stale && <span className="stale">本地缓存，待重新确认</span>}
        </div>
      )}
      {c && <FilterChips rows={rows} ov={ov} filter={filter} setFilter={setFilter} />}
      {!c && (
        <section className="shares-card">
          <div className={`state-view ${e.state}`} role={e.state === 'error' ? 'alert' : 'status'}>
            <span className="state-icon" aria-hidden="true">
              {e.state === 'error' ? (
                <CircleAlert size={22} />
              ) : e.state === 'loading' ? (
                <RefreshCw size={22} className="spin" />
              ) : (
                <Inbox size={22} />
              )}
            </span>
            <h3>{stateTitle}</h3>
            {e.state !== 'loading' && (
              <button type="button" className="state-retry" onClick={refresh}>
                重试
              </button>
            )}
          </div>
        </section>
      )}
      {c &&
        list.length > 0 &&
        (mode === 'table' ? (
          <section className="nx-table-wrap">
            <table className="nx-table">
              <thead>
                <tr>
                  <th>基金</th>
                  <th>限额</th>
                  {FIELDS.map(([k, label]) => (
                    <th key={k} className="num">
                      {label}
                    </th>
                  ))}
                  <th className="num">盘前份额变化</th>
                  <th className="num">总份额</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <BoardRow key={r.code} row={r} calendar={c.calendar} onOpen={open(r)} onOverall={onOverall} />
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <div className="nx-grid">
            {list.map((r) => (
              <BoardCard key={r.code} row={r} calendar={c.calendar} onOpen={open(r)} onOverall={onOverall} />
            ))}
          </div>
        ))}
      {c && list.length === 0 && (
        <div className="no-match">
          <h3>没有符合条件的基金</h3>
        </div>
      )}
      {modal}
      {c && (
        <div className="nx-legend">
          ▼收紧 ▲放宽 —未变 · 份额变化 = 上一交易日份额 − 再前一交易日份额 · 等于当日申购限额标「额度用满」
        </div>
      )}
    </div>
  );
}
