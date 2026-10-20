/**
 * 「份额新增」页面（tab=shares）整体替换版。
 * 数据层只读：快照消费 src/app/etfPcfSharesClient.js；限额环比结论与沪市份额由快照自带
 * （worker 预计算透传），PCF 明细仅在展开抽屉时经 src/app/etfPcfDetailClient.js 按需订阅。
 * §9 否决项已落实：无 KPI 磁贴、无限额利用率进度条、无 ▲▼、无金额估算列、无手动视图切换。
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { Search, RefreshCw, AlertTriangle, Inbox, CircleAlert, ChevronDown, X } from 'lucide-react';
import {
  sharesClient,
  shanghaiAccessDay,
  sharesCeiling,
  chipForLimitChange,
  creationLabel,
  limitLabel,
  snapshotLabel,
  freshnessMessage
} from '../app/etfPcfSharesClient.js';
import { pcfDetailClient, pcfDetailSections, formatPcfShares } from '../app/etfPcfDetailClient.js';
import './shares-experience.css';
import SharesBoard from './SharesBoard.jsx';

const zh = (n, options) => n.toLocaleString('zh-CN', options);
const isSzCode = (code) => code.startsWith('159');
const isSz = (r) => isSzCode(r.code);

// 净增份额（万份，带正负号）；零为 0.00，缺失为 —，null 不补 0。
function formatDeltaWan(n) {
  if (!Number.isFinite(n)) return '—';
  const v = zh(n / 10000, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n > 0 ? `+${v}` : v;
}

// 总份额：大额用亿，小规模回退万份/份；缺失为 —。
function formatYi(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e8) return `${zh(n / 1e8, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿`;
  if (n >= 1e4) return `${zh(n / 1e4, { maximumFractionDigits: 2 })} 万份`;
  return `${zh(n)} 份`;
}

const formatWan = (n) => `${zh(n / 10000, { maximumFractionDigits: 2 })} 万份`;

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

const matchesSearch = (r, query) => {
  const q = String(query || '').trim().toLowerCase();
  return !q || `${r.code} ${r.name}`.toLowerCase().includes(q);
};

// 顶格/接近的唯一口径是 sharesCeiling 的 kind；over-limit 独立展示，不并入告警。
const isCeilingRow = (r) => ['at-limit', 'near-limit'].includes(sharesCeiling(r).kind);

const FILTERS = [
  ['all', '全部', () => true],
  ['ceiling', '顶格 / 接近', isCeilingRow],
  ['inflow', '净增', (r) => Number.isFinite(r.deltaShares) && r.deltaShares > 0],
  ['outflow', '净减', (r) => Number.isFinite(r.deltaShares) && r.deltaShares < 0],
  ['szse', '深市', isSz],
  ['sse', '沪市', (r) => !isSz(r)]
];

const SORT_FIELDS = { delta: 'deltaShares', util: 'utilization', shares: 'shares' };

// 三态排序：默认恢复快照顺序；缺失始终置底；同值按代码稳定排序。
function sortRows(list, sort) {
  if (!sort.key) return list;
  const field = SORT_FIELDS[sort.key];
  const dir = sort.dir === 'asc' ? 1 : -1;
  const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return [...list].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    const aMiss = !Number.isFinite(av);
    const bMiss = !Number.isFinite(bv);
    if (aMiss || bMiss) {
      if (aMiss && bMiss) return byCode(a, b);
      return aMiss ? 1 : -1;
    }
    if (av === bv) return byCode(a, b);
    return (av < bv ? -1 : 1) * dir;
  });
}

function SortHeader({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey;
  const hint = !active ? '点击按降序排列' : sort.dir === 'desc' ? '点击切换为升序' : '点击恢复默认顺序';
  return (
    <button type="button" className={`th-sort${active ? ' active' : ''}`} title={hint} onClick={() => onSort(sortKey)}>
      {label}
      <span className="sort-glyph" aria-hidden="true">
        {!active ? '⇅' : sort.dir === 'desc' ? '↓' : '↑'}
      </span>
    </button>
  );
}

function DeltaSharesCell({ row, maxAbsDelta }) {
  const d = row.deltaShares;
  const tone = !Number.isFinite(d) ? 'muted' : d > 0 ? 'pos' : d < 0 ? 'neg' : 'zero';
  const creationReady =
    Number.isFinite(d) &&
    (row.creationSharesKind === 'exact' || row.creationSharesKind === 'estimate') &&
    Number.isFinite(row.creationShares) &&
    row.creationShares >= 0;
  const sub = !Number.isFinite(d)
    ? '未比对'
    : creationReady
      ? `${row.creationSharesKind === 'estimate' ? '估算' : '确定'}申购 ${creationLabel(row)} 万份`
      : null;
  // 净增对比条只作装饰：全表固定尺度（maxAbsDelta 来自完整快照），零不画填充、缺失不画条。
  const drawable = Number.isFinite(d) && d !== 0;
  return (
    <div className="delta-block">
      <b className={`delta-val ${tone}`}>{formatDeltaWan(d)}</b>
      {sub && <span className="delta-sub">{sub}</span>}
      {drawable && (
        <span className="delta-bar" aria-hidden="true">
          <span
            className={`delta-fill ${tone}`}
            style={{ width: `${Math.round((Math.abs(d) / maxAbsDelta) * 100)}%` }}
          />
        </span>
      )}
    </div>
  );
}

function UtilizationCell({ row, snapshotDate }) {
  const meta = sharesCeiling(row);
  const sse = !isSz(row);
  // 生效限额：净申购上限优先（角标"净"），没有净限额时回退到累计（角标"累计"）。
  // 优先用 KV 预计算的 eff* 字段，没有则实时从 net/total 推导。
  let effKind, effShares, srcBadge;
  if (row.effLimitKind) {
    effKind = row.effLimitKind;
    effShares = row.effLimitShares;
    srcBadge = row.limitSource === 'net' ? '净' : row.limitSource === 'total' ? '累计' : null;
  } else {
    const netKind = row.netLimitKind;
    const totalKind = row.totalLimitKind;
    if (netKind === 'limited' && Number.isFinite(row.netLimitShares)) {
      effKind = 'limited'; effShares = row.netLimitShares; srcBadge = '净';
    } else if (totalKind === 'limited' && Number.isFinite(row.totalLimitShares)) {
      effKind = 'limited'; effShares = row.totalLimitShares; srcBadge = '累计';
    } else if (totalKind === 'unlimited') {
      effKind = 'unlimited'; effShares = null; srcBadge = null;
    } else {
      effKind = 'unknown'; effShares = null; srcBadge = null;
    }
  }
  let sub = null;
  if (effKind === 'limited' && Number.isFinite(effShares)) {
    sub = (
      <>
        {srcBadge && <span className="limit-src-badge">{srcBadge}</span>}
        {`当日上限 ${formatWan(effShares)}`}
      </>
    );
    if (row.limitDate && row.limitDate !== snapshotDate) {
      sub = (
        <>
          {sub} · 限 {row.limitDate.slice(5)}
        </>
      );
    }
  } else if (effKind === 'unlimited') {
    sub = '无累计申购限额';
  }
  return (
    <div className="util-block">
      <span
        className={`ceiling-tag kind-${meta.kind}${sse && meta.kind === 'pending' ? ' util-sse-pending' : ''}`}
        title={sse ? undefined : limitLabel(row)}
      >
        <span className="tag-dot" aria-hidden="true" />
        {meta.label}
      </span>
      {sub && <span className="util-sub">{sub}</span>}
    </div>
  );
}

function TotalSharesCell({ row }) {
  return (
    <div className="total-block">
      <b className="total-val">{formatYi(row.shares)}</b>
      <span className="total-prev">上期 {formatYi(row.prevShares)}</span>
    </div>
  );
}

// 告警条内的限额环比标签：快照自带的 limitChanges 结论直接渲染（chipForLimitChange 纯函数），
// 不请求上一限额日历史、不重算分类；旧快照无字段时 chip 为 null，胶囊不渲染。
function AlertChip({ row, onSelect }) {
  const chip = chipForLimitChange(row);
  if (!chip) return null;
  return (
    <button
      type="button"
      className="alert-chip"
      title={`筛选查看 ${row.name}（${row.code}）`}
      onClick={onSelect}
    >
      <b className="alert-chip-code">{row.code}</b>
      <span className="alert-chip-name">{row.name}</span>
      <span className={`limit-change ${chip.tone}`}>{chip.label}</span>
    </button>
  );
}

const PCF_ALLOWED_LABELS = ['申购的允许情况', '赎回的允许情况'];

function pcfValue(label, value) {
  if (!PCF_ALLOWED_LABELS.includes(label)) return value;
  if (value === '允许') return <span className="allow-chip ok">✓ 允许</span>;
  if (value === '不允许') return <span className="allow-chip blocked">✕ 暂停</span>;
  return value; // 未知状态不推断
}

// 抽屉「限额环比」固定四行：累计/净/单账户累计/单账户净申购，键与 worker 透传的 limitChanges 对齐。
const LIMIT_COMPARE_ROWS = [
  ['total', '累计申购'],
  ['net', '净申购'],
  ['accountTotal', '单账户累计申购'],
  ['accountNet', '单账户净申购']
];

// 环比单侧取值：limited 显示份额（formatPcfShares），unlimited 显示「不设上限」，其余为 —。
function limitCompareValue(side) {
  if (!side || typeof side !== 'object') return '—';
  if (side.kind === 'unlimited') return '不设上限';
  if (side.kind === 'limited' && Number.isFinite(side.shares)) return formatPcfShares(side.shares);
  return '—';
}

// 抽屉条目变化标签：tightened/relaxed 与告警胶囊共用同一映射（chipForLimitChange），
// unchanged/incomparable 为环比小节专属文案；条目缺失或非法倍数不渲染标签。
function limitChangeTag(entry) {
  if (entry?.change === 'unchanged') return { label: '持平', tone: 'flat' };
  if (entry?.change === 'incomparable') return { label: '不可比', tone: 'flat' };
  return chipForLimitChange({ limitChanges: { total: entry }, limitSource: 'total' });
}

// 行内展开明细：非底部 Sheet/Dialog，无遮罩与焦点锁。
function PcfDetailDrawer({ row, code, name, date, id, labelledBy }) {
  const sse = !isSzCode(code);
  const [result, setResult] = useState({ state: 'loading' });
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    let active = true;
    setResult({ state: 'loading' });
    const request = pcfDetailClient.subscribe(code, date);
    request.promise.then((value) => {
      if (active) setResult(value);
    });
    return () => {
      active = false;
      request.release();
    };
    // retryCount 仅用于错误重试时强制重新订阅，不参与请求参数。
  }, [code, date, retryCount]);
  const region = { id, role: 'region', 'aria-labelledby': labelledBy };
  const sections = result.state === 'ready' ? pcfDetailSections(result.data) : null;
  const tDay = sections?.[1];
  const pDay = sections?.[0];
  const kvList = (rows) => (
    <dl className="pcf-kv-list">
      {rows.map(([label, value]) => (
        <div className="pcf-kv-row" key={label}>
          <dt className="pcf-kv-label">{label}</dt>
          <dd className="pcf-kv-val">{pcfValue(label, value)}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <div {...region} className="drawer-content">
      <div className="drawer-head">
        <span className="drawer-title">
          {name}（{code}）PCF 申赎清单
        </span>
        <span className="drawer-source">
          数据源：
          {sse ? (
            <a
              href={`https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C`}
              target="_blank"
              rel="noopener noreferrer"
              className="source-link"
            >
              上交所官方 PCF ↗
            </a>
          ) : (
            <a
              href={`https://reportdocs.static.szse.cn/files/text/etf/ETF${code}${date.replace(/-/g, '')}.txt`}
              target="_blank"
              rel="noopener noreferrer"
              className="source-link"
            >
              深交所官方 PCF ↗
            </a>
          )}
        </span>
      </div>
      {row?.limitChanges != null && (
        <section className="pcf-card limit-compare" aria-label="限额环比">
          <header className="pcf-card-head">
            <span className="pcf-card-title">限额环比</span>
            <span className="pcf-date-pill">
              {row.prevLimitDate || '—'} → {row.limitDate || '—'}
            </span>
          </header>
          <dl className="pcf-kv-list">
            {LIMIT_COMPARE_ROWS.map(([key, label]) => {
              const entry = row.limitChanges[key];
              const tag = entry ? limitChangeTag(entry) : null;
              return (
                <div className="pcf-kv-row" key={label}>
                  <dt className="pcf-kv-label">{label}</dt>
                  <dd className="pcf-kv-val">
                    <span>
                      {entry ? `${limitCompareValue(entry.before)} → ${limitCompareValue(entry.after)}` : '— → —'}
                    </span>
                    {tag && <span className={`limit-change ${tag.tone}`}>{tag.label}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
      {result.state === 'loading' && (
        <p className="drawer-state" role="status">
          正在读取申赎信息…
        </p>
      )}
      {result.state === 'empty' && (
        <p className="drawer-state" role="status">
          暂无该日期的申赎缓存数据，等待更新
        </p>
      )}
      {result.state === 'error' && (
        <div className="drawer-error" role="alert">
          <p>申赎信息读取失败，可点击重试</p>
          <button type="button" className="drawer-retry" onClick={() => setRetryCount((v) => v + 1)}>
            重试读取
          </button>
        </div>
      )}
      {tDay && pDay && (
        <div className="pcf-grid">
          <section className="pcf-card t-day" aria-label={`T 日 ${tDay.date} 申赎规则与上限`}>
            <header className="pcf-card-head">
              <span className="pcf-card-title">T 日申赎规则与上限</span>
              <span className="pcf-date-pill">T 日：{tDay.date}</span>
            </header>
            {kvList(tDay.rows)}
          </section>
          <section className="pcf-card p-day" aria-label={`P 日 ${pDay.date} 清算基准`}>
            <header className="pcf-card-head">
              <span className="pcf-card-title">P 日清算基准</span>
              <span className="pcf-date-pill">P 日：{pDay.date}</span>
            </header>
            {kvList(pDay.rows)}
            <p className="pcf-formula">
              申赎最小单位的现金差额与净值以 P 日清算基准计算；当前缺少 D 日官方净值凭证，本页不做金额估算，禁止使用盘中 IOPV。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function SharesPanel() {
  const [result, setResult] = useState({ state: 'loading' });
  const [reloadCount, setReloadCount] = useState(0);
  const [day, setDay] = useState(() => shanghaiAccessDay());
  const [expandedKey, setExpandedKey] = useState(null);
  const [filterKey, setFilterKey] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: null, dir: 'desc' });
  const rolloverRef = useRef(day);

  // 上海访问日跨日：零点定时器 + visibilitychange/focus 复查；跨日触发重新订阅并清空旧展开态。
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
    if (rolloverRef.current === day) return;
    rolloverRef.current = day;
    setExpandedKey(null);
  }, [day]);

  // 快照订阅：刷新按钮/横幅重试只递增 reloadCount；迟到结果由 active 拒绝，清理必调 release()。
  useEffect(() => {
    let active = true;
    const subscription = sharesClient.subscribe({ date: 'latest' });
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
    // reloadCount 仅用于重试时强制重新订阅，不参与请求参数。
  }, [reloadCount, day]);

  // 展示降级定时器：receivedAt+5min 转 stale；expiresAt 到期清空快照转 error；长 timeout 分段。
  useEffect(() => {
    if (!result.data) return undefined;
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
  const isStale = result.state === 'stale' || Boolean(freshness);
  // 有限额统计：生效限额 limited 的行（净优先口径），与告警候选无关。
  const hasEffLimit = (r) => {
    const k = r.effLimitKind || (r.netLimitKind === 'limited' ? 'limited' : r.totalLimitKind);
    return k === 'limited';
  };
  const limitedRows = records.filter(hasEffLimit);
  // 限额环比告警：worker 预计算的变化行（tightened/relaxed/mixed），高亮与胶囊候选同源派生；
  // 纯账户项变化或生效项持平的行仍高亮，但可能没有胶囊文案。
  const alertRows = records.filter((r) => ['tightened', 'relaxed', 'mixed'].includes(r.limitChange));
  const changedCodes = new Set(alertRows.map((r) => r.code));
  const chipRows = alertRows.filter((r) => chipForLimitChange(r));
  // 净流入：沪深全量按有效 delta 汇总（负值参与净额），缺失 delta 的行不计入 N。
  const verified = records.filter((r) => Number.isFinite(r.deltaShares));
  const netSum = verified.length ? verified.reduce((sum, r) => sum + r.deltaShares, 0) : null;
  // 限额基准日：优先顶层 limitDate，旧快照回退各行 limitDate 最大值（最新）。
  const limitBaseline =
    data?.limitDate ||
    records.reduce((max, r) => (r.limitDate && (!max || r.limitDate > max) ? r.limitDate : max), null);
  const szCount = records.filter(isSz).length;
  // 净增对比条分母固定为完整快照有效 delta 的 max(1, abs)：筛选、搜索、排序不改变尺度。
  const maxAbsDelta = records.reduce(
    (max, r) => (Number.isFinite(r.deltaShares) ? Math.max(max, Math.abs(r.deltaShares)) : max),
    1
  );
  const activeFilter = FILTERS.find(([key]) => key === filterKey) || FILTERS[0];
  const filtered = sortRows(
    records.filter(activeFilter[2]).filter((r) => matchesSearch(r, search)),
    sort
  );
  const headTitle = data
    ? [
        snapshotLabel(data),
        `发布可用日：${data.availableOn}`,
        data.pcfSnapshot?.source === 'szse_pcf'
          ? `PCF 快照日：${data.pcfSnapshot.date}（深市 ${data.pcfSnapshot.codes.length} 只）`
          : 'PCF 快照：暂无',
        '各行申购限额以行内限额日期为准',
        data.prevLimitDate ? `上一限额日：${data.prevLimitDate}` : null
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const staleText = freshness
    ? `${freshness}${result.state === 'stale' ? '，本地缓存待重新确认' : ''}`
    : result.state === 'stale'
      ? ['revalidating', 'ttl_expired'].includes(result.reason)
        ? '数据滞后：本地缓存待重新确认'
        : '数据滞后：读取失败，展示上次快照，待重新确认'
      : '更新及时性待确认';

  const retry = () => setReloadCount((v) => v + 1);
  const toggle = (r) => setExpandedKey((old) => (old === `${data.date}:${r.code}` ? null : `${data.date}:${r.code}`));
  const onSort = (key) =>
    setSort((old) =>
      old.key !== key ? { key, dir: 'desc' } : old.dir === 'desc' ? { key, dir: 'asc' } : { key: null, dir: 'desc' }
    );
  const sortAria = (key) => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

  return (
    <div className="shares-panel">
      {data && (
        <header className="shares-head">
          <div className="head-info">
            <span className={`status-chip ${isStale ? 'stale' : 'synced'}`}>
              <span className="status-dot" aria-hidden="true" />
              {isStale ? '数据滞后待确认' : '最新已核验'}
            </span>
            <span className="head-date">
              份额基准日 <b>{data.date}</b>
              <span className="head-prev"> · 对比 {data.prevDate || '—'}</span>
              {limitBaseline && limitBaseline !== data.date && (
                <span className="head-prev">
                  {' '}· 限额基准日 <b>{limitBaseline}</b>
                </span>
              )}
            </span>
            <span className="head-meta" title={headTitle}>
              抓取 {fetchedTime(data.fetchedAt)}
            </span>
          </div>
          <div className="head-stats">
            <span
              className={`head-stat ${netSum === null ? '' : netSum > 0 ? 'pos' : netSum < 0 ? 'neg' : 'zero'}`}
              title={`全部 ${records.length} 只中 ${verified.length} 只有效净增合计（负值参与净额）`}
            >
              <span className="head-label">净流入</span>
              <b>{netSum === null ? '—' : `${netSum > 0 ? '+' : ''}${zh(netSum / 10000, { maximumFractionDigits: 2 })}`}</b>
              <small>万份</small>
            </span>
            <span
              className={`head-stat${limitedRows.length ? ' warn' : ''}`}
              title={limitedRows.map((r) => `${r.code} ${r.name}`).join(' · ') || '暂无有限额标的'}
            >
              <span className="head-label">有限额</span>
              <b>{limitedRows.length}</b>
              <small>只</small>
            </span>
            <span className="head-stat" title={`深市 ${szCount} · 沪市 ${records.length - szCount}`}>
              <span className="head-label">监控</span>
              <b>{records.length}</b>
              <small>只</small>
            </span>
            <button
              type="button"
              className="refresh-btn"
              aria-label="刷新快照"
              title="重新读取份额快照，命中有效缓存时直接复用"
              onClick={retry}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
        </header>
      )}
      {data && chipRows.length > 0 && (
        <section className="alert-strip" aria-label="今日需关注">
          <span className="alert-title">
            <AlertTriangle size={16} aria-hidden="true" />
            今日需关注
          </span>
          <div className="alert-chips">
            {chipRows.map((r) => (
              <AlertChip key={r.code} row={r} onSelect={() => setFilterKey('ceiling')} />
            ))}
          </div>
        </section>
      )}
      {data && isStale && (
        <div className="stale-banner" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <p>{staleText}</p>
          <button type="button" className="stale-retry" onClick={retry}>
            刷新重试
          </button>
        </div>
      )}
      {data && (
        <div className="panel-toolbar">
          <div className="filter-group" role="group" aria-label="筛选标的">
            {FILTERS.map(([key, label, match]) => (
              <button
                key={key}
                type="button"
                className={`filter-btn${filterKey === key ? ' active' : ''}`}
                aria-pressed={filterKey === key}
                onClick={() => setFilterKey(key)}
              >
                {label}
                <span className="filter-count">{records.filter(match).length}</span>
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={14} aria-hidden="true" />
            <input
              type="text"
              aria-label="搜索代码或简称"
              placeholder="搜索代码或简称"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" className="search-clear" aria-label="清空搜索" onClick={() => setSearch('')}>
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </label>
        </div>
      )}
      <section className="shares-card">
        {!data && (
          <div className={`state-view ${result.state}`} role={result.state === 'error' ? 'alert' : 'status'}>
            <span className="state-icon" aria-hidden="true">
              {result.state === 'error' ? (
                <CircleAlert size={22} />
              ) : result.state === 'loading' ? (
                <RefreshCw size={22} className="spin" />
              ) : (
                <Inbox size={22} />
              )}
            </span>
            <h3>
              {result.state === 'loading'
                ? '正在读取深交所 PCF 份额快照…'
                : result.state === 'error'
                  ? '份额快照读取失败'
                  : '暂无已验证份额快照'}
            </h3>
            {result.state === 'loading' ? (
              <div className="skeleton" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <div className="skeleton-row" key={i}>
                    {[0, 1, 2, 3].map((j) => (
                      <span className="skeleton-box" key={j} />
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <>
                <p className="state-desc">
                  {result.state === 'error'
                    ? '网络异常或数据校验未通过，请稍后重试。'
                    : result.reason === 'missing_report_date'
                      ? '报表缺少数据日期，暂无法计算份额新增。'
                      : '当日份额报表尚未生成。流水线每交易日 09:00 抓取、09:01 校验、09:02 发布，就绪后自动更新。'}
                </p>
                <button type="button" className="state-retry" onClick={retry}>
                  重试读取快照
                </button>
              </>
            )}
          </div>
        )}
        {data && filtered.length === 0 && (
          <div className="no-match">
            <Inbox size={22} aria-hidden="true" />
            <h3>未找到符合条件的 ETF 标的</h3>
            <p>尝试其他代码或简称关键字，或清空当前筛选。</p>
            <button
              type="button"
              className="reset-btn"
              onClick={() => {
                setSearch('');
                setFilterKey('all');
              }}
            >
              清空筛选条件
            </button>
          </div>
        )}
        {data && filtered.length > 0 && (
          <div className="shares-table-wrap" role="region" aria-label="份额新增列表" tabIndex={0}>
            <table className="shares-table">
              <thead>
                <tr>
                  <th scope="col">代码 / 简称</th>
                  <th scope="col" aria-sort={sortAria('delta')}>
                    <SortHeader label="净增份额" sortKey="delta" sort={sort} onSort={onSort} />
                  </th>
                  <th scope="col" aria-sort={sortAria('util')}>
                    <SortHeader label="限额利用率" sortKey="util" sort={sort} onSort={onSort} />
                  </th>
                  <th scope="col" aria-sort={sortAria('shares')}>
                    <SortHeader label="本期总份额" sortKey="shares" sort={sort} onSort={onSort} />
                  </th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const open = expandedKey === `${data.date}:${r.code}`;
                  // 高亮跟随告警条：限额有变化的才高亮
                  const highlighted = changedCodes.has(r.code);
                  return (
                    <Fragment key={r.code}>
                      <tr
                        className={`shares-row${highlighted ? ' alert-row' : ''}${open ? ' is-open' : ''}`}
                        onClick={() => toggle(r)}
                      >
                        <td className="sh-symbol">
                          <span className="symbol-line">
                            <b className="symbol-code">{r.code}</b>
                            <span className={`market-tag ${isSz(r) ? 'sz' : 'sse'}`}>
                              {isSz(r) ? '深市' : '沪市'}
                            </span>
                          </span>
                          <span className="symbol-name">{r.name}</span>
                        </td>
                        <td className="sh-delta">
                          <DeltaSharesCell row={r} maxAbsDelta={maxAbsDelta} />
                        </td>
                        <td className="sh-util">
                          <UtilizationCell row={r} snapshotDate={data.date} />
                        </td>
                        <td className="sh-total">
                          <TotalSharesCell row={r} />
                        </td>
                        <td className="sh-actions">
                          <button
                            type="button"
                            id={`shares-toggle-${r.code}`}
                            className={`detail-btn${open ? ' is-open' : ''}`}
                            aria-expanded={open}
                            aria-controls={`shares-detail-${r.code}`}
                            aria-label={`${open ? '收起' : '展开'}${r.name}（${r.code}）PCF 明细`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(r);
                            }}
                          >
                            明细
                            <ChevronDown size={14} aria-hidden="true" className={`chev${open ? ' is-open' : ''}`} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="drawer-row">
                          <td colSpan={5} className="drawer-cell">
                            <PcfDetailDrawer
                              key={`${data.date}:${r.code}`}
                              row={r}
                              code={r.code}
                              name={r.name}
                              date={r.limitDate || data.date}
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
        )}
      </section>
      {data && (
        <footer className="shares-notes">
          <details>
            <summary>
              数据口径说明
              <span className="notes-arrow" aria-hidden="true">
                ▸
              </span>
            </summary>
            <ul className="notes-list">
              <li>
                净增份额 = 本期总份额 − 上一统计交易日总份额（当前对比 {data.prevDate || '—'}）；申购数按盘前
                PCF 推导，申赎双向开放时为估算、仅申购开放时为确定值。
              </li>
              <li>顶格 = 净增份额恰好等于当日累计申购上限；接近 = 达到上限 90% 及以上；超过上限为观测口径，单独展示、不计入告警。</li>
              <li>沪市（513 开头）份额已接入上交所 ETF 规模数据，申赎规则取自上交所 PCF；因缺少 D 日官方净值凭证，不提供「新增金额估算」，也不使用盘中 IOPV 兜底。</li>
            </ul>
          </details>
        </footer>
      )}
    </div>
  );
}

// 旧版表格面板保留导出，便于对照与回退；页面默认渲染看板视图（SharesBoard）。
export { SharesPanel as LegacySharesPanel, PcfDetailDrawer };

export default function SharesExperience() {
  return <SharesBoard DetailDrawer={PcfDetailDrawer} />;
}
