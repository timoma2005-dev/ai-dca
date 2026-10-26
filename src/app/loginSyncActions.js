// 登录后本地数据合并：读取两侧数据 + 按用户选择执行。
// 依赖全部可注入（deps），便于单测在不触网、不写线上库的前提下验证调用。
import { keyForResource, listAccountResourceNames } from './accountResources.js';
import { deleteAccountResource, fetchAccountBundle, fetchAccountManifest } from './accountApi.js';
import { fetchHoldingTransactionRows } from './holdingTransactionsApi.js';
import { pullResources, pushResource, readLocalResourceRaw } from './resourceSync.js';
import {
  HOLDING_TRANSACTION_SYNC_STATE_KEY,
  pullHoldingTransactions,
  pushHoldingTransactions,
  readCurrentHoldingTransactions
} from './holdingTransactionsSync.js';
import { applyBackupEnvelope } from './webdavBackup.js';
import { isLikelyDateFundCode, sanitizeTransactions } from './holdingsLedgerBasics.js';
import { HOLDINGS_LEDGER_RESOURCE, LOGIN_SYNC_CHOICES, normalizeLoginSyncChoice } from './loginSyncDiff.js';

const LEDGER_STORAGE_KEY = 'aiDcaFundHoldingsLedger';

function storage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function writeLocalResource(resource, raw) {
  const ls = storage();
  const key = keyForResource(resource);
  if (!ls || !key) return false;
  if (raw === null || raw === undefined) {
    ls.removeItem(key);
    return true;
  }
  applyBackupEnvelope({ version: 1, source: 'ai-dca', keyCount: 1, keys: [key], payload: { [key]: raw } }, { wipePrefix: false });
  return true;
}

function writeLocalTransactions(transactions = []) {
  const ls = storage();
  if (!ls) return false;
  let current = {};
  try { current = JSON.parse(ls.getItem(LEDGER_STORAGE_KEY) || 'null') || {}; } catch { current = {}; }
  const next = { ...(current && typeof current === 'object' ? current : {}), transactions: Array.isArray(transactions) ? transactions : [] };
  delete next.snapshotsByCode;
  ls.setItem(LEDGER_STORAGE_KEY, JSON.stringify(next));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('holdings:ledger-updated', { detail: { state: next, source: 'cloud-transactions' } }));
  }
  return true;
}

// 同一浏览器可能残留上一个账号的行同步基线（revision/knownIds）；
// 登录合并前清空，让 revision 以当前账号云端为准，避免误删或冲突。
function resetHoldingSyncState() {
  const ls = storage();
  if (!ls) return false;
  ls.setItem(HOLDING_TRANSACTION_SYNC_STATE_KEY, JSON.stringify({ rows: {}, knownIds: [], savedAt: new Date().toISOString() }));
  return true;
}

export const DEFAULT_LOGIN_SYNC_DEPS = Object.freeze({
  listResourceNames: listAccountResourceNames,
  fetchAccountManifest,
  fetchAccountBundle,
  fetchHoldingTransactionRows,
  deleteAccountResource,
  readLocalResourceRaw,
  readLocalTransactions: readCurrentHoldingTransactions,
  pullResources,
  pushResource,
  pullHoldingTransactions,
  pushHoldingTransactions,
  writeLocalResource,
  writeLocalTransactions,
  resetHoldingSyncState
});

async function fetchAllRemoteTransactions(deps, session) {
  const rows = [];
  let cursor = '';
  const seen = new Set();
  do {
    if (seen.has(cursor)) throw new Error('持仓交易同步游标重复');
    seen.add(cursor);
    const result = await deps.fetchHoldingTransactionRows({ cursor, limit: 1000 }, session);
    if (Array.isArray(result?.rows)) rows.push(...result.rows);
    cursor = String(result?.nextCursor || '');
  } while (cursor);
  const list = rows
    .filter((row) => row && !row.deleted)
    .map((row) => {
      const data = row?.data && typeof row.data === 'object' ? row.data : row;
      return { ...data, id: String(row?.id || data?.id || '').trim() };
    })
    .filter((tx) => tx.id && !isLikelyDateFundCode(tx.code, tx.date));
  return sanitizeTransactions(list, { filterInvalid: false }).filter((tx) => String(tx?.id || '').trim());
}

/** 读取本地与云端两侧数据，供 diff 使用。 */
export async function loadLoginSyncSides({ session, deps = DEFAULT_LOGIN_SYNC_DEPS } = {}) {
  const names = deps.listResourceNames();
  const nameSet = new Set(names);
  const manifest = await deps.fetchAccountManifest(session);
  const populated = (Array.isArray(manifest?.resources) ? manifest.resources : [])
    .filter((item) => nameSet.has(item?.resource) && Number(item?.revision || 0) > 0 && !item?.deleted);
  const bundle = populated.length
    ? await deps.fetchAccountBundle(populated.map((item) => item.resource), session)
    : { resources: {} };
  const remoteResources = {};
  for (const item of populated) {
    const entry = bundle?.resources?.[item.resource];
    if (!entry || entry.data === null || entry.data === undefined) continue;
    remoteResources[item.resource] = { data: entry.data, updatedAt: String(entry.updatedAt || item.updatedAt || ''), revision: Number(entry.revision || item.revision || 0) };
  }
  const remoteTransactions = await fetchAllRemoteTransactions(deps, session);
  const localResources = {};
  for (const name of names) {
    const raw = deps.readLocalResourceRaw(name);
    if (raw !== null && raw !== undefined) localResources[name] = raw;
  }
  const localTransactions = deps.readLocalTransactions();
  return { resources: names, localResources, remoteResources, localTransactions, remoteTransactions };
}

async function applyResourceChoice(item, choice, sides, { session, deps, pullList, result }) {
  const resource = item.resource;
  const localRaw = sides.localResources?.[resource] ?? null;
  const remote = sides.remoteResources?.[resource] || null;
  if (choice === LOGIN_SYNC_CHOICES.LOCAL) {
    if (localRaw === null) {
      if (remote) await deps.deleteAccountResource(resource, session);
      result.deletedRemote.push(resource);
    } else {
      await deps.pushResource(resource, { force: true, session });
      result.pushed.push(resource);
    }
    return;
  }
  if (choice === LOGIN_SYNC_CHOICES.REMOTE) {
    if (!remote) {
      deps.writeLocalResource(resource, null);
      result.deletedLocal.push(resource);
      return;
    }
    // 先用云端整体替换本地，再走拉取登记 revision（两边一致，不会回传本地独有项）。
    deps.writeLocalResource(resource, JSON.stringify(remote.data));
    pullList.push(resource);
    result.replacedLocal.push(resource);
    return;
  }
  // 合并：沿用原有「云端优先 + 保留本地独有并回传」；云端没有则直接上传本地。
  if (remote) pullList.push(resource);
  else if (localRaw !== null) {
    await deps.pushResource(resource, { force: true, session });
    result.pushed.push(resource);
  }
  result.merged.push(resource);
}

function collectPushFailures(outcome, item, result) {
  for (const failure of outcome?.failed || []) {
    result.failed.push({ id: `${item.id}:${failure.id}`, label: `${item.label} ${failure.id}`, message: failure.message || '同步失败' });
  }
}

async function applyTransactionChoice(item, choice, sides, { session, deps, result }) {
  deps.resetHoldingSyncState();
  if (choice === LOGIN_SYNC_CHOICES.LOCAL) {
    // 本地覆盖云端：全部本地行强制写云端，云端多出的行删除。
    collectPushFailures(await deps.pushHoldingTransactions({ session, force: true, deletedIds: item.remoteOnlyIds || [] }), item, result);
  } else if (choice === LOGIN_SYNC_CHOICES.REMOTE) {
    // 云端覆盖本地：本地账本替换为云端行（本地独有行删除），再拉取登记 revision。
    deps.writeLocalTransactions(sides.remoteTransactions || []);
    await deps.pullHoldingTransactions({ session, force: true });
  } else {
    // 合并：按行合并，同 id 云端优先；本地独有行随后回传。
    await deps.pullHoldingTransactions({ session, force: true });
    collectPushFailures(await deps.pushHoldingTransactions({ session }), item, result);
  }
  result.transactions = choice;
}

/**
 * 按用户选择执行。choices: { [item.id]: 'local' | 'remote' | 'merge' }，缺省为合并。
 * 单项失败不会中断其它项，失败汇总在 result.failed。
 */
export async function applyLoginSyncChoices({ sides, diff, choices = {}, session, deps = DEFAULT_LOGIN_SYNC_DEPS } = {}) {
  const result = { pushed: [], deletedRemote: [], deletedLocal: [], replacedLocal: [], merged: [], pulled: [], transactions: '', failed: [] };
  const pullList = [];
  const items = Array.isArray(diff?.items) ? diff.items : [];
  for (const item of items) {
    if (item.kind !== 'resource') continue;
    try {
      await applyResourceChoice(item, normalizeLoginSyncChoice(choices[item.id]), sides, { session, deps, pullList, result });
    } catch (error) {
      result.failed.push({ id: item.id, label: item.label, message: error?.message || String(error) });
    }
  }
  if (pullList.length) {
    try {
      await deps.pullResources({ resources: pullList, force: true, session });
      result.pulled.push(...pullList);
    } catch (error) {
      result.failed.push({ id: 'resources', label: '云端资源拉取', message: error?.message || String(error) });
    }
  }
  const txItem = items.find((item) => item.kind === 'transactions' && item.id === HOLDINGS_LEDGER_RESOURCE);
  if (txItem) {
    try {
      await applyTransactionChoice(txItem, normalizeLoginSyncChoice(choices[txItem.id]), sides, { session, deps, result });
    } catch (error) {
      result.failed.push({ id: txItem.id, label: txItem.label, message: error?.message || String(error) });
    }
  }
  return result;
}

export { resetHoldingSyncState as resetHoldingSyncStateForLogin };
