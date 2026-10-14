import { useEffect, useState } from 'react';
import { Card, Pill, SectionHeading } from '../components/experience-ui.jsx';
import {
  sharesClient,
  shanghaiAccessDay,
  limitLabel,
  creationLabel,
  snapshotLabel,
  sharesPeriodDates,
  freshnessMessage,
  SHARES_DESCRIPTION
} from '../app/etfPcfSharesClient.js';
import './etfPcfShares.css';
import EtfPcfSharesDetail from './EtfPcfSharesDetail.jsx';
const format = (n) => (n === null ? '—' : n.toLocaleString('zh-CN'));
const formatWan = (n) => (n === null ? '—' : (n / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
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
export default function EtfPcfSharesPanel() {
  const [result, setResult] = useState({ state: 'loading' });
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [day, setDay] = useState(() => shanghaiAccessDay());
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
  const period = sharesPeriodDates(data);
  const freshness = data ? freshnessMessage(data) : '';
  const heads = [
    '代码 / 名称',
    `本期份额${period.currentDate ? `（${period.basis} ${period.currentDate.slice(5)}）` : ''}`,
    `上期份额${period.previousDate ? `（${period.basis} ${period.previousDate.slice(5)}）` : ''}`,
    '新增份额（万份）',
    '统计日申购（万份，推算）',
    '新增金额（万元，估算）',
    '是否顶格'
  ];
  return (
    <div className="shares-panel space-y-4">
      <SectionHeading title="份额新增 · 13 只 ETF" description={SHARES_DESCRIPTION} />
      <Card className="p-4 space-y-3">
        {data && (
          <div className="text-sm text-slate-600">
            <p>{snapshotLabel(data)}</p>
            <p>
              本期统计：{data.date} · 上期统计：{data.prevDate || '—'} · 获取日期：{data.availableOn}
            </p>
            <p>源抓取时间：{fetchedTime(data.fetchedAt)}（上海时间）</p>
          </div>
        )}
        {freshness && <p className="text-xs text-amber-700">{freshness}</p>}
        {result.state === 'stale' && (
          <p role="status" className="text-sm text-amber-700">
            {['revalidating', 'ttl_expired'].includes(result.reason)
              ? '本地缓存待重新确认'
              : '读取失败，展示上次快照'}
          </p>
        )}
        {result.state === 'loading' && (
          <div role="status">
            <p>正在读取份额快照…</p>
            {[1, 2, 3].map((i) => (
              <div key={i} className="my-3 h-12 rounded bg-slate-100 animate-pulse" />
            ))}
          </div>
        )}
        {result.state === 'empty' && (
          <p role="status">
            {result.reason === 'missing_report_date'
              ? '报表缺少数据日期，暂无法计算份额新增'
              : '暂无已验证份额快照，等待定时任务更新'}
          </p>
        )}
        {result.state === 'error' && <p role="alert">份额快照读取失败，请稍后重试</p>}
        {['error', 'stale'].includes(result.state) && (
          <button
            className="rounded-xl bg-slate-100 px-4 py-2 text-sm"
            onClick={() => setRetry((v) => v + 1)}
          >
            重试读取
          </button>
        )}
        {data && (
          <>
            <div className="shares-grid shares-header">
              {heads.map((h) => (
                <strong key={h}>{h}</strong>
              ))}
            </div>
            {data.records.map((r) => (
              <article key={r.code} className="shares-grid shares-row">
                <div>
                  <button
                    id={`shares-toggle-${r.code}`}
                    className="shares-detail-toggle"
                    aria-expanded={expanded === `${data.date}:${r.code}`}
                    aria-controls={`shares-detail-${r.code}`}
                    onClick={() =>
                      setExpanded((old) =>
                        old === `${data.date}:${r.code}` ? null : `${data.date}:${r.code}`
                      )
                    }
                  >
                    <b>{r.code}</b> · {r.name}
                    <span className="block">
                      申赎信息 {expanded === `${data.date}:${r.code}` ? '收起 ▴' : '展开 ▾'}
                    </span>
                  </button>
                  {r.status === 'partial' && <Pill>部分数据</Pill>}
                </div>
                {[
                  format(r.shares),
                  format(r.prevShares),
                  formatWan(r.deltaShares),
                  creationLabel(r),
                  '—',
                  limitLabel(r)
                ].map((value, i) => (
                  <div key={i} className="shares-number">
                    <span className="shares-mobile-label">{heads[i + 1]}</span>
                    <span>{value}</span>
                    {i === 1 && !data.prevDate && r.prevDate && <small>{r.prevDate}</small>}
                  </div>
                ))}
                {r.shares === null && <p className="shares-reason">缺少本期份额</p>}
                {r.deltaShares === null && (
                  <p className="shares-reason">缺少可确认的上一交易日份额，暂无法计算新增</p>
                )}
                {expanded === `${data.date}:${r.code}` ? (
                  <EtfPcfSharesDetail
                    key={`${data.date}:${r.code}`}
                    code={r.code}
                    date={data.date}
                    id={`shares-detail-${r.code}`}
                    labelledBy={`shares-toggle-${r.code}`}
                  />
                ) : (
                  <div id={`shares-detail-${r.code}`} hidden />
                )}
              </article>
            ))}
          </>
        )}
        <p className="text-xs text-slate-500">新增金额暂缺 D 日净值日期证据，不拿实时行情/IOPV 凑数。</p>
        <p className="text-xs text-slate-500">
          申购推算对应份额统计日。申赎同时开放时仅按净增估算，实际申购与赎回可能互相抵消。
        </p>
        <p className="text-xs text-slate-500">
          顶格指净增精确等于数据日累计申购限额；90% 为接近。净差分可能抵消赎回，不能证明实际总申购顶格。
        </p>
      </Card>
    </div>
  );
}
