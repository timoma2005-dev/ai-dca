import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Cloud,
  Info,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  Wifi,
} from 'lucide-react';
import {
  clearDirectMarketDataCaches,
  fetchDanjuanDirectQuotes,
  fetchDirectKline,
  fetchDirectQuotes,
  fetchEastmoneyFundNavs,
  searchDirectSymbols,
} from '../../app/directMarketData.js';
import {
  LOCAL_DIRECT_SCOPES,
  isLocalDirectMode,
  setLocalDirectMode,
  subscribeLocalDirectMode,
} from '../../app/localDirectMode.js';
import {
  buildDirectRows,
  buildLinePath,
  normalizeDirectSearchResults,
  sortDirectRows,
  summarizeDirectRows,
} from '../../app/localDirectModel.js';
import './local-direct-panel.css';

const REFRESH_INTERVAL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 300;
const KLINE_TIMEFRAMES = [
  { key: '1d', label: '日K' },
  { key: '1w', label: '周K' },
  { key: '1mo', label: '月K' },
];

/** 订阅 localDirectMode 的 React hook，跨组件切换即时响应。 */
export function useLocalDirectMode(scope) {
  const [enabled, setEnabled] = useState(() => isLocalDirectMode(scope));
  useEffect(() => {
    setEnabled(isLocalDirectMode(scope));
    return subscribeLocalDirectMode(({ scope: changed }) => {
      if (!changed || changed === scope) setEnabled(isLocalDirectMode(scope));
    });
  }, [scope]);
  const update = useCallback((next) => setLocalDirectMode(scope, next), [scope]);
  return [enabled, update];
}

/** 云端 / 本地直连 分段切换条，markets tab 顶部与面板内共用。 */
export function LocalDirectModeBar({ scope, enabled, onChange, compact = false }) {
  return (
    <div className={compact ? 'ldp-bar is-compact' : 'ldp-bar'} data-testid="local-direct-mode-bar">
      <div className="ldp-seg" role="group" aria-label="行情数据源">
        <button
          type="button"
          className={!enabled ? 'is-active' : ''}
          aria-pressed={!enabled}
          onClick={() => onChange(false)}
        >
          <Cloud size={15} /> 云端
        </button>
        <button
          type="button"
          className={enabled ? 'is-active' : ''}
          aria-pressed={enabled}
          onClick={() => onChange(true)}
        >
          <PlugZap size={15} /> 本地直连
        </button>
      </div>
      {!compact ? (
        <span className="ldp-bar-note">
          <Wifi size={13} /> 本地直连：浏览器直连行情接口，不经过美股策略助手服务，如接口不可用请切换云端
        </span>
      ) : null}
    </div>
  );
}

/**
 * 行情数据源横条：云端提示「刷新失败可用本地直连」，本地直连提示「数据已精简」，右侧一键切换。
 * 列表头部和基金详情顶部共用。
 */
export function MarketsSourceNotice({ localDirect = false, onSwitch, className = '' }) {
  return (
    <div
      data-testid={localDirect ? 'local-direct-notice' : 'cloud-source-notice'}
      className={['ldp-source-notice', className].filter(Boolean).join(' ')}
    >
      <Info size={13} className="shrink-0" />
      <span className="min-w-0 flex-1">
        {localDirect ? '本地直连已精简部分数据，需要更详细的数据请使用云端' : '若云端数据刷新失败，请使用本地直连'}
      </span>
      {onSwitch ? (
        <button type="button" onClick={onSwitch} className="ldp-source-notice-btn">
          {localDirect ? <Cloud size={12} /> : <PlugZap size={12} />}
          {localDirect ? '切换云端' : '切换直连'}
        </button>
      ) : null}
    </div>
  );
}

function formatTime(value) {
  if (!value) return '—';
  // 腾讯 time 形如 20260703161434
  const digits = String(value).replace(/\D/g, '');
  if (digits.length >= 14) {
    return `${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
  }
  return value;
}

function pctClass(value) {
  if (value == null || Number(value) === 0) return 'is-flat';
  return value > 0 ? 'is-up' : 'is-down';
}

function KlineChart({ candles }) {
  const geometry = useMemo(
    () => buildLinePath(candles || [], { width: 640, height: 220, pad: 10 }),
    [candles]
  );
  if (!geometry.line) {
    return <div className="ldp-chart-empty">K 线数据不足</div>;
  }
  const up = geometry.last.value >= geometry.min;
  const stroke = up ? '#e5484d' : '#0aa870';
  return (
    <svg className="ldp-chart" viewBox="0 0 640 220" preserveAspectRatio="none" role="img" aria-label="收盘价走势">
      <defs>
        <linearGradient id="ldp-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line key={ratio} x1="10" x2="630" y1={10 + 200 * ratio} y2={10 + 200 * ratio} className="ldp-grid" />
      ))}
      <path d={geometry.area} fill="url(#ldp-area)" stroke="none" />
      <path d={geometry.line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={geometry.last.x} cy={geometry.last.y} r="3.5" fill={stroke} />
    </svg>
  );
}

function DirectDetail({ row, onBack, onTimeframe, timeframe, kline, klineLoading, klineError, onRetryKline }) {
  return (
    <section className="ldp-detail" data-testid="local-direct-detail">
      <div className="ldp-detail-head">
        <button type="button" className="ldp-icon-btn" onClick={onBack} aria-label="返回列表">
          <ArrowLeft size={17} />
        </button>
        <div className="ldp-detail-title">
          <strong>{row.name}</strong>
          <span>{row.code}</span>
        </div>
        <div className="ldp-seg">
          {KLINE_TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              type="button"
              className={timeframe === tf.key ? 'is-active' : ''}
              aria-pressed={timeframe === tf.key}
              onClick={() => onTimeframe(tf.key)}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ldp-detail-stats">
        <div><small>最新价</small><strong className="num">{row.price ?? '—'}</strong></div>
        <div><small>涨跌幅</small><strong className={`num ${pctClass(row.changePercent)}`}>{row.changePercent == null ? '—' : `${row.changePercent > 0 ? '+' : ''}${row.changePercent}%`}</strong></div>
        <div><small>今开 / 昨收</small><span className="num">{row.open ?? '—'} / {row.previousClose ?? '—'}</span></div>
        <div><small>最高 / 最低</small><span className="num">{row.high ?? '—'} / {row.low ?? '—'}</span></div>
        {row.premiumPercent != null ? (
          <div>
            <small>{row.navSource === 'eastmoney-zjl' ? '溢价率(东财折价率)' : '溢价率(对净值)'}</small>
            <strong className={`num ${pctClass(row.premiumPercent)}`}>{row.premiumPercent > 0 ? '+' : ''}{row.premiumPercent}%</strong>
          </div>
        ) : null}
        {row.latestNav != null ? (
          <div>
            <small>单位净值</small>
            <span className="num">{row.latestNav} <em>{row.navDate}</em></span>
          </div>
        ) : null}
      </div>

      {klineLoading ? (
        <div className="ldp-state"><Loader2 className="ldp-spin" size={18} /> 正在直连东财读取 K 线…</div>
      ) : klineError ? (
        <div className="ldp-state is-error" role="alert">
          <AlertCircle size={17} /> K 线加载失败：{klineError}
          <button type="button" className="ldp-retry" onClick={onRetryKline}>重试</button>
        </div>
      ) : (
        <KlineChart candles={kline?.candles} />
      )}
      <p className="ldp-source-note">
        K 线来源：{String(kline?.source || '').startsWith('tencent')
          ? '腾讯 web.ifzq.gtimg.cn（浏览器直连）'
          : '东财 push2his.eastmoney.com（JSONP 兜底）'}
        {kline?.fallbackFrom ? ` · 腾讯源失败已切换：${kline.fallbackFrom}` : ''}
      </p>
    </section>
  );
}

/**
 * 本地直连面板：所有数据都由浏览器直接请求行情厂商接口，
 * 复用 src/app/directMarketData.js（腾讯行情 / 东财 K 线 / 蛋卷净值 / smartbox 搜索）。
 */
export function LocalDirectPanel({ scope = LOCAL_DIRECT_SCOPES.MARKETS, universe = [], showPremium = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [selectedCode, setSelectedCode] = useState('');
  const [timeframe, setTimeframe] = useState('1d');
  const [kline, setKline] = useState(null);
  const [klineLoading, setKlineLoading] = useState(false);
  const [klineError, setKlineError] = useState('');
  const [klineReloadTick, setKlineReloadTick] = useState(0);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [extraUniverse, setExtraUniverse] = useState([]);
  const abortRef = useRef(null);
  const seqRef = useRef(0);

  const fullUniverse = useMemo(() => {
    const seen = new Set();
    return [...universe, ...extraUniverse].filter((item) => {
      const code = String(item.code || '');
      if (!code || seen.has(code)) return false;
      seen.add(code);
      return true;
    });
  }, [universe, extraUniverse]);

  const load = useCallback(async ({ force = false } = {}) => {
    const codes = fullUniverse.map((item) => item.code);
    if (!codes.length) return;
    const seq = ++seqRef.current;
    if (force) clearDirectMarketDataCaches();
    setLoading(true);
    setError('');
    abortRef.current?.abort?.();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const tasks = [fetchDirectQuotes(codes, { signal: controller.signal })];
      if (showPremium) {
        // 东财基金接口为主：ZJL 折价率直接给溢价率（盘中可用），NAV 给官方净值，蛋卷兜底缺失代码。
        tasks.push(
          fetchEastmoneyFundNavs(codes, { signal: controller.signal }),
          fetchDanjuanDirectQuotes(codes, { signal: controller.signal })
        );
      }
      const results = await Promise.allSettled(tasks);
      if (controller.signal.aborted || seq !== seqRef.current) return;
      const quoteResult = results[0];
      if (quoteResult.status === 'rejected') throw quoteResult.reason;
      const navs = {};
      if (showPremium) {
        const [, fmResult, danjuanResult] = results;
        if (danjuanResult?.status === 'fulfilled') Object.assign(navs, danjuanResult.value?.quotes || {});
        if (fmResult?.status === 'fulfilled') Object.assign(navs, fmResult.value?.quotes || {});
      }
      const nextRows = buildDirectRows({
        universe: fullUniverse,
        quotes: quoteResult.value?.quotes || {},
        navs,
      });
      setRows(sortDirectRows(nextRows, { byPremium: showPremium }));
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch (err) {
      if (controller.signal.aborted || seq !== seqRef.current) return;
      setError(err?.name === 'AbortError' ? '请求已取消' : `直连行情失败：${err?.message || err}`);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [fullUniverse, showPremium]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(), REFRESH_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      abortRef.current?.abort?.();
    };
  }, [load]);

  // 搜索（防抖，直连腾讯 smartbox）
  useEffect(() => {
    const q = query.trim();
    if (!q) { setSearchResults([]); setSearchLoading(false); return undefined; }
    setSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchDirectSymbols('cn', q, { limit: 8 });
        setSearchResults(normalizeDirectSearchResults(result.results));
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // 详情 K 线（东财 push2his 走 JSONP；klineReloadTick 驱动手动重试）
  useEffect(() => {
    if (!selectedCode) { setKline(null); setKlineError(''); return undefined; }
    let cancelled = false;
    setKlineLoading(true);
    setKlineError('');
    fetchDirectKline(selectedCode, { timeframe })
      .then((payload) => { if (!cancelled) setKline(payload); })
      .catch((err) => {
        if (cancelled) return;
        setKline(null);
        setKlineError(err?.name === 'AbortError' ? '请求已取消' : (err?.message || '直连失败'));
      })
      .finally(() => { if (!cancelled) setKlineLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCode, timeframe, klineReloadTick]);

  const summary = useMemo(() => summarizeDirectRows(rows), [rows]);
  const selectedRow = rows.find((row) => row.code === selectedCode) || null;

  function addSymbol(item) {
    setExtraUniverse((prev) => (prev.some((x) => x.code === item.code) ? prev : [item, ...prev]));
    setQuery('');
    setSearchResults([]);
    setSelectedCode(item.code);
  }

  if (selectedRow) {
    return (
      <div className="ldp-panel" data-testid="local-direct-panel" data-scope={scope}>
        <DirectDetail
          row={selectedRow}
          timeframe={timeframe}
          kline={kline}
          klineLoading={klineLoading}
          klineError={klineError}
          onRetryKline={() => setKlineReloadTick((tick) => tick + 1)}
          onBack={() => setSelectedCode('')}
          onTimeframe={setTimeframe}
        />
      </div>
    );
  }

  return (
    <div className="ldp-panel" data-testid="local-direct-panel" data-scope={scope}>
      <header className="ldp-head">
        <div className="ldp-head-main">
          <h2>{showPremium ? '本地直连 · 溢价看板' : '本地直连行情'}</h2>
          <span className="ldp-source-tag" title="数据不经后端/Worker，浏览器直接请求厂商接口">
            <PlugZap size={13} /> 腾讯行情 · 东财K线{showPremium ? ' · 东财净值' : ''}
          </span>
        </div>
        <div className="ldp-head-actions">
          <span className="ldp-updated">{updatedAt ? `更新 ${updatedAt}` : ''}</span>
          <button
            type="button"
            className="ldp-refresh"
            onClick={() => load({ force: true })}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'ldp-spin' : ''} /> 强刷
          </button>
        </div>
      </header>

      <div className="ldp-summary">
        <span>标的 <b className="num">{summary.total}</b></span>
        <span>在线 <b className="num">{summary.available}</b></span>
        <span className="is-up">涨 <b className="num">{summary.up}</b></span>
        <span className="is-down">跌 <b className="num">{summary.down}</b></span>
        <span>平 <b className="num">{summary.flat}</b></span>
        {showPremium ? <span>含溢价 <b className="num">{summary.premiumAvailable}</b></span> : null}
      </div>

      <div className="ldp-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入代码 / 名称直连搜索（如 513100、纳指）"
          aria-label="直连搜索标的"
        />
        {searchLoading ? <Loader2 size={15} className="ldp-spin" /> : null}
        {searchResults.length ? (
          <div className="ldp-search-drop">
            {searchResults.map((item) => (
              <button key={item.code} type="button" onClick={() => addSymbol(item)}>
                <b>{item.code}</b><span>{item.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="ldp-state is-error" role="alert">
          <AlertCircle size={17} /> {error}
          <button type="button" className="ldp-retry" onClick={() => load({ force: true })}>重试</button>
        </div>
      ) : null}

      {loading && !rows.length ? (
        <div className="ldp-state"><Loader2 className="ldp-spin" size={18} /> 正在直连行情厂商接口…</div>
      ) : (
        <div className="ldp-table-wrap">
          <table className="ldp-table">
            <thead>
              <tr>
                <th>标的</th>
                <th className="num">最新价</th>
                <th className="num">涨跌幅</th>
                {showPremium ? <th className="num">溢价率</th> : null}
                <th className="num">最高/最低</th>
                <th>行情时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.code}
                  onClick={() => setSelectedCode(row.code)}
                  className={row.available ? '' : 'is-missing'}
                  data-testid={`ldp-row-${row.code}`}
                >
                  <td data-label="标的">
                    <b>{row.name}</b>
                    <small>{row.code}</small>
                  </td>
                  <td data-label="最新价" className="num">{row.price ?? '—'}</td>
                  <td data-label="涨跌幅" className={`num ${pctClass(row.changePercent)}`}>
                    {row.changePercent == null ? '—' : `${row.changePercent > 0 ? '+' : ''}${row.changePercent}%`}
                  </td>
                  {showPremium ? (
                    <td data-label="溢价率" className={`num ${pctClass(row.premiumPercent)}`}>
                      {row.premiumPercent == null ? '—' : `${row.premiumPercent > 0 ? '+' : ''}${row.premiumPercent}%`}
                    </td>
                  ) : null}
                  <td data-label="最高/最低" className="num ldp-hl">{row.high ?? '—'} / {row.low ?? '—'}</td>
                  <td data-label="行情时间">{formatTime(row.quoteTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ldp-source-note">
        链路：浏览器 → qt.gtimg.cn（行情）/ web.ifzq.gtimg.cn（K线，东财 push2his JSONP 兜底）{showPremium ? ' / fundmobapi.eastmoney.com（基金净值与折价率 ZJL，蛋卷兜底）' : ''}，与竞价看板 adminAuction 同为厂商直连；失败时不影响云端数据源。
      </p>
    </div>
  );
}
