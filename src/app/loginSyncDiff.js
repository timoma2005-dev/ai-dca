// 登录后本地/云端数据差异计算（纯函数，无副作用）。
//
// - 普通资源按资源整体比较；数组类资源再按条目 id/key 给出「仅本地 / 仅云端 / 内容不同」；
// - 持仓交易（holdings/ledger）按交易行 id 比较；
// - 比较时忽略 savedAt/updatedAt 等易变时间戳，避免同一份数据仅因保存时间不同被误判为差异。
import { descriptorForResource } from './accountResources.js';

export const LOGIN_SYNC_CHOICES = Object.freeze({ LOCAL: 'local', REMOTE: 'remote', MERGE: 'merge' });
export const HOLDINGS_LEDGER_RESOURCE = 'holdings/ledger';

const VOLATILE_KEYS = new Set(['savedAt', 'updatedAt', 'lastSyncedAt', 'syncedAt', 'revision', 'contentHash']);
const ENTRY_ID_FIELDS = ['id', 'key', 'code', 'symbol', 'uuid'];
const ENTRY_LABEL_FIELDS = ['name', 'title', 'label', 'fundName', 'symbolName'];
const PREVIEW_LIMIT = 3;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.has(key) || value[key] === undefined) continue;
    out[key] = stripVolatile(value[key]);
  }
  return out;
}

/** 稳定序列化（键排序、忽略易变时间戳），用于判等。 */
export function canonicalize(value) {
  return JSON.stringify(stripVolatile(value ?? null));
}

export function parseLocalRaw(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(stripVolatile(value)).length === 0;
  return false;
}

function entryKey(item, index) {
  if (isPlainObject(item)) {
    for (const field of ENTRY_ID_FIELDS) {
      const value = item[field];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return `#${index + 1}`;
  }
  if (item === null || item === undefined) return `#${index + 1}`;
  return String(item);
}

function entryLabel(item, key) {
  if (!isPlainObject(item)) return String(key);
  const name = ENTRY_LABEL_FIELDS.map((field) => item[field]).find((value) => value !== undefined && value !== null && String(value).trim());
  const code = item.code || item.symbol || '';
  if (name && code && String(name) !== String(code)) return `${name}（${code}）`;
  return String(name || code || key);
}

function arrayFields(value) {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).filter((key) => Array.isArray(value[key]));
}

/** 选取两边共同的主列表：数组本身，或对象里条目最多的数组字段；否则按对象键比较。 */
function pickEntryShape(local, remote) {
  if (Array.isArray(local) || Array.isArray(remote)) return { kind: 'array', path: '' };
  const fields = new Set([...arrayFields(local), ...arrayFields(remote)]);
  let best = '';
  let bestSize = -1;
  for (const field of fields) {
    const size = (local?.[field]?.length || 0) + (remote?.[field]?.length || 0);
    if (size > bestSize) { best = field; bestSize = size; }
  }
  if (best && bestSize > 0) return { kind: 'array', path: best };
  if (isPlainObject(local) || isPlainObject(remote)) return { kind: 'object', path: '' };
  return { kind: 'scalar', path: '' };
}

function entriesOf(value, shape) {
  const map = new Map();
  if (shape.kind === 'array') {
    const list = shape.path ? value?.[shape.path] : value;
    (Array.isArray(list) ? list : []).forEach((item, index) => {
      let key = entryKey(item, index);
      while (map.has(key)) key = `${key}#${index + 1}`;
      map.set(key, item);
    });
  } else if (shape.kind === 'object' && isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (!VOLATILE_KEYS.has(key)) map.set(key, value[key]);
    }
  }
  return map;
}

function diffEntryMaps(localMap, remoteMap) {
  const localOnly = [];
  const remoteOnly = [];
  const changed = [];
  for (const [key, item] of localMap) {
    if (!remoteMap.has(key)) localOnly.push({ key, label: entryLabel(item, key) });
    else if (canonicalize(item) !== canonicalize(remoteMap.get(key))) changed.push({ key, label: entryLabel(item, key) });
  }
  for (const [key, item] of remoteMap) {
    if (!localMap.has(key)) remoteOnly.push({ key, label: entryLabel(item, key) });
  }
  return { localOnly, remoteOnly, changed };
}

function valueUpdatedAt(value) {
  if (!isPlainObject(value)) return '';
  return String(value.updatedAt || value.savedAt || '');
}

function summarizeSide(value, shape, updatedAt = '') {
  if (value === null || value === undefined) return { exists: false, count: 0, updatedAt: '', preview: [] };
  const entries = entriesOf(value, shape);
  const preview = Array.from(entries.entries()).slice(0, PREVIEW_LIMIT).map(([key, item]) => entryLabel(item, key));
  return {
    exists: true,
    count: shape.kind === 'scalar' ? 1 : entries.size,
    updatedAt: String(updatedAt || valueUpdatedAt(value) || ''),
    preview,
    field: shape.path || ''
  };
}

/** 单个资源的差异；两边一致（或都为空）时返回 null。 */
export function diffResource({ resource, localRaw = null, remote = null } = {}) {
  const local = parseLocalRaw(localRaw);
  const remoteData = remote ? remote.data ?? null : null;
  const localEmpty = isEmptyValue(local);
  const remoteEmpty = isEmptyValue(remoteData);
  if (localEmpty && remoteEmpty) return null;
  if (canonicalize(local) === canonicalize(remoteData)) return null;
  const shape = pickEntryShape(local, remoteData);
  const entries = shape.kind === 'scalar'
    ? { localOnly: [], remoteOnly: [], changed: [] }
    : diffEntryMaps(entriesOf(local, shape), entriesOf(remoteData, shape));
  return {
    id: resource,
    kind: 'resource',
    resource,
    label: descriptorForResource(resource)?.label || resource,
    local: summarizeSide(localEmpty ? null : local, shape),
    remote: summarizeSide(remoteEmpty ? null : remoteData, shape, remote?.updatedAt),
    entries
  };
}

function txId(tx) {
  return String(tx?.id || '').trim();
}

/** 交易行展示摘要：代码、日期、方向、份额/金额。 */
export function briefTransaction(tx = {}) {
  return {
    id: txId(tx),
    code: String(tx.code || ''),
    name: String(tx.name || tx.fundName || ''),
    date: String(tx.date || ''),
    type: String(tx.type || ''),
    shares: Number(tx.shares) || 0,
    amount: Number(tx.amount) || 0
  };
}

function latestTxTime(list = []) {
  return list.map((tx) => String(tx?.updatedAt || tx?.createdAt || '')).filter(Boolean).sort().pop() || '';
}

/** 持仓交易按行 id 的差异；完全一致时返回 null。 */
export function diffTransactionRows(localRows = [], remoteRows = []) {
  const localMap = new Map(localRows.filter(txId).map((tx) => [txId(tx), tx]));
  const remoteMap = new Map(remoteRows.filter(txId).map((tx) => [txId(tx), tx]));
  const localOnly = [];
  const remoteOnly = [];
  const changed = [];
  for (const [id, tx] of localMap) {
    const remote = remoteMap.get(id);
    if (!remote) localOnly.push(briefTransaction(tx));
    else if (canonicalize(tx) !== canonicalize(remote)) changed.push({ id, local: briefTransaction(tx), remote: briefTransaction(remote) });
  }
  for (const [id, tx] of remoteMap) {
    if (!localMap.has(id)) remoteOnly.push(briefTransaction(tx));
  }
  if (!localOnly.length && !remoteOnly.length && !changed.length) return null;
  const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
  return {
    id: HOLDINGS_LEDGER_RESOURCE,
    kind: 'transactions',
    resource: HOLDINGS_LEDGER_RESOURCE,
    label: descriptorForResource(HOLDINGS_LEDGER_RESOURCE)?.label || '持仓交易行',
    local: { exists: localMap.size > 0, count: localMap.size, updatedAt: latestTxTime(localRows), preview: [] },
    remote: { exists: remoteMap.size > 0, count: remoteMap.size, updatedAt: latestTxTime(remoteRows), preview: [] },
    rows: { localOnly: localOnly.sort(byDate), remoteOnly: remoteOnly.sort(byDate), changed: changed.sort((a, b) => byDate(a.local, b.local)) },
    remoteOnlyIds: remoteOnly.map((tx) => tx.id)
  };
}

/**
 * 计算登录时的整体差异。
 * sides: { resources: string[], localResources: {resource: raw}, remoteResources: {resource: {data, updatedAt}},
 *          localTransactions: tx[], remoteTransactions: tx[] }
 */
export function computeLoginSyncDiff(sides = {}) {
  const names = Array.isArray(sides.resources) && sides.resources.length
    ? sides.resources
    : Array.from(new Set([...Object.keys(sides.localResources || {}), ...Object.keys(sides.remoteResources || {})]));
  const items = [];
  for (const resource of names) {
    const item = diffResource({
      resource,
      localRaw: sides.localResources?.[resource] ?? null,
      remote: sides.remoteResources?.[resource] || null
    });
    if (item) items.push(item);
  }
  const txItem = diffTransactionRows(sides.localTransactions || [], sides.remoteTransactions || []);
  if (txItem) items.unshift(txItem);
  return { items, hasDiff: items.length > 0 };
}

export function hasLocalAccountData(sides = {}) {
  if ((sides.localTransactions || []).length > 0) return true;
  return Object.values(sides.localResources || {}).some((raw) => !isEmptyValue(parseLocalRaw(raw)));
}

export function hasRemoteAccountData(sides = {}) {
  if ((sides.remoteTransactions || []).length > 0) return true;
  return Object.values(sides.remoteResources || {}).some((entry) => !isEmptyValue(entry?.data));
}

export function defaultLoginSyncChoices(items = []) {
  return Object.fromEntries(items.map((item) => [item.id, LOGIN_SYNC_CHOICES.MERGE]));
}

/** 顶部快捷按钮：全部本地覆盖云端 / 全部云端覆盖本地 / 全部合并。 */
export function uniformLoginSyncChoices(items = [], choice = LOGIN_SYNC_CHOICES.MERGE) {
  const valid = Object.values(LOGIN_SYNC_CHOICES).includes(choice) ? choice : LOGIN_SYNC_CHOICES.MERGE;
  return Object.fromEntries(items.map((item) => [item.id, valid]));
}

export function normalizeLoginSyncChoice(choice) {
  return Object.values(LOGIN_SYNC_CHOICES).includes(choice) ? choice : LOGIN_SYNC_CHOICES.MERGE;
}
