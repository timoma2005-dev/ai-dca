import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearDirectMarketDataCaches,
  fetchDirectKline,
  fetchDirectQuotes,
  fetchEastmoneyFundNavs,
  fetchDirectFundProfiles,
  searchDirectSymbols,
} from '../../app/directMarketData.js';
import {
  buildLocalDirectDetailData,
  buildLocalDirectMarketRows,
  localDirectKlineTimeframe,
  normalizeDirectSearchResults,
} from '../../app/localDirectModel.js';
import { FullTableLoadingFallback } from '../../pages/markets/FullTableLoadingFallback.jsx';
import { MarketsMainContent } from '../../pages/markets/MarketsMainContent.jsx';
import { chartKlineCacheKeyForRange } from '../../pages/markets/marketFundMetrics.js';
import { resolveMetricDisplay } from '../../pages/markets/mobileFundMetrics.js';
import { MarketsSourceNotice } from './LocalDirectPanel.jsx';
import { cx } from '../experience-ui.jsx';

const MarketsFullTablePanel = lazy(() => import('../../pages/markets/MarketsFullTablePanel.jsx').then((module) => ({ default: module.MarketsFullTablePanel })));

const REFRESH_INTERVAL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 300;
const EMPTY_OBJECT = Object.freeze({});
const EMPTY_LIST = Object.freeze([]);

// 桌面表格里可能整列无数据的列：本地直连拿不到的直接不渲染。
const OPTIONAL_COLUMN_FIELDS = {
  highDrawdown: 'metric',
  closeHighDrawdown: 'metric',
  historicalPercentile: 'metric',
  turnover: 'metric',
  limit: 'metric',
  premium: 'metric',
  currentYearPercent: 'metric',
  return1w: 'metric',
  return1m: 'metric',
  return3m: 'metric',
  return6m: 'metric',
  return1y: 'metric',
  returnBase: ['returnBase'],
  totalShares: ['totalShares'],
  feeRate: ['feeRate', 'annualFeeRate'],
  redeemFeeRate: ['redeemFeeRate'],
};

function columnHasData(id, row) {
  const spec = OPTIONAL_COLUMN_FIELDS[id];
  if (spec === 'metric') {
    const text = resolveMetricDisplay(id, row).text;
    return /\d/.test(String(text || ''));
  }
  return spec.some((field) => row?.[field] != null && row[field] !== '' && Number.isFinite(Number(row[field])));
}

export function computeLocalDirectOmittedColumns(rows = []) {
  return Object.keys(OPTIONAL_COLUMN_FIELDS).filter((id) => !rows.some((row) => columnHasData(id, row)));
}

// 云端详情的代码可能带交易所前缀，匹配到自选里同一只基金的写法。
function normalizeEntrySymbol(symbol, symbols = []) {
  const raw = String(symbol || '').trim().toUpperCase();
  const code = (raw.match(/\d{6}/) || [])[0];
  if (!code) return raw;
  const listed = (symbols || []).map((item) => String(item || '').trim().toUpperCase()).find((item) => (item.match(/\d{6}/) || [])[0] === code);
  return listed || code;
}

function directFeedHealth({ error, updatedAt, rows }) {
  if (error) return { status: 'delayed', label: '直连行情接口异常', title: error };
  if (updatedAt || rows.length) return { status: 'live', label: '本地直连 · 浏览器直连行情接口', title: '数据由浏览器直接请求腾讯 / 东财，不经过服务端' };
  return { status: 'waiting', label: '正在直连行情接口', title: '' };
}

/**
 * 本地直连版行情中心：列表、详情沿用云端同一套组件（MarketsFullTablePanel /
 * MobileFundList / SymbolDetailPanel），只把数据源换成浏览器直连的腾讯行情、
 * 东财净值与腾讯/东财 K 线。云端独有的列（近 N 月收益、费率、限额等）缺失时
 * 由云端组件自行显示「—」；详情页隐藏依赖服务端的对比、回测、溢价历史等工具。
 */
export function LocalDirectMarketsView({
  isMobile = false,
  watchLists = EMPTY_LIST,
  activeWatchListId = '',
  symbols = EMPTY_LIST,
  isOtcList = false,
  heldCodes = null,
  onSelectWatchlist,
  onCreateWatchlist,
  onRenameWatchlist,
  onDeleteWatchlist,
  onAddSymbol,
  onRemoveSymbol,
  onMarketAction,
  onSwitchCloud,
  // 从云端详情切过来时直接打开同一只基金。
  initialSelectedSymbol = '',
  header = null,
}) {
  const [quotes, setQuotes] = useState({});
  const [navs, setNavs] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [extraSymbols, setExtraSymbols] = useState(() => (initialSelectedSymbol ? [normalizeEntrySymbol(initialSelectedSymbol, symbols)] : []));
  const [selectedSymbol, setSelectedSymbol] = useState(() => (initialSelectedSymbol ? normalizeEntrySymbol(initialSelectedSymbol, symbols) : ''));
  const [chartRange, setChartRange] = useState('6mo');
  const [chartCustomRange, setChartCustomRange] = useState(null);
  const [detailTab, setDetailTab] = useState('overview');
  const [candlesByTf, setCandlesByTf] = useState({});
  const [chartLoading, setChartLoading] = useState(false);
  const [chartReloadTick, setChartReloadTick] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [names, setNames] = useState({});
  const [profiles, setProfiles] = useState({});
  const abortRef = useRef(null);
  const seqRef = useRef(0);

  const allSymbols = useMemo(() => {
    const seen = new Set();
    return [...symbols, ...extraSymbols].filter((item) => {
      const code = String(item || '').trim().toUpperCase();
      if (!code || seen.has(code)) return false;
      seen.add(code);
      return true;
    });
  }, [symbols, extraSymbols]);

  const load = useCallback(async ({ force = false } = {}) => {
    const codes = allSymbols;
    if (!codes.length) { setQuotes({}); setNavs({}); return; }
    const seq = ++seqRef.current;
    if (force) clearDirectMarketDataCaches();
    setLoading(true);
    setError('');
    abortRef.current?.abort?.();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // 蛋卷 djapi 不返回 CORS 头，浏览器直连必然被拦截，净值/名称统一走东财 FundMNFInfo（JSONP）。
      const [quoteResult, fmResult] = await Promise.allSettled([
        isOtcList ? Promise.resolve(null) : fetchDirectQuotes(codes, { signal: controller.signal }),
        fetchEastmoneyFundNavs(codes, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || seq !== seqRef.current) return;
      if (quoteResult.status === 'rejected' && fmResult.status === 'rejected') throw quoteResult.reason;
      const nextNavs = {};
      if (fmResult.status === 'fulfilled') Object.assign(nextNavs, fmResult.value?.quotes || {});
      setQuotes(quoteResult.status === 'fulfilled' ? (quoteResult.value?.quotes || {}) : {});
      setNavs(nextNavs);
      setUpdatedAt(new Date().toISOString());
      if (quoteResult.status === 'rejected') setError(`直连行情失败：${quoteResult.reason?.message || quoteResult.reason}`);
    } catch (err) {
      if (controller.signal.aborted || seq !== seqRef.current) return;
      setError(err?.name === 'AbortError' ? '请求已取消' : `直连行情失败：${err?.message || err}`);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [allSymbols, isOtcList]);

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

  // 直连搜索（腾讯 smartbox），结果形状对齐云端 MarketSymbolSearchBox。
  useEffect(() => {
    const q = searchValue.trim();
    if (!q) { setSearchResults([]); setSearchLoading(false); setSearchError(''); return undefined; }
    setSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchDirectSymbols('cn', q, { limit: 8 });
        const items = normalizeDirectSearchResults(result?.results).map((item) => ({ ...item, symbol: item.code, market: 'cn' }));
        setSearchResults(items);
        setSearchError(items.length ? '' : '没有找到匹配的标的');
        setNames((prev) => ({ ...prev, ...Object.fromEntries(items.map((item) => [item.code, item.name])) }));
      } catch (err) {
        setSearchResults([]);
        setSearchError(`直连搜索失败：${err?.message || err}`);
      } finally {
        setSearchLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchValue]);

  const baseRows = useMemo(
    () => buildLocalDirectMarketRows(allSymbols, { quotes, navs, isOtcList, heldCodes, names }),
    [allSymbols, quotes, navs, isOtcList, heldCodes, names]
  );
  // 区间收益 / 年费率 / 场内总份额：东财 CORS 接口逐只拉，12 小时缓存；场内外判定要等行情回来。
  const profileRequestKey = useMemo(
    () => baseRows.filter((row) => row.price != null).map((row) => `${row.code}:${row.fundKind === 'otc' ? 'o' : 'x'}`).join(','),
    [baseRows]
  );
  useEffect(() => {
    if (!profileRequestKey) return undefined;
    const controller = new AbortController();
    const items = profileRequestKey.split(',').map((part) => {
      const [code, kind] = part.split(':');
      return { code, exchange: kind === 'x' };
    });
    fetchDirectFundProfiles(items, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setProfiles((prev) => ({ ...prev, ...(result?.profiles || {}) }));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [profileRequestKey]);
  const rows = useMemo(
    () => (Object.keys(profiles).length
      ? buildLocalDirectMarketRows(allSymbols, { quotes, navs, isOtcList, heldCodes, names, profiles })
      : baseRows),
    [allSymbols, quotes, navs, isOtcList, heldCodes, names, profiles, baseRows]
  );
  const listRows = useMemo(() => {
    const listed = new Set(symbols.map((item) => String(item || '').trim().toUpperCase()));
    return rows.filter((row) => listed.has(row.symbol) || listed.has(row.code));
  }, [rows, symbols]);
  const selectedRow = selectedSymbol ? rows.find((row) => row.symbol === selectedSymbol) || null : null;
  const timeframe = localDirectKlineTimeframe(chartRange);

  // 详情 K 线：腾讯 fqkline 为主、东财 JSONP 兜底（fetchDirectKline 内部处理）。
  useEffect(() => {
    if (!selectedSymbol || selectedRow?.fundKind === 'otc') return undefined;
    let cancelled = false;
    const needed = Array.from(new Set(['1d', timeframe]));
    setChartLoading(true);
    Promise.allSettled(needed.map((tf) => fetchDirectKline(selectedSymbol, { timeframe: tf })))
      .then((results) => {
        if (cancelled) return;
        setCandlesByTf((prev) => {
          const next = { ...prev };
          results.forEach((result, index) => {
            const key = `${selectedSymbol}|${needed[index]}`;
            next[key] = result.status === 'fulfilled' ? (result.value?.candles || []) : [];
          });
          return next;
        });
      })
      .finally(() => { if (!cancelled) setChartLoading(false); });
    return () => { cancelled = true; };
  }, [selectedSymbol, selectedRow?.fundKind, timeframe, chartReloadTick]);

  // 按云端 MarketsMainContent 的缓存键喂 K 线：区间键 + 日线键。
  const chartCandlesMap = useMemo(() => {
    if (!selectedSymbol) return EMPTY_OBJECT;
    const rangeCandles = candlesByTf[`${selectedSymbol}|${timeframe}`];
    const daily = candlesByTf[`${selectedSymbol}|1d`];
    const map = {};
    if (daily) map[`${selectedSymbol}|1d`] = daily;
    if (rangeCandles) map[chartKlineCacheKeyForRange(selectedSymbol, chartRange, chartCustomRange)] = rangeCandles;
    return map;
  }, [candlesByTf, chartCustomRange, chartRange, selectedSymbol, timeframe]);

  const handleSelect = useCallback((row) => {
    const symbol = String(row?.symbol || row?.code || '').trim().toUpperCase();
    if (!symbol) return;
    if (!allSymbols.includes(symbol)) setExtraSymbols((prev) => [symbol, ...prev]);
    if (row?.name) setNames((prev) => ({ ...prev, [symbol]: row.name }));
    setSelectedSymbol(symbol);
    setDetailTab('overview');
    setSearchOpen(false);
    setSearchValue('');
  }, [allSymbols]);

  const inWatch = Boolean(selectedRow && symbols.map((item) => String(item).toUpperCase()).includes(selectedRow.symbol));
  const health = directFeedHealth({ error, updatedAt, rows: listRows });
  const showFullTable = !selectedRow;
  const omitColumnIds = useMemo(() => computeLocalDirectOmittedColumns(listRows), [listRows]);

  // 列表态锁住页面滚动（列表自己滚动），详情态放开，否则手机端详情页无法滑动。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    document.documentElement.classList.toggle('markets-full-table-active', showFullTable);
    document.body.classList.toggle('markets-full-table-active', showFullTable);
    return () => {
      document.documentElement.classList.remove('markets-full-table-active');
      document.body.classList.remove('markets-full-table-active');
    };
  }, [showFullTable]);

  return (
    <div data-market="cn" data-testid="local-direct-markets" className={cx(
      'markets-experience flex min-w-0 flex-col gap-4 lg:min-h-0 lg:pb-0',
      showFullTable ? 'flex-1 min-h-0 overflow-hidden pb-0' : (isMobile ? 'pb-[calc(140px+env(safe-area-inset-bottom))]' : 'pb-4')
    )}>
      {header}
      {error && showFullTable ? (
        <div role="alert" className="mx-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:mx-6">
          {error}，可点刷新重试或切回云端
        </div>
      ) : null}
      <MarketsMainContent
        market="cn"
        isMobile={isMobile}
        selectedQuote={selectedRow}
        klineMap={EMPTY_OBJECT}
        news={EMPTY_LIST}
        earnings={EMPTY_LIST}
        summary={{ themes: [], generatedAt: '' }}
        selectedSymbol={selectedSymbol}
        fullTableMode
        detailNotice={<MarketsSourceNotice localDirect onSwitch={() => onSwitchCloud?.(selectedSymbol, selectedRow?.name)} className="mx-3 sm:mx-1" />}
        fullTablePanel={(
          <Suspense fallback={<FullTableLoadingFallback />}>
            <MarketsFullTablePanel
              fullTableMode
              rows={listRows}
              market="cn"
              isMobile={isMobile}
              klineMap={EMPTY_OBJECT}
              watchLists={watchLists}
              activeWatchListId={activeWatchListId}
              activeWatchListName={(watchLists.find((item) => item.id === activeWatchListId) || {}).name}
              selectedSymbol={selectedSymbol}
              marketRefreshAt={updatedAt}
              feedHealth={health}
              refreshing={loading}
              onRefresh={() => load({ force: true })}
              onSelectWatchlist={onSelectWatchlist}
              onCreateWatchlist={onCreateWatchlist}
              onRenameWatchlist={onRenameWatchlist}
              onDeleteWatchlist={onDeleteWatchlist}
              onSelectSymbol={handleSelect}
              searchOpen={searchOpen}
              searchValue={searchValue}
              searchResults={searchResults}
              searchLoading={searchLoading}
              searchError={searchError}
              watchSymbols={symbols}
              onSearchToggle={() => { setSearchOpen((open) => !open); setSearchValue(''); }}
              onSearchChange={setSearchValue}
              onSearchClear={() => { setSearchValue(''); setSearchResults([]); setSearchError(''); }}
              onSearchResultSelect={handleSelect}
              onSearchResultAdd={(row) => { onAddSymbol?.(row); if (row?.name) setNames((prev) => ({ ...prev, [row.code || row.symbol]: row.name })); }}
              showLimitColumn={isOtcList}
              hidePremiumColumn={isOtcList}
              hideTrendColumn
              localDirect
              omitColumnIds={omitColumnIds}
              notice={<MarketsSourceNotice localDirect onSwitch={() => onSwitchCloud?.('')} className={isMobile ? 'mt-2 mx-3 mb-1' : ''} />}
            />
          </Suspense>
        )}
        detail={{
          localDirect: true,
          financials: null,
          financialsLoading: false,
          cnDetailData: buildLocalDirectDetailData(selectedRow),
          cnDetailLoading: false,
          activeTab: detailTab,
          onTabChange: setDetailTab,
          chartRange,
          onChartRangeChange: setChartRange,
          chartCustomRange,
          onChartCustomRangeChange: setChartCustomRange,
          onCnFundParamChange: undefined,
          chartCandlesMap,
          chartLoading,
          selectedCnFundCode: selectedRow?.code || '',
          premiumState: undefined,
          navHistoryMap: EMPTY_OBJECT,
          onRetryDetailHistory: () => setChartReloadTick((tick) => tick + 1),
          isMobile,
          summaryMode: false,
          tradeMarkers: EMPTY_LIST,
          buildOtcCandidate: () => null,
          inWatch,
          onToggleWatch: () => {
            if (!selectedRow) return;
            if (inWatch) onRemoveSymbol?.(selectedRow);
            else onAddSymbol?.(selectedRow);
          },
          onBack: () => setSelectedSymbol(''),
          onOpenAlertDialog: undefined,
          onMarketAction,
          onBacktestEvent: undefined,
        }}
      />
    </div>
  );
}

export default LocalDirectMarketsView;
