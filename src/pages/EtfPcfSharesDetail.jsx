import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { pcfDetailClient, pcfDetailSections } from '../app/etfPcfDetailClient.js';

const find = (section, label) => section?.rows.find(([key]) => key === label)?.[1] || '—';

const statusChip = (value, kind) =>
  value === '允许'
    ? { className: 'ok', text: `✓ 允许${kind}` }
    : value === '不允许'
      ? { className: 'blocked', text: `✕ 暂停${kind}` }
      : { className: 'unknown', text: `${kind}状态：${value}` };

const kvRows = (rows) => (
  <dl className="pcf-kv-list">
    {rows.map(([label, value, extra]) => (
      <div className={`pcf-kv-row ${extra || ''}`} key={label}>
        <dt className="pcf-kv-label">{label}</dt>
        <dd className="pcf-kv-val">{value}</dd>
      </div>
    ))}
  </dl>
);

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
  // 桌面表格中详情自身即展开区域；移动卡片由外层抽屉承担 region 语义。
  const regionProps = id ? { id, role: 'region', 'aria-labelledby': labelledBy } : {};
  if (!code.startsWith('159'))
    return (
      <div {...regionProps} className="detail-drawer-content shares-sse-detail">
        <p>该标的为上交所 (SSE) 跨市场 ETF</p>
        <p>沪市 PCF 清单暂未接入，待通道升级后开放。</p>
      </div>
    );
  const sections = result.data ? pcfDetailSections(result.data) : [];
  const t = sections[1];
  const p = sections[0];
  const subscribe = statusChip(find(t, '申购的允许情况'), '申购');
  const redeem = statusChip(find(t, '赎回的允许情况'), '赎回');
  const tRows = t
    ? [
        ['当日累计申购上限', find(t, '当日累计申购上限'), 'emphasis'],
        ['当日累计赎回上限', find(t, '当日累计赎回上限')],
        ['当日净申购上限', find(t, '当日净申购上限')],
        ['当日净赎回上限', find(t, '当日净赎回上限')],
        ['最小申赎单位 (Unit)', find(t, '最小申购、赎回单位')],
        ['现金替代比例上限', find(t, '现金替代比例上限')],
        ['预估现金部分', find(t, '预估现金部分（元）')],
        ['是否公布 IOPV', find(t, '是否需要公布IOPV')]
      ]
    : [];
  return (
    <div {...regionProps} className="detail-drawer-content">
      <div className="detail-drawer-header">
        <div className="detail-drawer-title">
          <FileText size={16} aria-hidden="true" />
          <span>
            {name} ({code}) · PCF 申赎清单
          </span>
        </div>
        <span className="detail-source-badge">数据源：深交所官方 PCF</span>
      </div>
      {result.state === 'loading' && <p role="status">正在读取申赎信息…</p>}
      {result.state === 'empty' && <p role="status">暂无该日期的申赎缓存数据，等待更新</p>}
      {result.state === 'error' && (
        <div role="alert" className="detail-error-box">
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
            <div className="pcf-status-row">
              <span className={`pcf-status-chip ${subscribe.className}`}>{subscribe.text}</span>
              <span className={`pcf-status-chip ${redeem.className}`}>{redeem.text}</span>
            </div>
            {kvRows(tRows)}
          </section>
          <section className="pcf-section-card p-day">
            <div className="pcf-section-title">
              <span>P 日前一交易日清算基准</span>
              <span className="pcf-date-pill">基准日：{p.date}</span>
            </div>
            {kvRows([
              ['基金份额净值 (NAV)', find(p, '基金份额净值（元）')],
              ['最小申赎单位净值', find(p, '最小申购、赎回单位净值（元）')],
              ['最小单位现金差额', find(p, '最小申购、赎回单位的现金差额（元）')]
            ])}
          </section>
        </div>
      )}
    </div>
  );
}
