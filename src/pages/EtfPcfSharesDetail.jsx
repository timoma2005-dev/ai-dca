import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { pcfDetailClient, pcfDetailSections } from '../app/etfPcfDetailClient.js';

export default function EtfPcfSharesDetail({ code, name, date, id, labelledBy }) {
  const [result, setResult] = useState({ state: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!code.startsWith('159')) return;
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
  }, [code, date, retry]);
  if (!code.startsWith('159'))
    return (
      <div
        id={id}
        role="region"
        aria-labelledby={labelledBy}
        className="detail-drawer-content shares-sse-detail"
      >
        <p>该标的为上交所 (SSE) 跨市场 ETF</p>
        <p>当前报表源暂未接入上交所 PCF 现金替代与实时限额清单，待后续通道升级。</p>
      </div>
    );
  const sections = result.data ? pcfDetailSections(result.data) : [];
  const t = sections[1],
    p = sections[0];
  const find = (section, label) => section.rows.find(([key]) => key === label)?.[1] || '—';
  const rows = t
    ? [
        ['申购允许状态', find(t, '申购的允许情况')],
        ['赎回允许状态', find(t, '赎回的允许情况')],
        ['当日累计申购上限', find(t, '当日累计申购上限')],
        ['当日累计赎回上限', find(t, '当日累计赎回上限')],
        ['当日净申购 / 净赎回上限', `${find(t, '当日净申购上限')} / ${find(t, '当日净赎回上限')}`],
        ['最小申赎单位 (Unit)', find(t, '最小申购、赎回单位')],
        ['现金替代比例上限', find(t, '现金替代比例上限')],
        ['预估现金部分', find(t, '预估现金部分（元）')],
        ['是否公布 IOPV', find(t, '是否需要公布IOPV')]
      ]
    : [];
  const renderRows = (values) => (
    <dl className="pcf-kv-list">
      {values.map(([label, value], i) => (
        <div className="pcf-kv-row" key={label}>
          <dt className="pcf-kv-label">{label}</dt>
          <dd
            className={`pcf-kv-val ${i < 2 && value === '允许' ? 'highlight-green' : i < 2 && value === '不允许' ? 'highlight-amber' : ''}`}
          >
            {i < 2 && value === '允许'
              ? `✓ 允许${i === 0 ? '申购' : '赎回'}`
              : i < 2 && value === '不允许'
                ? `✕ 暂停${i === 0 ? '申购' : '赎回'}`
                : value}
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <div id={id} role="region" aria-labelledby={labelledBy} className="detail-drawer-content">
      <div className="detail-drawer-header">
        <div className="detail-drawer-title">
          <FileText size={16} />
          <span>
            {name} ({code}) · 申购赎回清单 (PCF) 深度核验
          </span>
        </div>
        <span className="detail-source-badge">数据源：深交所官方 szse_pcf 权威验证</span>
      </div>
      {result.state === 'loading' && <p role="status">正在读取申赎信息…</p>}
      {result.state === 'empty' && <p role="status">暂无该日期的申赎缓存数据，等待更新</p>}
      {result.state === 'error' && (
        <div role="alert">
          <p>申赎信息读取失败，可点击重试</p>
          <button className="action-btn-primary" onClick={() => setRetry((v) => v + 1)}>
            重试读取
          </button>
        </div>
      )}
      {result.state === 'ready' && (
        <div className="pcf-sections-grid">
          <section className="pcf-section-card t-day">
            <div className="pcf-section-title">
              <span>T 日即时申赎规则与上限控制</span>
              <span className="pcf-date-pill">数据日：{t.date}</span>
            </div>
            {renderRows(rows)}
          </section>
          <section className="pcf-section-card p-day">
            <div className="pcf-section-title">
              <span>P 日前一交易日清算基准</span>
              <span className="pcf-date-pill">基准日：{p.date}</span>
            </div>
            {renderRows([
              ['基金份额净值 (NAV)', find(p, '基金份额净值（元）')],
              ['最小申赎单位净值', find(p, '最小申购、赎回单位净值（元）')],
              ['最小单位现金差额', find(p, '最小申购、赎回单位的现金差额（元）')]
            ])}
            <div className="shares-formula">
              <strong>新增金额估算公式：</strong>
              <div>
                <code>金额(万元) = 净增份额 × D日每份净值 ÷ 10,000</code>
              </div>
              <p>* 严格要求同日净值审计证据，禁止混入实时市价或 IOPV。</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
