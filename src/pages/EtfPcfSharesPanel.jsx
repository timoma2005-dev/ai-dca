import { Fragment, useEffect, useState } from 'react';
import {
  Monitor,
  Table2,
  LayoutGrid,
  Search,
  ChevronDown,
  Clock,
  CalendarDays,
  RefreshCw,
  AlertTriangle,
  Inbox,
  CircleAlert
} from 'lucide-react';
import {
  sharesClient,
  shanghaiAccessDay,
  creationLabel,
  snapshotLabel,
  freshnessMessage,
  sharesCeiling
} from '../app/etfPcfSharesClient.js';
import './etfPcfShares.css';
import EtfPcfSharesDetail from './EtfPcfSharesDetail.jsx';
const number = (n, digits = 2) =>
  Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const wan = (n) => (Number.isFinite(n) ? number(n / 10000) : '—');
const delta = (n) =>
  Number.isFinite(n)
    ? `${n > 0 ? '+' : ''}${(n / 10000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
const total = (n) => (Number.isFinite(n) ? `${(n / 100000000).toFixed(2)} 亿` : '—');
const sz = (r) => r.code.startsWith('159');
const ceiling = (r) => r.atLimit || (r.nearTotalLimit && r.utilization <= 1);
const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');
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
function Ceiling({ row }) {
  const badge = sharesCeiling(row);
  const fmtWan = (v) => (Number.isSafeInteger(v) ? `${(v / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}万份` : '—');
  const limitText = row.totalLimitKind === 'unlimited' ? '无' : row.totalLimitKind === 'limited' ? fmtWan(row.totalLimitShares) : '—';
  const unitText = Number.isSafeInteger(row.creationUnitShares) ? fmtWan(row.creationUnitShares) : '—';
  return (
    <span className="ceiling-wrap">
      <span className={`ceiling-tag ${badge.kind}`}>
        <span className="ceiling-bullet" />
        {badge.label}
      </span>
      <span className="ceiling-detail">
        最小 {unitText} · 上限 {limitText}
      </span>
    </span>
  );
}
function Creation({ row }) {
  if (!Number.isFinite(row.creationShares) || row.creationShares < 0) return '暂无数据';
  return (
    <>
      盘前净新增份额: <strong>{creationLabel(row)} 万</strong>{' '}
      <span className="est-badge">{row.creationSharesKind === 'exact' ? '确定' : '估算'}</span>
    </>
  );
}
function Amount({ row }) {
  return Number.isFinite(row.deltaAmountWan) ? (
    number(row.deltaAmountWan)
  ) : (
    <span className="amount-cell-badge" title="D 日净值凭证暂缺，严禁使用盘中 IOPV 伪造">
      <CircleAlert size={12} />
      待官方净值
    </span>
  );
}
export default function EtfPcfSharesPanel() {
  const [result, setResult] = useState({ state: 'loading' });
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [day, setDay] = useState(() => shanghaiAccessDay());
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('auto');
  const [showAmount, setShowAmount] = useState(false);
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
  const filters = [
    ['all', '全部标的', () => true],
    ['ceiling', '顶格 / 接近', ceiling],
    ['inflow', '份额净增', (r) => r.deltaShares > 0],
    ['szse', '深市已接入', sz],
    ['sse', '沪市待接入', (r) => !sz(r)]
  ];
  const filtered = records
    .filter(filters.find(([key]) => key === filter)[2])
    .filter((r) => `${r.code} ${r.name}`.toLowerCase().includes(search.trim().toLowerCase()));
  const verified = records.filter((r) => sz(r) && Number.isFinite(r.deltaShares));
  const net = verified.length ? verified.reduce((sum, r) => sum + r.deltaShares, 0) : null;
  const retryRead = () => setRetry((v) => v + 1);
  const toggle = (r) =>
    setExpanded((old) => (old === `${data.date}:${r.code}` ? null : `${data.date}:${r.code}`));
  return (
    <div className="shares-panel">
      <section className="freshness-hero-card">
        <div className="freshness-grid">
          <div className="freshness-primary-info">
            <div className="freshness-status-row">
              <span className={`status-indicator-chip ${data ? (stale ? 'stale' : 'synced') : 'empty'}`}>
                <span className="status-dot" />
                {data
                  ? stale
                    ? '数据滞后待确认'
                    : '最新已核验报表'
                  : result.state === 'loading'
                    ? '正在读取份额快照'
                    : result.state === 'error'
                      ? '份额快照读取失败'
                      : '暂无有效快照'}
              </span>
              <span>深交所 PCF 自动抓取链路</span>
            </div>
            <div className="freshness-headline">
              份额统计基准日：<span className="shares-primary">{data?.date || '—'}</span>
              <span className="freshness-sub-baseline">（对比上一交易日：{data?.prevDate || '—'}）</span>
            </div>
            <div className="freshness-meta-details">
              <span className="freshness-meta-item">
                <Clock />
                源抓取时间：{data ? fetchedTime(data.fetchedAt) : '—'} (上海时间)
              </span>
              <span className="freshness-meta-item">
                <CalendarDays />
                获取发布日：{data?.availableOn || '—'}
              </span>
            </div>
            {data && <p className="shares-snapshot-caption">{snapshotLabel(data)}</p>}
          </div>
          <div className="kpi-stat-cards">
            {[
              [
                '监控标的总数',
                data ? records.length : '—',
                '只',
                `深市 ${records.filter(sz).length} 只 + 沪市 ${records.filter((r) => !sz(r)).length} 只`
              ],
              [
                '申购顶格 / 接近',
                data ? records.filter(ceiling).length : '—',
                '只',
                records
                  .filter(ceiling)
                  .map((r) => `${r.code}(${r.atLimit ? '顶格' : `${Math.round(r.utilization * 100)}%`})`)
                  .join(' ') || '暂无顶格 / 接近标的'
              ],
              [
                '单日合计净流入',
                net === null ? '—' : `${net > 0 ? '+' : ''}${wan(net)}`,
                '万份',
                `有效深市 ${verified.length} 只净增总和`
              ]
            ].map(([label, value, unit, caption], i) => (
              <div className="kpi-stat-box" key={label}>
                <span className="kpi-label">{label}</span>
                <div className={`kpi-value ${i === 1 ? 'highlight-amber' : i === 2 ? tone(net) : ''}`}>
                  {value}
                  <span className="kpi-unit">{unit}</span>
                </div>
                <span className="kpi-caption">{data ? caption : '等待快照核验'}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
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
          <div className="filter-tab-group">
            {filters.map(([key, label, match]) => (
              <button
                key={key}
                className={`filter-tab-btn ${filter === key ? 'active' : ''}`}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
                <span className="filter-count-badge">{records.filter(match).length}</span>
              </button>
            ))}
          </div>
          <div className="toolbar-actions">
            <label className="search-box">
              <Search />
              <input
                aria-label="搜索代码或简称"
                placeholder="搜索代码或简称..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="view-mode-toggle">
              {[
                ['auto', Monitor, '自适应布局'],
                ['table', Table2, '宽屏表格视图'],
                ['cards', LayoutGrid, '移动端卡片看板视图']
              ].map(([key, Icon, label]) => (
                <button
                  key={key}
                  title={label}
                  aria-label={label}
                  aria-pressed={view === key}
                  className={`view-mode-btn ${view === key ? 'active' : ''}`}
                  onClick={() => setView(key)}
                >
                  <Icon />
                </button>
              ))}
            </div>
            <button
              className="shares-amount-toggle"
              aria-pressed={showAmount}
              onClick={() => setShowAmount((v) => !v)}
            >
              新增金额：{showAmount ? '显示传统列' : '智能折叠'}
            </button>
          </div>
        </div>
      )}
      <section className={`shares-main-card ${view === 'auto' ? 'auto-responsive' : `force-${view}`}`}>
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
              <div className="shares-skeleton">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton-table-row">
                    {[1, 2, 3, 4].map((j) => (
                      <div className="skeleton-box" key={j} />
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <>
                <p className="state-desc">
                  {result.state === 'error'
                    ? '与网关服务通信异常或本地缓存校验失败。已自动终止脏数据渲染，以防止失真的份额差分影响管理员决策。'
                    : result.reason === 'missing_report_date'
                      ? '报表缺少数据日期，暂无法计算份额新增'
                      : '系统按每个交易日 09:00（上海时间）自动运行深圳证券交易所官方 PCF 与份额报表流水线。当前暂无已入库的有效份额投影，数据清算完成后将自动呈现。'}
                </p>
                {result.state === 'empty' && (
                  <div className="shares-pipeline">
                    <strong>自动化流水线说明：</strong>
                    <div>• 09:00 自动触发上交所/深交所 PCF 源 XLSX 下载</div>
                    <div>• 09:01 严格比对相邻交易日日历，计算双日份额净差分</div>
                    <div>• 09:02 验证 D 日累计申购限额并核定顶格置信度</div>
                  </div>
                )}
                <button className="action-btn-primary" onClick={retryRead}>
                  <RefreshCw size={14} />
                  重试读取快照
                </button>
              </>
            )}
          </div>
        )}
        {data && (
          <div className="shares-responsive-table">
            <table className="shares-table">
              <thead>
                <tr>
                  <th>代码 / 标的简称</th>
                  <th className="text-right">
                    <div className="th-with-help">
                      净变动 · 盘前净新增份额 <span className="th-tag">万份</span>
                    </div>
                  </th>
                  <th className="text-center">限额顶格状态</th>
                  <th className="text-right">
                    本期总份额 <span className="th-tag">{data.date.slice(5)}</span>
                  </th>
                  <th className="text-right">
                    上期总份额 <span className="th-tag">{data.prevDate?.slice(5) || '—'}</span>
                  </th>
                  {showAmount && <th>新增金额估算</th>}
                  <th>申赎明细</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const open = expanded === `${data.date}:${r.code}`;
                  return (
                    <Fragment key={r.code}>
                      <tr className={`shares-row ${open ? 'expanded' : ''}`} onClick={() => toggle(r)}>
                        <td className="shares-symbol">
                          <div className="symbol-cell">
                            <div className="symbol-row-top">
                              <span className="symbol-code">{r.code}</span>
                              <span className={`symbol-market-tag ${sz(r) ? 'sz' : 'sh'}`}>
                                {sz(r) ? '深市' : '沪市'}
                              </span>
                            </div>
                            <span className="symbol-name">{r.name}</span>
                          </div>
                        </td>
                        <td className="text-right shares-desktop">
                          <div className="delta-cell">
                            <span className={`delta-val ${tone(r.deltaShares)}`}>{delta(r.deltaShares)}</span>
                            <span className="delta-sub-est">
                              {r.deltaShares === null ? '—' : <Creation row={r} />}
                            </span>
                          </div>
                        </td>
                        <td className="text-center shares-ceiling">
                          <Ceiling row={r} />
                        </td>
                        {[r.shares, r.prevShares].map((n, i) => (
                          <td key={i} className="text-right shares-desktop">
                            <span className="shares-total-val" title={`${number(n, 0)} 份`}>
                              {total(n)}
                            </span>
                            <div className="shares-date-hint">{n === null ? '—' : `${wan(n)} 万份`}</div>
                          </td>
                        ))}
                        {showAmount && (
                          <td className="text-center shares-desktop">
                            <Amount row={r} />
                          </td>
                        )}
                        <td className="shares-mobile-kpis">
                          <div className="card-kpi-row">
                            <div className="card-metric-col">
                              <span className="card-metric-label">净变动 (万份)</span>
                              <span className={`card-metric-val ${tone(r.deltaShares)}`}>
                                {delta(r.deltaShares)}
                              </span>
                              <span className="card-metric-sub">
                                {r.deltaShares === null ? '未比对' : <Creation row={r} />}
                              </span>
                            </div>
                            <div className="card-metric-col text-right">
                              <span className="card-metric-label">本期规模 ({data.date.slice(5)})</span>
                              <span className="card-metric-val">{total(r.shares)}</span>
                              <span className="card-metric-sub">上期: {total(r.prevShares)}</span>
                            </div>
                            <div className="card-metric-col text-right">
                              <span className="card-metric-label">限额约束</span>
                              <span className="card-metric-val">
                                {r.totalLimitKind === 'limited'
                                  ? `${wan(r.totalLimitShares)} 万`
                                  : r.totalLimitKind === 'unlimited'
                                    ? '累计不限'
                                    : '—'}
                              </span>
                              <span className="card-metric-sub">{sz(r) ? '申赎规则见明细' : '待接入'}</span>
                            </div>
                          </div>
                        </td>
                        <td className="shares-actions text-center">
                          <span className="shares-mobile-amount">
                            金额估算：
                            <Amount row={r} />
                          </span>
                          <button
                            id={`shares-toggle-${r.code}`}
                            className={`row-expand-btn ${open ? 'active' : ''}`}
                            aria-expanded={open}
                            aria-controls={`shares-detail-${r.code}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(r);
                            }}
                          >
                            <span className="shares-desktop">{open ? '收起' : '明细'}</span>
                            <span className="shares-mobile-action">
                              {open ? '收起 PCF 明细' : '展开 PCF 明细'}
                            </span>
                            <ChevronDown />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="detail-drawer-tr">
                          <td colSpan={showAmount ? 7 : 6} className="detail-drawer-td">
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
                {!filtered.length && (
                  <tr>
                    <td colSpan={showAmount ? 7 : 6} className="shares-no-match">
                      未找到符合条件的 ETF 标的
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <footer className="panel-footer-notes">
        <ul className="footer-note-list">
          {[
            '盘前净新增份额口径：份额日报表是收盘后披露，净增份额=本期总份额-上期总份额，为盘前已知数。仅允许赎回时为 0（确定）；仅允许申购时净增即为申购量（确定）；申赎双向开放时净差分标注为「约」（因盘中实际申购与赎回可能互相抵消）。',
            '顶格判定规范：净增份额精确等于数据日 PCF 累计申购限额时标为「顶格 (100%)」；达到上限 90% 以上标为「接近」；超过上限观测通常为大宗特批申购；累计不限标的免受配额约束。',
            '新增金额设计决策 (v1)：深交所当前报表源缺少经过双重审计的 D 日每份人民币净值凭证。为恪守金融严谨性、拒绝以盘中 IOPV 凑数产生误导，本期新增金额暂留空，待官方净值流打通后自动解锁。'
          ].map((text) => (
            <li className="footer-note-item" key={text}>
              <span className="footer-note-bullet" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
