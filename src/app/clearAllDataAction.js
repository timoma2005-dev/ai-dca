import { confirmAction } from './confirm.js';
import { clearAllLocalDataAsync, getDataStats, getClearDataConfirmMessage } from './clearAllData.js';
import { showActionToast } from './toast.js';
import { trackActionResult, trackFeatureEvent } from './analytics.js';

export async function runClearAllDataAction({
  transactions = [],
  aggregates = [],
  tradeLedgerEntries = [],
  onCleared = () => {}
} = {}) {
  if (typeof window === 'undefined' || !window.localStorage) {
    showActionToast('清除数据失败', 'error', { description: '无法访问本地存储。' });
    return;
  }

  const stats = getDataStats({ transactions, aggregates, tradeLedgerEntries });
  // Use an awaited in-app confirm directly. The mobile FAB closes and unmounts its
  // action button immediately, so the legacy window.confirm replay has no trigger.
  const confirmed = await confirmAction({
    title: '确认执行此操作？',
    description: getClearDataConfirmMessage(stats),
    confirmText: '确认执行',
    tone: 'danger'
  });
  if (!confirmed) {
    trackFeatureEvent('holdings', 'clear_all_data_cancel', stats);
    return;
  }

  const startedAt = Date.now();
  try {
    await clearAllLocalDataAsync();
    onCleared();
    showActionToast('已清除所有数据', 'success', { description: '所有持仓、交易、计划数据已清空。' });
    trackActionResult('holdings', 'clear_all_data', 'success', { ...stats, durationMs: Date.now() - startedAt });
  } catch (error) {
    showActionToast('清除数据失败', 'error', { description: error?.message || '清除过程中出现错误。' });
    trackActionResult('holdings', 'clear_all_data', 'error', { ...stats, durationMs: Date.now() - startedAt, errorMessage: error?.message || '' });
  }
}
