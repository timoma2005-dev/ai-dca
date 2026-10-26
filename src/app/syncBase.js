// 三方合并基线：记录每个资源「上次与云端一致时」有哪些条目 id（按账号 + 资源隔离）。
// 合并时据此区分「对方删除了」和「我新增了」，删除优先，避免被删的条目在另一端合并时又被加回来。
// 只存 id，不存内容；没有基线（首次同步 / 基线丢失 / 登录选择后重置）时退化为原来的并集合并。
import { keyForResource } from './accountResources.js';
import { getMergeStrategy } from './syncRegistry.js';

const BASE_PREFIX = 'aiDcaResourceSyncBase:v1';
// 条目内部还按并集合并的子列表（自选清单 lists[].us/cn），删除同样要识别。
const NESTED_PROPS = Object.freeze({ watchlist: ['us', 'cn'] });

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

// 与 syncMerge 的 mergeRecordsById 保持一致：对象只认 id（没有 id 的记录合并时本就会被丢弃）。
function itemKey(item) {
  if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
  if (!item || typeof item !== 'object' || item.id === undefined || item.id === null) return '';
  return String(item.id).trim();
}

function parse(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function nestedPropsFor(key) {
  return NESTED_PROPS[getMergeStrategy(key)] || [];
}

/** 支持三方删除合并的策略（lww 整体覆盖，不需要）。 */
export function isItemMergeKey(key) {
  const strategy = getMergeStrategy(key);
  return Boolean(strategy && strategy !== 'lww');
}

function forEachList(value, visit) {
  if (Array.isArray(value)) visit(value, ':', (next) => next);
  else if (value && typeof value === 'object') {
    const out = { ...value };
    for (const [prop, child] of Object.entries(value)) {
      if (Array.isArray(child)) visit(child, `${prop}:`, (next) => { out[prop] = next; });
    }
    return out;
  }
  return value;
}

/** 收集条目 id：顶层数组，或对象里一层的数组（plans、lists…），格式为 `prop:id`；子列表为 `prop:id/sub:id`。 */
export function collectItemIds(raw, key = '') {
  const nested = nestedPropsFor(key);
  const ids = new Set();
  const addList = (list, prefix) => {
    for (const item of list) {
      const id = itemKey(item);
      if (!id) continue;
      ids.add(`${prefix}${id}`);
      if (typeof item !== 'object') continue;
      for (const prop of nested) if (Array.isArray(item[prop])) addList(item[prop], `${prefix}${id}/${prop}:`);
    }
  };
  forEachList(parse(raw), (list, prefix) => addList(list, prefix));
  return ids;
}

function pruneList(list, prefix, removed, nested) {
  return list
    .filter((item) => {
      const id = itemKey(item);
      return !id || !removed.has(`${prefix}${id}`);
    })
    .map((item) => {
      const id = itemKey(item);
      if (!id || !item || typeof item !== 'object') return item;
      let next = item;
      for (const prop of nested) {
        if (!Array.isArray(item[prop])) continue;
        if (next === item) next = { ...item };
        next[prop] = pruneList(item[prop], `${prefix}${id}/${prop}:`, removed, []);
      }
      return next;
    });
}

function removeIds(value, removed, nested) {
  let result = value;
  const out = forEachList(value, (list, prefix, assign) => {
    const next = pruneList(list, prefix, removed, nested);
    if (Array.isArray(value)) result = next;
    else assign(next);
  });
  return Array.isArray(value) ? result : out;
}

/**
 * 在合并结果上应用删除：基线里有、但本机或云端任一边已经没有的条目 → 视为被删除，从结果里去掉。
 * baseIds 为空（首次同步 / 基线丢失）时原样返回。
 */
export function applyBaseDeletions(mergedRaw, { key = '', baseIds, localRaw, remoteRaw } = {}) {
  if (!baseIds || !baseIds.size || mergedRaw === null || mergedRaw === undefined) return mergedRaw;
  const localIds = localRaw == null ? null : collectItemIds(localRaw, key);
  const remoteIds = remoteRaw == null ? null : collectItemIds(remoteRaw, key);
  const removed = new Set();
  for (const id of baseIds) {
    if ((localIds && !localIds.has(id)) || (remoteIds && !remoteIds.has(id))) removed.add(id);
  }
  if (!removed.size) return mergedRaw;
  const value = parse(mergedRaw);
  if (value === undefined) return mergedRaw;
  const next = JSON.stringify(removeIds(value, removed, nestedPropsFor(key)));
  return next === JSON.stringify(value) ? mergedRaw : next;
}

function baseStorageKey(userId, resource) {
  return `${BASE_PREFIX}:${String(userId || 'anon')}:${resource}`;
}

export function readSyncBaseIds(userId, resource) {
  try {
    const raw = storage()?.getItem(baseStorageKey(userId, resource));
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? new Set(list.map(String)) : null;
  } catch {
    return null;
  }
}

export function writeSyncBase(userId, resource, raw) {
  try {
    const ls = storage();
    if (!ls) return;
    if (raw === null || raw === undefined) ls.removeItem(baseStorageKey(userId, resource));
    else ls.setItem(baseStorageKey(userId, resource), JSON.stringify(Array.from(collectItemIds(raw, keyForResource(resource)))));
  } catch {
    // 基线写不进去（配额满等）只影响删除识别，退化为并集合并。
  }
}

/** 登录时用户选了「本机覆盖云端 / 改用云端 / 合并」：旧基线不再代表本机数据，清掉后按原方式合并。 */
export function resetSyncBase(userId, resource) {
  writeSyncBase(userId, resource, null);
}
