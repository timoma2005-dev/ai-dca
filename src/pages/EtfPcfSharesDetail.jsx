import { useEffect, useState } from 'react';
import { Card, Pill } from '../components/experience-ui.jsx';
import { pcfDetailClient, pcfDetailSections } from '../app/etfPcfDetailClient.js';

export default function EtfPcfSharesDetail({ code, date, id, labelledBy }) {
  const [result, setResult] = useState({ state: 'loading' });
  const [retry, setRetry] = useState(0);
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
  }, [code, date, retry]);
  return (
    <div id={id} role="region" aria-labelledby={labelledBy} className="shares-detail">
      <Card className="p-4">
        <Pill>申赎信息</Pill>
        {result.state === 'loading' && <p role="status">正在读取申赎信息…</p>}
        {result.state === 'empty' && <p role="status">暂无该日期的申赎缓存数据，等待更新</p>}
        {result.state === 'error' && (
          <div role="alert">
            <p>申赎信息读取失败，可点击重试</p>
            <button className="shares-detail-toggle" onClick={() => setRetry((v) => v + 1)}>
              重试读取
            </button>
          </div>
        )}
        {result.state === 'ready' &&
          pcfDetailSections(result.data).map((section, i) => (
            <section key={i}>
              <h4>{section.date} 信息内容</h4>
              <dl>
                {section.rows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
      </Card>
    </div>
  );
}
