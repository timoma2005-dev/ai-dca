import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronRight, Moon, Palette, RefreshCw, Sun } from 'lucide-react';
import './cn-home.css';
import { CnFundLimitDetail } from './CnFundLimitDetail.jsx';
import { PremiumChart } from './cn-home/PremiumChart.jsx';

const BASE = String(import.meta.env?.VITE_MARKETS_API_BASE || '/api/market-collector').replace(/\/$/, '');
const ROUTES = {
  overview: '/aggregates/home-market-overview',
  series: '/aggregates/home-market-series',
  limits: '/aggregates/fund-limit-overview',
};
const DATASETS = {
  overview: '/datasets/home-market-overview/global',
  series: '/datasets/home-market-series/today%3A5m',
  limits: '/datasets/fund-limit-overview/global',
};
// Phase 1 (D3): theme state lives on the .cn-home root; localStorage keys use the cn-home: prefix.
const THEME_KEY = 'cn-home:theme';
const COLOR_MODE_KEY = 'cn-home:colorMode';
const MARKET_STATES = {
  open: { label: '交易中', tone: 'open' }, trading: { label: '交易中', tone: 'open' },
  pre_open: { label: '待开市', tone: 'rest' }, lunch_break: { label: '午间休市', tone: 'rest' },
  break: { label: '午间休市', tone: 'rest' }, closed: { label: '已收市', tone: 'closed' },
  holiday: { label: '休市', tone: 'closed' }, unknown: { label: '状态待确认', tone: 'unknown' },
};
function marketMeta(data) {
  const key = String(data?.marketState || data?.sessionState || data?.marketStatus || 'unknown').toLowerCase();
  return { key, ...(MARKET_STATES[key] || { label: data?.marketStateLabel || '状态待确认', tone: 'unknown' }) };
}

function readStoredTheme() { try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } }
function readStoredColorMode() { try { return localStorage.getItem(COLOR_MODE_KEY) === 'us' ? 'us' : 'cn'; } catch { return 'cn'; } }
function cacheKey(section) { return `cn-home:${section}:v1`; }
function readCache(section) { try { return JSON.parse(localStorage.getItem(cacheKey(section)) || 'null'); } catch { return null; } }
function writeCache(section, value) { try { localStorage.setItem(cacheKey(section), JSON.stringify(value)); } catch {} }
async function request(path) {
  const response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = await response.json();
  return value?.payload || value;
}
async function loadSection(section, force) {
  try { return await request(ROUTES[section]); }
  catch (firstError) {
    try { return await request(DATASETS[section]); }
    catch {
      if (!force) throw firstError;
      const collected = await request('/aggregates/home-market-collect');
      return collected[section] || collected[section === 'limits' ? 'limits' : section];
    }
  }
}
function number(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function pct(value) { const n = number(value); return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`; }
function compact(value, currency = 'CNY') {
  const n = number(value); if (n == null) return '—';
  const sign = currency === 'USD' ? '$' : '¥';
  if (Math.abs(n) >= 100000000) return `${sign}${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${sign}${(n / 10000).toFixed(1)}万`;
  return `${sign}${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}
function timeText(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value).slice(0, 16) : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function count(source, ...keys) { for (const key of keys) { const value = number(source?.[key]); if (value != null) return value; } return 0; }
function Section({ title, side, loading, error, onRetry, children, className = '' }) {
  return <section className={`cn-home-card ${className}`} data-scroll-card="true"><header className="cn-home-title"><span>{title}</span>{side}</header>{loading && !children ? <div className="cn-home-empty"><RefreshCw className="cn-home-spin" />正在读取本地数据…</div> : error && !children ? <button className="cn-home-retry" onClick={onRetry}><AlertCircle />加载失败，点击重试</button> : children}</section>;
}

// Phase 2: three equal-height metric cards. Footnotes baseline-align via margin-top:auto.
function OverviewCards({ data, limits, onOpenDetail }) {
  const b = data?.breadth || {};
  const totals = limits?.currencyTotals || [];
  const cny = totals.find((x) => String(x.currency).toUpperCase() === 'CNY');
  const usd = totals.find((x) => String(x.currency).toUpperCase() === 'USD');
  const rise = count(b, 'riseCount', 'rise');
  const fall = count(b, 'fallCount', 'fall');
  const flat = count(b, 'flatCount', 'flat');
  const total = rise + fall + flat;
  const upPct = total ? (rise / total) * 100 : 0;
  const flatPct = total ? (flat / total) * 100 : 0;
  const downPct = total ? (fall / total) * 100 : 0;
  const median = b.premiumMedianPercent ?? b.premiumMedian;
  const prevMedian = b.previousPremiumMedianPercent ?? b.previousPremiumMedian;
  const medianDelta = number(median) != null && number(prevMedian) != null ? number(median) - number(prevMedian) : null;
  const highPremium = number(median) != null && number(median) >= 8;
  const market = marketMeta(data);
  const limitedCount = (cny?.limitedCount ?? 0) + (usd?.limitedCount ?? 0);
  const quotaBox = (row, currency, label) => (
    <button type="button" className="cn-home-quota-box" onClick={() => onOpenDetail?.(currency)} aria-label={`${label}额度详情`}>
      <span className="cn-home-quota-title"><span>{label}</span><ChevronRight /></span>
      <strong className="cn-home-quota-num">{compact(row?.amount, currency)}</strong>
      <span className="cn-home-quota-desc">{row ? `${row.fundCount ?? '—'} 只跟踪 / ${row.limitedCount ?? '—'} 只限额` : '暂无额度数据'}</span>
    </button>
  );
  return <>
    <div className="cn-home-session"><span className={`cn-home-dot is-${market.tone}`} />{market.label}<span>{timeText(data?.priceAsOf || data?.generatedAt)}</span></div>
    <div className="cn-home-ov-grid">
      <div className="cn-home-ov-card">
        <div className="cn-home-ov-head">
          <span className="cn-home-ov-title">场内全池涨跌比</span>
          <span className="cn-home-badge is-up">{rise} 涨 / {fall} 跌</span>
        </div>
        <div className="cn-home-ov-metric">
          <span className="cn-home-metric-value is-up">{rise}</span>
          <span className="cn-home-metric-sub">涨 / {fall} 跌 / {flat} 平 (全池 {total} 只)</span>
        </div>
        <div className="cn-home-ov-middle">
          <div className="cn-home-breadth-progress" role="img" aria-label={`上涨 ${upPct.toFixed(1)}%，持平 ${flatPct.toFixed(1)}%，下跌 ${downPct.toFixed(1)}%`}>
            <div className="cn-home-progress-up" style={{ width: `${upPct.toFixed(1)}%` }} />
            <div className="cn-home-progress-flat" style={{ width: `${flatPct.toFixed(1)}%` }} />
            <div className="cn-home-progress-down" style={{ width: `${downPct.toFixed(1)}%` }} />
          </div>
          <div className="cn-home-breadth-labels">
            <span>上涨占比 {upPct.toFixed(1)}%</span>
            <span>下跌 {downPct.toFixed(1)}%</span>
          </div>
        </div>
        <div className="cn-home-ov-foot"><span>场内全池</span><span>{timeText(data?.priceAsOf || data?.generatedAt)} 口径</span></div>
      </div>
      <div className="cn-home-ov-card">
        <div className="cn-home-ov-head">
          <span className="cn-home-ov-title">场内溢价中位数</span>
          {highPremium ? <span className="cn-home-badge is-up">高溢价预警</span> : <span className="cn-home-badge is-info">溢价平稳</span>}
        </div>
        <div className="cn-home-ov-metric">
          <span className={`cn-home-metric-value ${number(median) >= 0 ? 'is-up' : 'is-down'}`}>{pct(median)}</span>
          <span className="cn-home-metric-sub">中位溢价</span>
        </div>
        <div className="cn-home-ov-middle">
          <div className="cn-home-breadth-labels">
            <span>{prevMedian == null ? '实时口径' : <>昨日基准：<b>{pct(prevMedian)}</b></>}</span>
            {medianDelta != null ? <span>溢价扩幅：<b>{pct(medianDelta)}</b></span> : null}
          </div>
        </div>
        <div className="cn-home-ov-foot"><span>计算公式：(现价 - 估值NAV) / NAV</span><span>防追高提示</span></div>
      </div>
      <div className="cn-home-ov-card">
        <div className="cn-home-ov-head">
          <span className="cn-home-ov-title">场外可用申购额度</span>
          <button type="button" className="cn-home-link" onClick={() => onOpenDetail?.('CNY')}>查看完整额度详情 ›</button>
        </div>
        <div className="cn-home-quota-dual">
          {quotaBox(cny, 'CNY', '人民币份额 (CNY)')}
          {quotaBox(usd, 'USD', '美元份额 (USD)')}
        </div>
        <div className="cn-home-ov-foot">
          <span>{limitedCount} 只限购</span>
          <span>{limits?.limitAsOf ? `更新于 ${timeText(limits.limitAsOf)}` : '每日自动汇总'}</span>
        </div>
      </div>
    </div>
    {(data?.anomalies || []).length ? <div className="cn-home-warning">{data.anomalies[0]?.message || data.anomalies[0]}</div> : null}
  </>;
}

function pickSeries(payload, mode, group) {
  const block = payload?.modes?.[mode] || {};
  if (group === 'all') {
    const rows = block?.aggregate?.series || block?.aggregate || [];
    return Array.isArray(rows) ? rows : [];
  }
  const funds = Array.isArray(block.series) ? block.series.filter((x) => x.groupKey === group) : [];
  if (funds.length) return funds;
  const aggregate = block?.aggregate?.series || [];
  return aggregate.filter((x) => x.groupKey === group);
}
function trendAmount(row, currency) {
  if (!row) return null;
  const key = currency === 'USD' ? 'usd' : 'cny';
  return number(row[key] ?? row?.totalByCurrency?.[currency]);
}
function trendBadge(summaries) {
  const ups = summaries.filter((s) => (s.delta || 0) > 0).length;
  const downs = summaries.filter((s) => (s.delta || 0) < 0).length;
  if (ups > downs) return { text: '放宽', tone: 'is-down' };
  if (downs > ups) return { text: '收紧', tone: 'is-up' };
  return { text: '稳定', tone: 'is-info' };
}
// Phase 4: limits section keeps its data logic; rendering follows the reference
// (7-day trend card with status badge + events board styling).
function Limits({ data, onFund, onOpenDetail }) {
  const totals = Array.isArray(data?.currencyTotals) ? data.currencyTotals : [];
  const trend = (Array.isArray(data?.trend) ? data.trend : []).slice(-7);
  const summaries = ['CNY', 'USD'].map((currency) => {
    const values = trend.map((row) => trendAmount(row, currency)).filter((value) => value != null);
    const delta = values.length > 1 ? values[values.length - 1] - values[0] : null;
    return { currency, label: currency === 'USD' ? '美元额度' : '人民币额度', delta };
  }).filter((row) => totals.some((total) => String(total.currency).toUpperCase() === row.currency));
  const badge = useMemo(() => trendBadge(summaries), [summaries]);
  const meaningful = (Array.isArray(data?.events) ? data.events : []).filter((event) => ['new_limit', 'tighten', 'relax', 'suspend', 'resume'].includes(event.type));
  const latestDay = meaningful.reduce((best, event) => String(event.effectiveAt || '') > best ? String(event.effectiveAt || '') : best, '');
  const latest = latestDay ? meaningful.filter((event) => String(event.effectiveAt || '') === latestDay) : [];
  const groups = [
    { key: 'tighten', label: '额度收紧', tone: 'warning', events: latest.filter((event) => ['tighten', 'suspend'].includes(event.type)) },
    { key: 'relax', label: '额度放宽', tone: 'positive', events: latest.filter((event) => ['new_limit', 'relax', 'resume'].includes(event.type)) },
  ].filter((group) => group.events.length);
  const changeText = (event) => {
    if (event.type === 'suspend') return `${compact(event.previousAmount, event.currency)} → 暂停`;
    if (event.type === 'resume') return `暂停 → ${compact(event.currentAmount, event.currency)}`;
    return `${compact(event.previousAmount, event.currency)} → ${compact(event.currentAmount, event.currency)}`;
  };
  return <>
    <div className="cn-home-limit-total">{totals.length ? totals.map((row) => { const currency = String(row.currency).toUpperCase(); return <button type="button" key={currency} onClick={() => onOpenDetail?.(currency)}><small>{currency === 'USD' ? '美元份额' : '人民币份额'}</small><strong>{compact(row.amount, currency)}</strong><i>查看完整额度详情 ›</i></button>; }) : <div><small>人民币份额</small><strong>—</strong><em>等待本地采集</em></div>}</div>
    {summaries.length ? <div className="cn-home-quota-trend">
      <div className="cn-home-trend-head"><span>场外额度 7 日趋势</span><span className={`cn-home-badge ${badge.tone}`}>{badge.text}</span></div>
      {summaries.map((row) => <div className="cn-home-trend-row" key={row.currency}><span>{row.label}</span><b className={row.delta > 0 ? 'is-relax' : row.delta < 0 ? 'is-tighten' : ''}>{row.delta == null ? '趋势样本不足' : row.delta === 0 ? '持平' : `${row.delta > 0 ? '增加' : '减少'} ${compact(Math.abs(row.delta), row.currency)} ${row.delta > 0 ? '↑' : '↓'}`}</b></div>)}
      <div className="cn-home-trend-source">数据源：基金管理人官方公告</div>
    </div> : null}
    {groups.length ? <div className="cn-home-quota-board" role="region" aria-label="最近限额变动" tabIndex={0}><h3>{latestDay ? `${latestDay.slice(5, 7)}月${latestDay.slice(8, 10)}日 限额变动` : '限额变动'}</h3>{groups.map((group) => <section key={group.key} className={`is-${group.tone}`}><header><span />{group.label}{latestDay ? `（${Number(latestDay.slice(5, 7))}月${Number(latestDay.slice(8, 10))}日起生效）` : ''}</header>{group.events.map((event) => <button key={event.id || `${event.code}-${event.type}`} onClick={() => onFund?.(event.code)}><div><b>{event.name || event.code}</b><small>{event.code}</small></div><strong>{changeText(event)}</strong><ChevronRight /></button>)}</section>)}</div> : null}
    <p className="cn-home-limit-disclaimer">额度是公开渠道的产品申购上限汇总，不代表任何用户账户的实际剩余额度。</p>
  </>;
}

function readLimitCurrency() { if (typeof window === 'undefined') return ''; const params = new URLSearchParams(window.location.search); if (params.get('view') !== 'fund-limits') return ''; const value = String(params.get('currency') || 'CNY').toUpperCase(); return value === 'USD' ? 'USD' : 'CNY'; }
export function CnHomeExperience({ topSlot = null, takeover = false } = {}) {
  const [limitCurrency, setLimitCurrency] = useState(readLimitCurrency);
  const [state, setState] = useState(() => Object.fromEntries(['overview','series','limits'].map((key) => [key, { data: readCache(key), loading: true, error: null }])));
  const [mode, setMode] = useState('premium'); const [group, setGroup] = useState('all');
  // Phase 1: theme + color mode, scoped to the .cn-home root (D3).
  const [theme, setTheme] = useState(readStoredTheme);
  const [colorMode, setColorMode] = useState(readStoredColorMode);
  const [groupAutoApplied, setGroupAutoApplied] = useState(false);
  const refresh = useCallback((force = false) => { ['overview','series','limits'].forEach((section) => { setState((s) => ({ ...s, [section]: { ...s[section], loading: true, error: null } })); loadSection(section, force).then((data) => { writeCache(section, data); setState((s) => ({ ...s, [section]: { data, loading: false, error: null } })); }).catch((error) => setState((s) => ({ ...s, [section]: { ...s[section], loading: false, error } }))); }); }, []);
  useEffect(() => { refresh(false); }, [refresh]);
  useEffect(() => { const sync = () => setLimitCurrency(readLimitCurrency()); window.addEventListener('popstate', sync); return () => window.removeEventListener('popstate', sync); }, []);
  const groups = state.series.data?.groups || state.overview.data?.groups || [{ key: 'all', label: '全部' }];
  // Phase 3 (D4): on narrow screens default to the Nasdaq-100 group once server groups arrive.
  useEffect(() => {
    if (groupAutoApplied || typeof window === 'undefined') return;
    if (window.innerWidth < 640) {
      const nasdaq = (groups || []).find((g) => /nasdaq/i.test(String(g.key || '')) || /纳指/.test(String(g.label || '')));
      if (nasdaq) { setGroup(nasdaq.key); setGroupAutoApplied(true); }
      return;
    }
    setGroupAutoApplied(true);
  }, [groups, groupAutoApplied]);
  function toggleTheme() { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch { /* storage may be unavailable */ } }
  function toggleColorMode() { const next = colorMode === 'us' ? 'cn' : 'us'; setColorMode(next); try { localStorage.setItem(COLOR_MODE_KEY, next); } catch { /* storage may be unavailable */ } }
  const lines = pickSeries(state.series.data, mode, group);
  function openFund(code) { if (!code) return; window.dispatchEvent(new CustomEvent('workspace:navigate', { detail: { tab: 'markets', search: `symbol=${encodeURIComponent(code)}` } })); }
  function openLimitDetail(currency) { const value = String(currency || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY'; const url = new URL(window.location.href); url.searchParams.set('view', 'fund-limits'); url.searchParams.set('currency', value); window.history.pushState({ ...(window.history.state || {}), cnLimitDetail: true }, '', url); setLimitCurrency(value); window.scrollTo({ top: 0, behavior: 'auto' }); }
  function switchLimitCurrency(currency) { const value = currency === 'USD' ? 'USD' : 'CNY'; const url = new URL(window.location.href); url.searchParams.set('view', 'fund-limits'); url.searchParams.set('currency', value); window.history.replaceState({ ...(window.history.state || {}), cnLimitDetail: true }, '', url); setLimitCurrency(value); }
  function closeLimitDetail() { if (window.history.state?.cnLimitDetail) { window.history.back(); return; } const url = new URL(window.location.href); url.searchParams.delete('view'); url.searchParams.delete('currency'); window.history.replaceState(window.history.state, '', url); setLimitCurrency(''); }
  // 新手入门未关闭时，首页只显示任务卡；点叉号（或跳过）后才出现原有首页内容。
  if (takeover && topSlot) return <main className="cn-home cn-home-takeover" data-theme={theme} data-color={colorMode}><div className="mx-auto flex w-full max-w-[880px] flex-col justify-center gap-3 py-2 sm:min-h-[calc(100vh-200px)]">{topSlot}</div></main>;
  if (limitCurrency) return <CnFundLimitDetail data={state.limits.data} currency={limitCurrency} loading={state.limits.loading} error={state.limits.error} onRetry={() => refresh(true)} onBack={closeLimitDetail} onSwitchCurrency={switchLimitCurrency} theme={theme} colorMode={colorMode} />;
  return <main className="cn-home" data-theme={theme} data-color={colorMode}><div className="cn-home-head"><div><h1>市场首页</h1><p>全球指数基金实时概览</p></div><div className="cn-home-head-actions"><button type="button" onClick={toggleColorMode} title={colorMode === 'cn' ? '切换为 US 绿涨红跌' : '切换为 CN 红涨绿跌'} aria-label="切换涨跌配色"><Palette /><span className="btn-label">{colorMode === 'cn' ? 'CN 红涨绿跌' : 'US 绿涨红跌'}</span></button><button type="button" onClick={toggleTheme} title={theme === 'light' ? '切换深色模式' : '切换浅色模式'} aria-label="切换深浅色主题">{theme === 'light' ? <Moon /> : <Sun />}<span className="btn-label">{theme === 'light' ? '深色' : '浅色'}</span></button><button type="button" className="refresh" onClick={() => refresh(true)} disabled={Object.values(state).some((x) => x.loading)}><RefreshCw />刷新</button></div></div>{topSlot}<Section className="cn-home-overview" title="全局市场总览" loading={state.overview.loading} error={state.overview.error} onRetry={() => refresh(true)}><OverviewCards data={state.overview.data} limits={state.limits.data} onOpenDetail={openLimitDetail} /></Section><Section className="cn-home-market" title="场内走势" loading={state.series.loading} error={state.series.error} onRetry={() => refresh(true)} side={<div className="cn-home-market-toolbar"><span className="cn-home-series-meta">{state.series.data?.windowLabel || '今日 · 5 分钟'} · {timeText(state.series.data?.generatedAt)}</span><div className="cn-home-segment" role="group" aria-label="走势指标"><button type="button" aria-pressed={mode === 'premium'} className={mode === 'premium' ? 'active' : ''} onClick={() => setMode('premium')}>溢价</button><button type="button" aria-pressed={mode === 'price'} className={mode === 'price' ? 'active' : ''} onClick={() => setMode('price')}>价格</button></div></div>}><div className="cn-home-chips">{groups.map((item) => <button type="button" key={item.key} aria-pressed={group === item.key} className={group === item.key ? 'active' : ''} onClick={() => setGroup(item.key)}>{item.label}</button>)}</div><PremiumChart series={lines} mode={mode} /></Section><Section className="cn-home-limits" title="场外额度" loading={state.limits.loading} error={state.limits.error} onRetry={() => refresh(true)} side={<span className="cn-home-limit-asof">更新于 {timeText(state.limits.data?.limitAsOf || state.limits.data?.generatedAt)}</span>}><Limits data={state.limits.data} onFund={openFund} onOpenDetail={openLimitDetail} /></Section></main>;
}
