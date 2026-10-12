import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RefreshCw, Search } from 'lucide-react';
import './cn-fund-limit-detail.css';

const CATEGORIES = [
  { key: 'NASDAQ100', label: '纳斯达克100', match: /纳斯达克\s*100|纳指\s*100/ },
  { key: 'SP500', label: '标普500', match: /标普\s*500|标准普尔\s*500/ },
];
const STATUS_FILTERS = [
  { key: 'ALL', label: '全部状态' },
  { key: 'OPEN', label: '可申购' },
  { key: 'SUSPENDED', label: '暂停申购' },
];

function numeric(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function money(value, currency) {
  const n = numeric(value); if (n == null) return '—';
  const sign = currency === 'USD' ? '$' : '¥';
  if (Math.abs(n) >= 100000000) return `${sign}${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${sign}${(n / 10000).toFixed(1)}万`;
  return `${sign}${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}
// Capsule tags: 可申购 / 暂停申购 / App购买 (ported from the reference home.html badge logic).
function channelBadge(appLabel, isSuspended) {
  if (isSuspended) return { text: '暂停申购', type: 'suspended' };
  const s = String(appLabel || '').trim();
  if (/App/i.test(s)) return { text: 'App购买', type: 'app' };
  if (/直销/.test(s)) return { text: '直销渠道', type: 'app' };
  if (/代销/.test(s)) return { text: '代销渠道', type: 'open' };
  return { text: '可申购', type: 'open' };
}
function normalizedRecords(data) {
  const source = Array.isArray(data?.records) ? data.records : Array.isArray(data?.items) ? data.items : [];
  return source.map((row, index) => {
    const currency = String(row.currency || 'CNY').toUpperCase();
    const amount = numeric(row.amount ?? row.limitAmount ?? row.maxPurchasePerDay ?? row.currentAmount);
    const status = String(row.status || row.purchaseStatus || row.buyStatus || '').toLowerCase();
    const isSuspended = Boolean(row.isSuspended) || /suspend|暂停/.test(status);
    return { ...row, key: row.key || `${currency}-${row.code || index}`, currency, amount, isSuspended, name: row.name || row.fundName || row.code || '未知基金', code: row.code || row.symbol || '', amountText: row.amountText || (isSuspended ? '暂停申购' : money(amount, currency)), appLabel: row.appLabel || row.channel || row.platform || '' };
  });
}

export function CnFundLimitDetail({ data, currency = 'CNY', loading, error, onRetry, onBack, onSwitchCurrency, theme = 'light', colorMode = 'cn' }) {
  const [category, setCategory] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [query, setQuery] = useState('');
  useEffect(() => { setCategory('ALL'); setStatus('ALL'); setQuery(''); }, [currency]);
  const model = useMemo(() => {
    const all = normalizedRecords(data);
    const totals = Array.isArray(data?.currencyTotals) ? data.currencyTotals : [];
    const available = Array.from(new Set([...totals.map((row) => String(row.currency || '').toUpperCase()), ...all.map((row) => row.currency)].filter(Boolean)));
    const currencyRecords = all.filter((row) => row.currency === currency);
    const categories = [{ key: 'ALL', label: '全部' }, ...CATEGORIES.filter((meta) => currencyRecords.some((row) => meta.match.test(String(row.name))))];
    const selected = categories.some((item) => item.key === category) ? category : 'ALL';
    const q = query.trim().toLowerCase();
    const filtered = currencyRecords
      .filter((row) => selected === 'ALL' || CATEGORIES.find((item) => item.key === selected)?.match.test(String(row.name)))
      .filter((row) => status === 'ALL' || (status === 'SUSPENDED' ? row.isSuspended : !row.isSuspended))
      .filter((row) => !q || String(row.name).toLowerCase().includes(q) || String(row.code).toLowerCase().includes(q));
    filtered.sort((a, b) => Number(a.isSuspended) - Number(b.isSuspended) || (b.amount || 0) - (a.amount || 0) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
    const total = totals.find((row) => String(row.currency).toUpperCase() === currency);
    return { available, categories, selected, records: filtered, allCount: currencyRecords.length, openCount: currencyRecords.filter((row) => !row.isSuspended).length, total: total?.amount };
  }, [data, currency, category, status, query]);

  return <main className="cn-limit-detail" data-theme={theme} data-color={colorMode}>
    <header className="cn-limit-detail-head"><button type="button" onClick={onBack} aria-label="返回市场首页"><ArrowLeft /></button><div><h1>场外额度详情</h1><p>基金申购限额列表</p></div><button type="button" className="refresh" aria-label="刷新额度" title="刷新额度" onClick={onRetry} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} /></button></header>
    {model.available.includes('CNY') && model.available.includes('USD') ? <div className="cn-limit-segment" role="group" aria-label="份额币种"><button type="button" aria-pressed={currency === 'CNY'} className={currency === 'CNY' ? 'active' : ''} onClick={() => onSwitchCurrency('CNY')}>人民币</button><button type="button" aria-pressed={currency === 'USD'} className={currency === 'USD' ? 'active' : ''} onClick={() => onSwitchCurrency('USD')}>美元</button></div> : null}
    {loading && !model.records.length ? <div className="cn-limit-state">加载中…</div> : error && !model.records.length ? <div className="cn-limit-state"><span>额度明细暂不可用，请稍后再试</span><button onClick={onRetry}>重试</button></div> : <>
      <section className="cn-limit-summary"><strong>{money(model.total, currency)}</strong><span>{model.allCount ? `${model.allCount} 只 · 可申购 ${model.openCount} 只` : '暂无额度数据'}</span><small>更新于 {data?.generatedAt ? new Date(data.generatedAt).toLocaleString('zh-CN') : '—'}</small></section>
      <div className="cn-limit-toolbar">
        <label className="cn-limit-search"><Search /><input type="search" placeholder="输入基金代码 (如 000834) 或名称搜索…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索基金代码或名称" /></label>
        <div className="cn-limit-segment cn-limit-status" role="group" aria-label="申购状态">{STATUS_FILTERS.map((item) => <button type="button" key={item.key} aria-pressed={status === item.key} className={status === item.key ? 'active' : ''} onClick={() => setStatus(item.key)}>{item.label}</button>)}</div>
      </div>
      {model.categories.length > 1 ? <div className="cn-limit-filters">{model.categories.map((item) => <button type="button" key={item.key} aria-pressed={model.selected === item.key} className={model.selected === item.key ? 'active' : ''} onClick={() => setCategory(item.key)}>{item.label}</button>)}</div> : null}
      {model.records.length ? <section className="cn-limit-rows" aria-label="场外基金申购额度列表">{model.records.map((row) => {
        const badge = channelBadge(row.appLabel, row.isSuspended);
        return <article key={row.key} className={`cn-limit-row${row.isSuspended ? ' is-suspended' : ''}`}>
          <div className="cn-limit-row-info">
            <b title={row.name}>{row.name}</b>
            <small><span>{row.code}</span><span aria-hidden="true">·</span><span>{row.currency === 'USD' ? '美元份额' : '人民币份额'}</span></small>
          </div>
          <div className="cn-limit-row-side">
            <strong className={row.isSuspended ? 'suspended' : ''}>{row.amountText}</strong>
            <em className={`cn-limit-capsule badge-${badge.type}`}>{badge.text}</em>
          </div>
        </article>;
      })}</section> : <div className="cn-limit-state"><b>{query.trim() || status !== 'ALL' ? '未找到符合条件的场外基金' : '暂无额度数据'}</b><span>每日自动更新，稍后再来看看。</span></div>}
      <p className="cn-limit-disclaimer">额度依据基金公司公开公告整理，仅供参考，实际以各销售渠道为准。</p>
    </>}
  </main>;
}
