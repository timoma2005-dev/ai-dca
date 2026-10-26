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

// 界面状态 / 偏好类资源：不让用户逐项选择，登录后一律以云端为准（云端没有时才上传本机）。
export const PREFERENCE_RESOURCES = new Set([
  'holdings/state', 'plans/state', 'dca/state', 'vix/state', 'sell-plans/draft',
  'fund-switch/prefs', 'prefs/workspace', 'prefs/home-dashboard', 'prefs/premium', 'prefs/analytics-opt-out'
]);

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

/** 条目名是否只是内部键（数字、#序号、带 # 的去重键），这类不展示给用户看。 */
export function isOpaqueEntryLabel(label = '', key = '') {
  const text = String(label);
  if (text !== String(key)) return false;
  return /^#?\d+(\.\d+)?$/.test(text) || text.includes('#') || /^[a-z0-9_-]{16,}$/i.test(text);
}

function entryInfo(item, key) {
  const label = entryLabel(item, key);
  return { key, label, opaque: isOpaqueEntryLabel(label, key) };
}

function diffEntryMaps(localMap, remoteMap) {
  const localOnly = [];
  const remoteOnly = [];
  const changed = [];
  for (const [key, item] of localMap) {
    if (!remoteMap.has(key)) localOnly.push(entryInfo(item, key));
    else if (canonicalize(item) !== canonicalize(remoteMap.get(key))) changed.push(entryInfo(item, key));
  }
  for (const [key, item] of remoteMap) {
    if (!localMap.has(key)) remoteOnly.push(entryInfo(item, key));
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
 * 一项差异是否需要用户选择：只有「本机有、云端也有，且本机有云端没有的内容」才问。
 * - 本机为空：云端为准，无需选择；
 * - 云端为空：直接上传本机（auto）；
 * - 本机是云端的子集（只有「仅云端」）：拉取即可，本机不会丢东西；
 * - 偏好类资源：一律以云端为准。
 */
export function classifyDiffItem(item) {
  if (!item) return 'skip';
  if (!item.local?.exists) return 'skip';
  if (!item.remote?.exists) return 'push';
  if (item.kind === 'resource' && PREFERENCE_RESOURCES.has(item.resource)) return 'skip';
  if (item.kind === 'transactions') {
    return item.rows.localOnly.length || item.rows.changed.length ? 'ask' : 'skip';
  }
  const { localOnly, changed, remoteOnly } = item.entries;
  if (!localOnly.length && !changed.length && !remoteOnly.length) return 'ask'; // 非列表数据整体不同
  return localOnly.length || changed.length ? 'ask' : 'skip';
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
  const asked = [];
  const autoItems = [];
  for (const item of items) {
    const kind = classifyDiffItem(item);
    if (kind === 'ask') asked.push(item);
    else if (kind === 'push') autoItems.push(item);
  }
  return { items: asked, autoItems, hasDiff: asked.length > 0 };
}

/** 稳定指纹（djb2），用于记录「上次登录合并时本机数据的样子」。 */
export function fingerprint(value) {
  const text = canonicalize(value);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${hash.toString(36)}`;
}

function txFingerprint(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => txId(a).localeCompare(txId(b)));
  return list.length ? fingerprint(list) : '';
}

/** 本次合并完成后本机数据的指纹。 */
export function buildLoginSyncBaseline(sides = {}) {
  const resources = {};
  for (const [name, raw] of Object.entries(sides.localResources || {})) {
    const value = parseLocalRaw(raw);
    if (!isEmptyValue(value)) resources[name] = fingerprint(value);
  }
  return { resources, transactions: txFingerprint(sides.localTransactions || []), savedAt: new Date().toISOString() };
}

/**
 * 去掉「上次登录已合并过、之后没在本机改过」的本机数据：这些内容已经进过云端，
 * 之后在云端的改动（包括删除）应当直接生效，不应每次登录都再问一遍。
 */
export function applyLoginSyncBaseline(sides = {}, baseline = null) {
  if (!baseline || typeof baseline !== 'object') return sides;
  const localResources = {};
  for (const [name, raw] of Object.entries(sides.localResources || {})) {
    const value = parseLocalRaw(raw);
    if (baseline.resources?.[name] && baseline.resources[name] === fingerprint(value)) continue;
    localResources[name] = raw;
  }
  const sameTx = baseline.transactions && baseline.transactions === txFingerprint(sides.localTransactions || []);
  return { ...sides, localResources, localTransactions: sameTx ? [] : (sides.localTransactions || []) };
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
