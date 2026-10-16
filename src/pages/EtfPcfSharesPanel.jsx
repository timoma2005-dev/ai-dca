import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Search,
  RefreshCw,
  AlertTriangle,
  Inbox,
  CircleAlert,
  ChevronDown,
  X,
  Boxes,
  TrendingUp
} from 'lucide-react';
import {
  sharesClient,
  shanghaiAccessDay,
  snapshotLabel,
  freshnessMessage
} from '../app/etfPcfSharesClient.js';
import {
  formatInt,
  formatDeltaShares,
  formatSharesCompact,
  formatNetSumWan,
  formatCreationCell,
  limitText,
  isCappedOrNear,
  ceilingMeta,
  sortRecords,
  matchesSearch,
  pillRows,
  progressMeta,
  summaryStats
} from './etfPcfSharesView.js';
import './etfPcfShares.css';
import EtfPcfSharesDetail from './EtfPcfSharesDetail.jsx';

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

const tone = (n) => (n === null || n === undefined ? 'muted' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');
const sz = (r) => r.code.startsWith('159');

const FILTERS = [
  ['all', '全部标的', () => true, ''],
  ['ceiling', '顶格 / 接近', isCappedOrNear, 'amber'],
  ['inflow', '份额净增', (r) => r.deltaShares > 0, 'emerald'],
  ['szse', '深市', sz, 'slate'],
  ['sse', '沪市', (r) => !sz(r), 'slate']
];

const TABLE_COLUMNS = [
  { key: 'code', label: '代码', sort: 'code' },
  { key: 'name', label: '名称' },
  { key: 'delta', label: '份额增量', sort: 'deltaShares', align: 'num' },
  { key: 'creation', label: '盘前净新增份额', sort: 'creationShares', align: 'num' },
  { key: 'ceiling', label: '顶格状态', align: 'center' },
  { key: 'shares', label: '本期总份额', sort: 'shares', align: 'num' },
  { key: 'prev', label: '上期总份额', align: 'num' },
  { key: 'limit', label: '累计申购上限', align: 'num' },
  { key: 'limitDate', label: '限额日期', align: 'center' },
  { key: 'toggle', label: '详情', align: 'center' }
];

function CeilingBadge({ record }) {
  const meta = ceilingMeta(record);
  return (
    <span className={`ceiling-badge kind-${meta.kind}`}>
      {meta.kind === 'at-limit' && <span className="pulse-dot" aria-hidden="true" />}
      {meta.label}
    </span>
  );
}

function CreationCell({ record }) {
  const cell = formatCreationCell(record);
  return (
    <span className={`creation-cell tone-${cell.tone}`}>
      {cell.text}
      {cell.kind && <span className="est-badge">{cell.kind === 'exact' ? '确定' : '估算'}</span>}
    </span>
  );
}

function UsageMeter({ record }) {
  const meta = progressMeta(record);
  if (!meta.drawable) return null;
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span>申购上限使用率{record.limitDate ? `（${record.limitDate}）` : ''}</span>
        <strong className={`usage-text ${meta.tone}`}>{meta.text}</strong>
      </div>
      <div className="usage-bar" aria-hidden="true">
        <span className={`usage-fill ${meta.tone}`} style={{ width: `${meta.width}%` }} />
      </div>
    </div>
  );
}

export default function EtfPcfSharesPanel() {
  const [result, setResult] = useState({ state: 'loading' });
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [day, setDay] = useState(() => shanghaiAccessDay());
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: null, dir: 'desc' });
  const [methodOpen, setMethodOpen] = useState(false);
  const [layout, setLayout] = useState('table');
  const rootRef = useRef(null);

  // 布局按 panel 自身可用宽度切换：<640 卡片、640-1199 宽卡片、≥1200 宽表。
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const apply = (width) => {
      const next = width >= 1200 ? 'table' : width >= 640 ? 'wide' : 'compact';
      setLayout((prev) => (prev === next ? prev : next));
    };
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => apply(el.getBoundingClientRect().width);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) apply(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') setDay(shanghaiAccessDay());
    };
    const midnight = new Date(`${day}T00:00:00+08:00`).getTime() + 86400000;
    const timer = setTimeout(check, Math.max(1, midnight - Date.now()));
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [day]);

  useEffect(() => {
    let active = true;
    const subscription = sharesClient.subscribe();
    setResult(
      subscription.stale
        ? {
            state: 'stale',
            data: subscription.stale,
            receivedAt: subscription.staleReceivedAt,
            reason: 'revalidating'
          }
        : { state: 'loading' }
    );
    subscription.promise.then((value) => {
      if (active) setResult(value);
    });
    return () => {
      active = false;
      subscription.release();
    };
  }, [retry, day]);

  useEffect(() => {
    if (!result.data) return;
    const expires = Date.parse(result.data.expiresAt);
    const deadline =
      result.state === 'stale' || !Number.isFinite(result.receivedAt)
        ? expires
        : Math.min(expires, result.receivedAt + 300000);
    let timer;
    const check = () => {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        timer = setTimeout(check, Math.min(remaining, 2147483647));
        return;
      }
      setResult((old) =>
        Date.now() >= expires
          ? { state: 'error', reason: 'expired_snapshot' }
          : { ...old, state: 'stale', reason: 'ttl_expired' }
      );
    };
    check();
    return () => clearTimeout(timer);
  }, [result.data, result.receivedAt, result.state]);

  const data = result.data;
  const records = data?.records || [];
  const freshness = data ? freshnessMessage(data, day) : '';
  const stale = result.state === 'stale' || Boolean(freshness);
  const pills = data ? pillRows(data, records) : [];
  const stats = summaryStats(records);
  const activeFilter = FILTERS.find(([key]) => key === filter) || FILTERS[0];
  const filtered = sortRecords(
    records.filter(activeFilter[2]).filter((r) => matchesSearch(r, search)),
    sort
  );

  const retryRead = () => setRetry((v) => v + 1);
  const toggle = (r) =>
    setExpanded((old) => (old === `${data.date}:${r.code}` ? null : `${data.date}:${r.code}`));
  const onSort = (key) =>
    setSort((old) =>
      old.key === key ? { key, dir: old.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }
    );
  const resetFilters = () => {
    setSearch('');
    setFilter('all');
  };

  const tableView = (
    <div className="shares-table-wrap" role="region" aria-label="份额新增宽表" tabIndex={0}>
      <table className="shares-table">
        <thead>
          <tr>
            {TABLE_COLUMNS.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={col.align === 'num' ? 'num' : col.align === 'center' ? 'center' : ''}
                aria-sort={
                  col.sort
                    ? sort.key === col.sort
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                    : undefined
                }
              >
                {col.sort ? (
                  <button type="button" className={`th-sort ${col.align || ''}`} onClick={() => onSort(col.sort)}>
                    {col.label}
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => {
            const open = expanded === `${data.date}:${r.code}`;
            return (
              <Fragment key={r.code}>
                <tr className={`shares-row ${open ? 'expanded' : ''}`} onClick={() => toggle(r)}>
                  <td>
                    <span className={`market-tag ${sz(r) ? 'sz' : 'sh'}`}>{sz(r) ? '深' : '沪'}</span>
                    <span className="code-mono">{r.code}</span>
                  </td>
                  <td className="cell-name">{r.name}</td>
                  <td className="num">
                    <span className={`tone-${tone(r.deltaShares)}`}>{formatDeltaShares(r.deltaShares)}</span>
                  </td>
                  <td className="num">
                    <CreationCell record={r} />
                  </td>
                  <td className="center">
                    <CeilingBadge record={r} />
                  </td>
                  <td className="num">{formatInt(r.shares)}</td>
                  <td className="num muted">{formatInt(r.prevShares)}</td>
                  <td className="num">{limitText(r)}</td>
                  <td className="center limit-date">{r.limitDate || '—'}</td>
                  <td className="center">
                    <button
                      type="button"
                      id={`shares-toggle-${r.code}`}
                      className={`row-toggle ${open ? 'is-open' : ''}`}
                      aria-expanded={open}
                      aria-controls={`shares-detail-${r.code}`}
                      aria-label={`${open ? '收起' : '展开'} ${r.name}（${r.code}）PCF 详情`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(r);
                      }}
                    >
                      <ChevronDown size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="detail-drawer-tr">
                    <td colSpan={10} className="detail-drawer-td">
                      <EtfPcfSharesDetail
                        key={`${data.date}:${r.code}`}
                        code={r.code}
                        name={r.name}
                        date={data.date}
                        id={`shares-detail-${r.code}`}
                        labelledBy={`shares-toggle-${r.code}`}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const cardView = (
    <div className="shares-card-list">
      {filtered.map((r) => {
        const open = expanded === `${data.date}:${r.code}`;
        return (
          <article className={`shares-card ${open ? 'is-open' : ''}`} key={r.code}>
            <button
              type="button"
              id={`shares-toggle-${r.code}`}
              className="shares-card-head"
              aria-expanded={open}
              aria-controls={`shares-detail-${r.code}`}
              onClick={() => toggle(r)}
            >
              <span className="card-title-row">
                <span className={`market-tag ${sz(r) ? 'sz' : 'sh'}`}>{sz(r) ? '深' : '沪'}</span>
                <span className="code-mono">{r.code}</span>
                <span className="card-name">{r.name}</span>
                <CeilingBadge record={r} />
              </span>
              <span className="card-kpi-grid">
                <span className="card-kpi primary">
                  <span className="kpi-label">盘前净新增</span>
                  <span className="kpi-value">
                    <CreationCell record={r} />
                  </span>
                </span>
                <span className="card-kpi">
                  <span className="kpi-label">份额增量</span>
                  <span className={`kpi-value tone-${tone(r.deltaShares)}`}>
                    {formatDeltaShares(r.deltaShares)}
                  </span>
                </span>
                <span className="card-kpi">
                  <span className="kpi-label">本期总份额</span>
                  <span className="kpi-value">{formatSharesCompact(r.shares)}</span>
                </span>
              </span>
              <span className="card-foot-row">
                <span className="card-limit">
                  累计申购上限 <strong>{limitText(r)}</strong>
                  {r.limitDate && <em className="card-limit-date">（{r.limitDate}）</em>}
                </span>
                <span className="card-toggle-hint">
                  {open ? '收起清单' : 'PCF 详情'}
                  <ChevronDown size={14} aria-hidden="true" className={open ? 'is-open' : ''} />
                </span>
              </span>
            </button>
            {open && (
              <div
                className="shares-card-drawer"
                id={`shares-detail-${r.code}`}
                role="region"
                aria-labelledby={`shares-toggle-${r.code}`}
              >
                <UsageMeter record={r} />
                <EtfPcfSharesDetail
                  key={`${data.date}:${r.code}`}
                  code={r.code}
                  name={r.name}
                  date={data.date}
                />
              </div>
            )}
          </article>
        );
      })}
    </div>
  );

  return (
    <div className="shares-panel" data-layout={layout} ref={rootRef}>
      {data && (
        <header className="shares-page-header">
          <div className="shares-title-row">
            <h2>ETF 申购赎回份额监控</h2>
            <span className="shares-scope-badge">跨境/QDII 核心 {records.length} 只</span>
            <span className={`status-indicator-chip ${stale ? 'stale' : 'synced'}`}>
              <span className="status-dot" aria-hidden="true" />
              {stale ? '数据滞后待确认' : '最新已核验报表'}
            </span>
          </div>
          {layout === 'table' ? (
            <div className="shares-pill-row">
              <span className="pill-row-label">数据口径</span>
              {pills.map((p) => (
                <span className="method-pill" key={p.key}>
                  <span className="method-pill-key">{p.label}</span>
                  <strong>{p.value}</strong>
                </span>
              ))}
            </div>
          ) : (
            <div className="methodology-bar">
              <button
                type="button"
                className="methodology-toggle"
                aria-expanded={methodOpen}
                aria-controls="shares-methodology"
                onClick={() => setMethodOpen((v) => !v)}
              >
                数据口径与日期锚点
                <ChevronDown size={14} aria-hidden="true" className={methodOpen ? 'is-open' : ''} />
              </button>
              {methodOpen && (
                <ul className="methodology-list" id="shares-methodology">
                  {pills.map((p) => (
                    <li key={p.key}>
                      <strong>{p.label}</strong>
                      <span>{p.value}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="shares-caption">
            {snapshotLabel(data)} · 源抓取 {fetchedTime(data.fetchedAt)}（上海时间）
          </p>
        </header>
      )}
      {data && (
        <section className="shares-stat-grid" aria-label="监控概览">
          <article className="stat-card">
            <div className="stat-card-head">
              <span>监控标的总数</span>
              <Boxes size={15} aria-hidden="true" />
            </div>
            <div className="stat-card-body">
              <span className="stat-value">{records.length}</span>
              <span className="stat-unit">只</span>
              <span className="stat-badges">
                <em className="stat-badge sz">深市 {stats.szCount}</em>
                <em className="stat-badge sh">沪市 {stats.shCount}</em>
              </span>
            </div>
            <p className="stat-caption">深市份额已接入 · 沪市待接入</p>
          </article>
          <article className="stat-card amber">
            <div className="stat-card-head">
              <span>申购顶格 / 接近</span>
              <AlertTriangle size={15} aria-hidden="true" />
            </div>
            <div className="stat-card-body">
              <span className="stat-value">{stats.cappedCount}</span>
              <span className="stat-unit">只</span>
              <span className="stat-badges">
                <em className="stat-badge amber-strong">顶格 {stats.atLimitCount} 只</em>
                <em className="stat-badge amber-soft">接近 {stats.nearCount} 只</em>
              </span>
            </div>
            <p className="stat-caption">净增份额达到当日申购上限 90% 以上时计入</p>
          </article>
          <article className="stat-card emerald">
            <div className="stat-card-head">
              <span>合计净新增（盘前推导）</span>
              <TrendingUp size={15} aria-hidden="true" />
            </div>
            <div className="stat-card-body">
              <span className={`stat-value ${tone(stats.netSum)}`}>
                {stats.netSum === null ? '—' : formatNetSumWan(stats.netSum)}
              </span>
              {stats.netSum !== null && <span className="stat-unit">万份</span>}
            </div>
            <p className="stat-caption">
              有效深市样本 {stats.verifiedCount} 只 · 净流入 {stats.inflowCount}/{stats.verifiedCount}
            </p>
          </article>
        </section>
      )}
      {data && stale && (
        <div role="status" className="stale-warning-banner">
          <AlertTriangle size={18} />
          <div>
            <strong>数据滞后提醒：</strong>
            {freshness}
            {result.state === 'stale' && (
              <span>
                {['revalidating', 'ttl_expired'].includes(result.reason)
                  ? '本地缓存待重新确认'
                  : '读取失败，展示上次快照'}
              </span>
            )}
          </div>
          <button onClick={retryRead}>刷新重试</button>
        </div>
      )}
      {data && (
        <div className="panel-toolbar">
          <div className="filter-tab-group" role="group" aria-label="筛选">
            {FILTERS.map(([key, label, match, badgeTone]) => (
              <button
                key={key}
                type="button"
                className={`filter-tab-btn ${filter === key ? 'active' : ''}`}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
                <span className={`filter-count-badge ${badgeTone}`}>{records.filter(match).length}</span>
              </button>
            ))}
          </div>
          <div className="toolbar-actions">
            <label className="search-box">
              <Search aria-hidden="true" />
              <input
                aria-label="搜索代码或简称"
                placeholder="搜索代码或名称，如 159501 / 纳指"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="清空搜索"
                  onClick={() => setSearch('')}
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </label>
            <span className="filtered-count">
              共 <b>{filtered.length}</b> 条
            </span>
          </div>
        </div>
      )}
      <section className="shares-main-card">
        {!data && (
          <div className="state-view-wrapper" role={result.state === 'error' ? 'alert' : 'status'}>
            <div className={`state-icon-box ${result.state}`}>
              {result.state === 'error' ? (
                <CircleAlert />
              ) : result.state === 'loading' ? (
                <RefreshCw className="shares-spin" />
              ) : (
                <Inbox />
              )}
            </div>
            <h3 className="state-title">
              {result.state === 'loading'
                ? '正在读取深交所 PCF 份额快照…'
                : result.state === 'error'
                  ? '份额快照读取失败'
                  : '暂无已验证份额快照'}
            </h3>
            {result.state === 'loading' ? (
              <div className="shares-skeleton" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div className="skeleton-row" key={i}>
                    <span className="skeleton-box" />
                    <span className="skeleton-box" />
                    <span className="skeleton-box" />
                    <span className="skeleton-box" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <p className="state-desc">
                  {result.state === 'error'
                    ? '网络异常或数据校验未通过，请稍后重试。'
                    : result.reason === 'missing_report_date'
                      ? '报表缺少数据日期，暂无法计算份额新增'
                      : '当日份额报表尚未生成，数据就绪后会自动更新。'}
                </p>
                <button className="action-btn-primary" onClick={retryRead}>
                  <RefreshCw size={14} />
                  重试读取快照
                </button>
              </>
            )}
          </div>
        )}
        {data &&
          (filtered.length ? (
            layout === 'table' ? (
              tableView
            ) : (
              cardView
            )
          ) : (
            <div className="shares-empty">
              <div className="shares-empty-icon">
                <Inbox size={22} aria-hidden="true" />
              </div>
              <h3>未找到符合条件的 ETF 标的</h3>
              <p>尝试其他代码或名称关键字，或清空当前筛选条件。</p>
              <button type="button" className="shares-empty-reset" onClick={resetFilters}>
                重置筛选条件
              </button>
            </div>
          ))}
      </section>
      {data && (
        <footer className="panel-footer-notes">
          <ul className="legend-list">
            <li>
              <span className="legend-dot amber" aria-hidden="true" />
              顶格：净增份额等于当日累计申购上限
            </li>
            <li>
              <span className="legend-dot emerald" aria-hidden="true" />
              净增：本期份额较上期为正流入
            </li>
            <li>
              <span className="legend-dot sky" aria-hidden="true" />
              不限：管理人未设累计申购限额
            </li>
            <li>
              <span className="legend-est" aria-hidden="true">
                约
              </span>
              申赎双向开放时净增为估算值，单向开放为确定值
            </li>
          </ul>
          <p className="legend-meta">数据每个交易日盘前自动推导更新 · 投资需谨慎</p>
        </footer>
      )}
    </div>
  );
}
