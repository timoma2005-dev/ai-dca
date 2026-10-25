import { DEMO_DATA_MARKER_KEY, LEDGER_KEY, LEGACY_LEDGER_KEY } from '../demoDataMeta.js';
// 从现有本地数据推断入门任务是否已完成（只读 localStorage，不发任何请求）。
// 云同步恢复会直接写 localStorage，所以任务卡会定期重读；数据没读到时一律视为「未完成」，不会误判为老用户。


export const SIGNAL_KEYS = {
  ledger: LEDGER_KEY,
  legacyLedger: LEGACY_LEDGER_KEY,
  demoMarker: DEMO_DATA_MARKER_KEY,
  switchConfig: 'aiDcaSwitchStrategyWorkerConfig',
  notifyClient: 'aiDcaNotifyClientConfig'
};

function parse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function hasHoldingRecords(ledger, legacy) {
  if (Array.isArray(ledger?.transactions) && ledger.transactions.some(Boolean)) return true;
  return Array.isArray(legacy?.rows) && legacy.rows.some((row) => row?.code && Number(row?.shares) > 0);
}

/** 已保存的切换方案：默认空规则（没有任何基金代码）不算。 */
export function hasSavedSwitchRule(config) {
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  return rules.some((rule) => (Array.isArray(rule?.benchmarkCodes) && rule.benchmarkCodes.length)
    || (Array.isArray(rule?.enabledCodes) && rule.enabledCodes.length));
}

export function hasNotifyChannel(clientConfig) {
  if (!clientConfig || typeof clientConfig !== 'object') return false;
  if (String(clientConfig.barkDeviceKey || '').trim()) return true;
  return Boolean(String(clientConfig.serverChan3Uid || '').trim() && String(clientConfig.serverChan3SendKey || '').trim());
}

/**
 * @param {object} options
 * @param {{getItem(key:string):string|null}} [options.storage]
 * @param {object} [options.keys] 覆盖存储 key（测试用；默认读取与业务模块一致的 key）
 */
export function readOnboardingSignals({ storage, keys = SIGNAL_KEYS } = {}) {
  let ls = storage;
  if (!ls) {
    try {
      ls = typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
      ls = null;
    }
  }
  if (!ls) return { holdings: false, switch: false, notify: false };
  const read = (key) => {
    try {
      return parse(ls.getItem(key));
    } catch {
      return null;
    }
  };
  return {
    // 一键安装的演示持仓不算真实录入。
    holdings: !read(keys.demoMarker) && hasHoldingRecords(read(keys.ledger), read(keys.legacyLedger)),
    switch: hasSavedSwitchRule(read(keys.switchConfig)),
    notify: hasNotifyChannel(read(keys.notifyClient))
  };
}
