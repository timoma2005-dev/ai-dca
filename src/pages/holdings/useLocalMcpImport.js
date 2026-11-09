import { useCallback, useEffect, useRef, useState } from 'react';
import { getTodayShanghaiDate, normalizeTransaction } from '../../app/holdingsLedgerCore.js';
import { persistHoldingTransactionMutation } from '../../app/holdingTransactionMutations.js';
import { LOCAL_MCP_DEFAULT_URL, isLocalMcpSupportedDevice, normalizeLocalMcpUrl } from '../../app/localMcpClient.js';
import { buildMcpSyncPlan, dayBefore, dedupeTrades, fetchTzzbHoldings, findExchangeTransactions, findStaleAdjustments, planRowsToDrafts, tradesToDrafts } from '../../app/localMcpHoldings.js';
import { showActionToast } from '../../app/toast.js';
import { trackActionResult } from '../../app/analytics.js';

const URL_KEY = 'ai-dca:local-mcp:url';
const AUTO_KEY = 'ai-dca:local-mcp:auto';
const CLEAR_KEY = 'ai-dca:local-mcp:clear-missing';
const LAST_AUTO_KEY = 'ai-dca:local-mcp:last-auto';
const HISTORY_START_KEY = 'ai-dca:local-mcp:history-start';
const HISTORY_SYNCED_KEY = 'ai-dca:local-mcp:history-synced';
// 使用说明与授权同意（文案有实质变化时升版本号，要求重新同意）
export const LOCAL_MCP_CONSENT_VERSION = '2026-11-05';
const CONSENT_KEY = 'ai-dca:local-mcp:consent';

function readStore(key, fallback = '') {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
function writeStore(key, value) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* 隐私模式忽略 */ }
}

// 本地 MCP（同花顺投资账本 tzzb-mcp）持仓导入：读取 → 对账 → 预览确认 / 自动写入调整流水。
export function useLocalMcpImport({ ledger, setLedger, aggregates }) {
  const [supported] = useState(() => isLocalMcpSupportedDevice());
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(() => readStore(URL_KEY, LOCAL_MCP_DEFAULT_URL));
  const [autoSync, setAutoSyncState] = useState(() => readStore(AUTO_KEY, '0') === '1');
  const [clearMissing, setClearMissingState] = useState(() => readStore(CLEAR_KEY, '1') === '1');
  const [consented, setConsented] = useState(() => readStore(CONSENT_KEY, '') === LOCAL_MCP_CONSENT_VERSION);
  const [status, setStatus] = useState({ state: 'idle', message: '' });
  const [plan, setPlan] = useState(null);
  const [startDate, setStartDateState] = useState(() => readStore(HISTORY_START_KEY, '') || `${getTodayShanghaiDate().slice(0, 4)}-01-01`);
  const setStartDate = useCallback((value) => { setStartDateState(value); writeStore(HISTORY_START_KEY, value); }, []);
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;
  const aggregatesRef = useRef(aggregates);
  aggregatesRef.current = aggregates;

  const setAutoSync = useCallback((value) => { setAutoSyncState(value); writeStore(AUTO_KEY, value ? '1' : '0'); }, []);
  const setClearMissing = useCallback((value) => {
    setClearMissingState(value);
    writeStore(CLEAR_KEY, value ? '1' : '0');
    setPlan((prev) => (prev ? {
      ...prev,
      rows: prev.rows.map((row) => (row.missingInBroker ? { ...row, selected: value } : row))
    } : prev));
  }, []);

  const fetchPlan = useCallback(async ({ silent = false, fromDate = '' } = {}) => {
    if (readStore(CONSENT_KEY, '') !== LOCAL_MCP_CONSENT_VERSION) {
      if (!silent) setStatus({ state: 'error', message: '请先阅读并同意使用说明。' });
      return null;
    }
    const normalized = normalizeLocalMcpUrl(url);
    if (!normalized) {
      setStatus({ state: 'error', message: '地址格式不正确，例如 http://127.0.0.1:8765/mcp' });
      return null;
    }
    writeStore(URL_KEY, normalized);
    if (!silent) setStatus({ state: 'loading', message: '正在读取本机投资账本持仓与历史成交…' });
    const date = getTodayShanghaiDate();
    const historyStart = (fromDate || startDate || date) > date ? date : (fromDate || startDate || date);
    try {
      const data = await fetchTzzbHoldings(normalized, { history: { startDate: historyStart, endDate: date } });
      const existing = ledgerRef.current?.transactions || [];
      // 全量模式：读到逐笔成交时，先清掉本站全部场内记录，再按账本全量写入（成交 + 起始日前的期初）。
      // 读不到成交（旧版工具 / 出错）时不清空，只按持仓差额调整，避免把记录清空却写不回来。
      const exchangeCodes = [
        ...(aggregatesRef.current || []).filter((agg) => agg?.kind === 'exchange').map((agg) => agg.code),
        ...data.positions.map((pos) => pos.code),
        ...data.trades.map((t) => t.code)
      ];
      const stale = data.historyError ? findStaleAdjustments(existing, date, date) : findExchangeTransactions(existing, exchangeCodes);
      const staleIds = new Set(stale.map((tx) => tx.id));
      const deduped = dedupeTrades(data.trades, data.historyError ? existing.filter((tx) => !staleIds.has(tx.id)) : []);
      // 有逐笔成交时，剩余差额视为起始日之前没录的持仓，记在起始日前一天（期初）；否则按今天记调整。
      const adjustDate = data.historyError ? date : (dayBefore(historyStart) || date);
      const next = {
        ...buildMcpSyncPlan({ positions: data.positions, aggregates: aggregatesRef.current, date: adjustDate, clearMissing, pendingTrades: deduped.trades, removedTransactions: stale }),
        staleAdjustments: stale,
        positions: data.positions,
        trades: deduped.trades,
        duplicateCount: deduped.duplicate,
        historyStart,
        historyError: data.historyError,
        accounts: data.perAccount.map((acc) => ({ label: acc.label, count: acc.positions.length })),
        fetchedAt: new Date().toISOString()
      };
      setPlan(next);
      const parts = [`读到 ${data.positions.length} 只持仓`];
      if (!data.historyError) parts.push(`${historyStart} 起 ${deduped.trades.length} 笔成交`);
      if (stale.length) parts.push(`将清空本站 ${stale.length} 笔场内记录后全量写入`);
      parts.push(next.changeCount ? `另有 ${next.changeCount} 只按期初补齐份额` : '写入后份额与账本一致');
      setStatus({ state: data.historyError ? 'error' : 'success', message: `${parts.join('，')}。${data.historyError ? ` ${data.historyError}` : ''}` });
      trackActionResult('holdings', 'local_mcp_fetch', 'success', { positionCount: data.positions.length, tradeCount: deduped.trades.length, changeCount: next.changeCount, silent });
      return next;
    } catch (error) {
      setStatus({ state: 'error', message: error?.message || '读取失败' });
      trackActionResult('holdings', 'local_mcp_fetch', 'error', { silent, errorMessage: String(error?.message || '').slice(0, 80) });
      return null;
    }
  }, [url, clearMissing, startDate]);

  const applyRows = useCallback(async (rows, date, { source = 'manual', trades = [], removed = [] } = {}) => {
    const drafts = [...tradesToDrafts(trades), ...planRowsToDrafts(rows, date)].map((draft) => normalizeTransaction(draft));
    const deletedIds = removed.map((tx) => tx.id).filter(Boolean);
    if (!drafts.length && !deletedIds.length) return 0;
    const current = ledgerRef.current;
    const keep = (current.transactions || []).filter((tx) => !deletedIds.includes(tx.id));
    const nextState = { ...current, transactions: [...keep, ...drafts] };
    try {
      await persistHoldingTransactionMutation(nextState, {
        kind: 'save',
        label: '正在同步本地 MCP 持仓',
        upsertIds: drafts.map((d) => d.id),
        deletedIds,
        setLedger
      });
    } catch (error) {
      showActionToast('同步已保存到本地', 'warning', { description: error?.message || '云端同步稍后重试。' });
    }
    writeStore(HISTORY_SYNCED_KEY, getTodayShanghaiDate());
    trackActionResult('holdings', 'local_mcp_import', 'success', { importedCount: drafts.length, removedCount: deletedIds.length, source });
    return drafts.length || deletedIds.length;
  }, [setLedger]);

  const importSelected = useCallback(async () => {
    if (!plan) return;
    const count = await applyRows(plan.rows, plan.date, { trades: plan.trades || [], removed: plan.staleAdjustments || [] });
    if (count) showActionToast('持仓已同步', 'success', { description: `已按账本全量写入（清空 ${(plan.staleAdjustments || []).length} 笔旧场内记录）。` });
    setPlan(null);
    setOpen(false);
  }, [plan, applyRows]);

  const toggleRow = useCallback((code) => {
    setPlan((prev) => (prev ? { ...prev, rows: prev.rows.map((row) => (row.code === code ? { ...row, selected: !row.selected } : row)) } : prev));
  }, []);
  const toggleTrade = useCallback((id) => {
    setPlan((prev) => {
      if (!prev) return prev;
      const trades = prev.trades.map((t) => (t.id === id ? { ...t, selected: !t.selected } : t));
      const replan = buildMcpSyncPlan({ positions: prev.positions, aggregates: aggregatesRef.current, date: prev.date, clearMissing, pendingTrades: trades, removedTransactions: prev.staleAdjustments || [] });
      return { ...prev, ...replan, trades };
    });
  }, [clearMissing]);
  const setAllTrades = useCallback((selected) => {
    setPlan((prev) => {
      if (!prev) return prev;
      const trades = prev.trades.map((t) => ({ ...t, selected }));
      const replan = buildMcpSyncPlan({ positions: prev.positions, aggregates: aggregatesRef.current, date: prev.date, clearMissing, pendingTrades: trades, removedTransactions: prev.staleAdjustments || [] });
      return { ...prev, ...replan, trades };
    });
  }, [clearMissing]);
  const setRowPrice = useCallback((code, value) => {
    setPlan((prev) => (prev ? { ...prev, rows: prev.rows.map((row) => (row.code === code ? { ...row, price: Number(value) || 0 } : row)) } : prev));
  }, []);

  // 自动导入：开启后进入持仓页即读取并直接写入差额（每 10 分钟最多一次）。
  useEffect(() => {
    if (!autoSync || !supported || !consented) return;
    const last = Number(readStore(LAST_AUTO_KEY, '0')) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    let cancelled = false;
    // 等本地 / 云端流水加载稳定后再对账，避免空账本时把全部持仓当成新买入。
    const timer = setTimeout(async () => {
      if (cancelled || !(ledgerRef.current?.transactions || []).length) return;
      writeStore(LAST_AUTO_KEY, Date.now());
      // 自动导入同样全量：从起始日重读、清空场内记录后整体重写。
      const next = await fetchPlan({ silent: true });
      if (cancelled || !next) {
        if (!next && !cancelled) showActionToast('本地 MCP 自动同步失败', 'warning', { description: '本机桥接服务未运行或投资账本未登录。' });
        return;
      }
      const count = await applyRows(next.rows, next.date, { source: 'auto', trades: next.trades || [], removed: next.staleAdjustments || [] });
      if (count) showActionToast('已自动同步持仓', 'success', { description: `按投资账本写入 ${count} 笔记录（成交 ${next.trades?.length || 0} 笔）。` });
      setPlan(null);
    }, 6000);
    return () => { cancelled = true; clearTimeout(timer); };
    // 仅在页面进入 / 开关打开时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSync, consented]);

  return {
    supported,
    open,
    openModal: () => { setOpen(true); setStatus({ state: 'idle', message: '' }); setPlan(null); },
    onClose: () => setOpen(false),
    consented,
    onConsent: () => { writeStore(CONSENT_KEY, LOCAL_MCP_CONSENT_VERSION); setConsented(true); },
    onRevokeConsent: () => { writeStore(CONSENT_KEY, ''); writeStore(AUTO_KEY, '0'); setAutoSyncState(false); setConsented(false); },
    url,
    setUrl,
    autoSync,
    setAutoSync,
    clearMissing,
    setClearMissing,
    status,
    plan,
    startDate,
    setStartDate,
    onToggleTrade: toggleTrade,
    onSetAllTrades: setAllTrades,
    onFetch: () => fetchPlan(),
    onImport: importSelected,
    onToggleRow: toggleRow,
    onRowPriceChange: setRowPrice
  };
}
