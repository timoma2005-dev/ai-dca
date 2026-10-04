// 备份 envelope helper：导出直接从服务端 API 获取最新数据，不再读 localStorage。
// 写入本地（applyBackupEnvelope）仍用于 resourceSync 将服务端数据缓存到本地。

import { BACKUP_APPLIED_EVENT } from './backupEvents.js';
import { fetchAccountEnvelopeExport } from './accountApi.js';

export { BACKUP_APPLIED_EVENT };
const HOLDINGS_BACKUP_KEYS = new Set([
  'aiDcaFundHoldingsLedger',
  'aiDcaFundHoldingsState'
]);
// 恢复后需主动广播领域事件、让对应消费者重新读取的 key（无 React storage 监听兜底者）。
const PREMIUM_STATE_KEY = 'aiDcaPremiumState';
const BACKUP_VERSION = 1;

function safeLocalStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}

// 从服务端 API 获取最新数据组装备份 envelope，不再读 localStorage。
// API 失败时抛出错误，调用方负责提示用户，不生成空备份。
export async function buildBackupEnvelope() {
  const envelope = await fetchAccountEnvelopeExport();
  if (!envelope || typeof envelope !== 'object' || !envelope.payload) {
    throw new Error('服务端备份数据格式不合法');
  }
  return {
    version: Number(envelope.version || BACKUP_VERSION) || BACKUP_VERSION,
    exportedAt: envelope.exportedAt || new Date().toISOString(),
    source: 'ai-dca',
    keyCount: Array.isArray(envelope.keys) ? envelope.keys.length : Object.keys(envelope.payload).length,
    keys: Array.isArray(envelope.keys) ? envelope.keys : Object.keys(envelope.payload),
    payload: envelope.payload,
  };
}

export function applyBackupEnvelope(envelope, { wipePrefix = true } = {}) {
  const ls = safeLocalStorage();
  if (!ls) throw new Error('localStorage 不可用');
  if (!envelope || typeof envelope !== 'object') throw new Error('备份内容格式不合法');
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object') throw new Error('备份缺少 payload 字段');

  if (wipePrefix) {
    // 清理所有 aiDca 前缀 key（登录态 / 缓存 / UI 临时状态由调用方控制，不在此删除）。
    const toDelete = [];
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (!key) continue;
      if (!key.startsWith('aiDca')) continue;
      toDelete.push(key);
    }
    toDelete.forEach((key) => ls.removeItem(key));
  }

  let restored = 0;
  const restoredKeys = [];
  Object.entries(payload).forEach(([key, value]) => {
    if (typeof key !== 'string') return;
    if (value === null || value === undefined) return;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    ls.setItem(key, str);
    restored += 1;
    restoredKeys.push(key);
  });

  if (typeof window !== 'undefined') {
    const detail = { keys: restoredKeys, restoredKeyCount: restored };
    window.dispatchEvent(new CustomEvent(BACKUP_APPLIED_EVENT, { detail }));
    if (restoredKeys.some((key) => HOLDINGS_BACKUP_KEYS.has(key))) {
      window.dispatchEvent(new CustomEvent('holdings:ledger-updated', {
        detail: { ...detail, source: 'backup-applied' }
      }));
    }
    // 会员状态 UI 监听 aidca:premium-changed；恢复是直接写 localStorage，需补发一次以刷新。
    if (restoredKeys.includes(PREMIUM_STATE_KEY)) {
      window.dispatchEvent(new CustomEvent('aidca:premium-changed', { detail: { source: 'backup-applied' } }));
    }
  }

  return { restoredKeyCount: restored };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
