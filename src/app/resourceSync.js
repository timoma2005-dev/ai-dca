// 账号数据同步引擎 v2：按功能资源做增量同步，不再整包上传/下载，也不再加密。
// 每个资源独立 revision；冲突只发生在单个功能内，服务端回传该资源副本后本地就地合并重试。

import { applyBaseDeletions, isItemMergeKey, readSyncBaseIds, writeSyncBase } from './syncBase.js';
import { applyBackupEnvelope } from './webdavBackup.js';
import { loadCloudSession } from './authSession.js';
import { getClientEnd } from './syncClient.js';
import { keyForResource, listAccountResourceNames, resourceForKey } from './accountResources.js';
import { hashString, mergePayloadValue, mergePayloadValueRemoteWins } from './syncMerge.js';
import {
  deleteAccountResource,
  fetchAccountBundle,
  fetchAccountManifest,
  putAccountResource
} from './accountApi.js';
import { isFeatureDemoActive } from './demo/demoMode.js';
import { isLoginSyncPending, isLoginSyncWriteBlocked } from './loginSyncGate.js';

export const ACCOUNT_SYNC_STATE_KEY = 'aiDcaAccountSyncState';
export const ACCOUNT_SYNC_EVENTS = {
  PUSHED: 'account-sync:pushed',
  PULLED: 'account-sync:pulled',
  ERROR: 'account-sync:error'
};

const PUSH_DEBOUNCE_MS = 2500;
const PULL_DEBOUNCE_MS = 1500;
const PULL_INTERVAL_MS = 60000;

let autoSyncStarted = false;
let pushTimer = null;
let pullTimer = null;
let pushInFlight = false;
let pullInFlight = false;
let suppressWatch = false;
const dirtyResources = new Set();

function storage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function nowIso() {
  return new Date().toISOString();
}

function dispatch(name, detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function safeParse(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return undefined;
  }
}

export function isAccountSyncEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.__AI_DCA_ACCOUNT_SYNC_V2__ === false) return false;
  try {
    if (window.localStorage?.getItem('aiDcaAccountSyncV2') === '0') return false;
  } catch {
    return true;
  }
  return true;
}

export function loadAccountSyncState() {
  const ls = storage();
  if (!ls) return { resources: {} };
  try {
    const parsed = JSON.parse(ls.getItem(ACCOUNT_SYNC_STATE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return { resources: {} };
    return { ...parsed, resources: parsed.resources && typeof parsed.resources === 'object' ? parsed.resources : {} };
  } catch {
    return { resources: {} };
  }
}

function saveAccountSyncState(next = {}) {
  const ls = storage();
  if (!ls) return next;
  const payload = { ...next, savedAt: nowIso() };
  ls.setItem(ACCOUNT_SYNC_STATE_KEY, JSON.stringify(payload));
  return payload;
}

export function readResourceState(resource) {
  const state = loadAccountSyncState();
  const item = state.resources?.[resource];
  return {
    revision: Number(item?.revision || 0),
    contentHash: String(item?.contentHash || ''),
    localHash: String(item?.localHash || ''),
    updatedAt: String(item?.updatedAt || ''),
    deleted: Boolean(item?.deleted)
  };
}

function writeResourceState(resource, patch = {}) {
  const state = loadAccountSyncState();
  const resources = { ...(state.resources || {}) };
  resources[resource] = { ...(resources[resource] || {}), ...patch };
  return saveAccountSyncState({ ...state, resources });
}

export function readLocalResourceRaw(resource) {
  const ls = storage();
  const key = keyForResource(resource);
  if (!ls || !key) return null;
  return ls.getItem(key);
}

// 写入本地：复用 applyBackupEnvelope，以便持仓 / 会员等领域事件能正常广播；期间暂停本地变更监听。
function applyLocalResource(resource, raw) {
  const ls = storage();
  const key = keyForResource(resource);
  if (!ls || !key) return false;
  suppressWatch = true;
  try {
    if (raw === null || raw === undefined) {
      ls.removeItem(key);
    } else {
      applyBackupEnvelope({
        version: 1,
        source: 'ai-dca',
        keyCount: 1,
        keys: [key],
        payload: { [key]: raw }
      }, { wipePrefix: false });
    }
  } finally {
    if (typeof window !== 'undefined') {
      window.setTimeout(() => { suppressWatch = false; }, 0);
    } else {
      suppressWatch = false;
    }
  }
  return true;
}

export async function pushResource(resource, { force = false, session = loadCloudSession(), bypassLoginSyncGate = false } = {}) {
  if (!session?.accessToken) throw new Error('请先登录账户');
  const key = keyForResource(resource);
  if (!key) throw new Error(`未知的同步资源：${resource}`);
  const state = readResourceState(resource);
  const raw = readLocalResourceRaw(resource);

  // 本地已删除：只有「之前同步过」才向云端删除，避免新设备空本地误删云端。
  if (raw === null || raw === undefined) {
    if (!state.revision || state.deleted) return { resource, skipped: true, reason: 'empty' };
    const result = await deleteAccountResource(resource, session, { bypassLoginSyncGate });
    writeResourceState(resource, { revision: result.revision, contentHash: '', localHash: '', updatedAt: result.updatedAt, deleted: true });
    writeSyncBase(session.userId, resource, null);
    return { resource, deleted: true, revision: result.revision };
  }

  const localHash = hashString(raw);
  if (!force && localHash === state.localHash) return { resource, skipped: true, reason: 'unchanged' };
  const data = safeParse(raw);
  if (data === undefined) return { resource, skipped: true, reason: 'invalid-json' };

  try {
    const result = await putAccountResource(resource, {
      data,
      baseRevision: force ? null : state.revision,
      force,
      end: getClientEnd(),
      bypassLoginSyncGate
    }, session);
    writeResourceState(resource, {
      revision: result.revision,
      contentHash: result.contentHash,
      localHash,
      updatedAt: result.updatedAt,
      deleted: false
    });
    writeSyncBase(session.userId, resource, raw);
    return { resource, revision: result.revision, unchanged: Boolean(result.unchanged) };
  } catch (err) {
    if (!err?.isRevisionConflict || !err?.data) throw err;
    // 单功能冲突：本地优先合并（远端独有项保留）后，带服务端 revision 重试一次。
    const remoteData = err.data.data;
    const remoteRaw = remoteData === null || remoteData === undefined ? null : JSON.stringify(remoteData);
    const unionRaw = remoteRaw === null ? raw : mergePayloadValue(key, remoteRaw, raw);
    // 三方合并：基线里有、一边已删除的条目按删除处理（删除优先），不再被并集加回来。
    const mergedRaw = isItemMergeKey(key)
      ? applyBaseDeletions(unionRaw, { key, baseIds: readSyncBaseIds(session.userId, resource), localRaw: raw, remoteRaw })
      : unionRaw;
    if (mergedRaw !== raw) applyLocalResource(resource, mergedRaw);
    const mergedData = safeParse(mergedRaw);
    if (mergedData === undefined) throw err;
    const retry = await putAccountResource(resource, {
      data: mergedData,
      baseRevision: Number(err.data.currentRevision || 0),
      end: getClientEnd(),
      bypassLoginSyncGate
    }, session);
    writeResourceState(resource, {
      revision: retry.revision,
      contentHash: retry.contentHash,
      localHash: hashString(mergedRaw),
      updatedAt: retry.updatedAt,
      deleted: false
    });
    writeSyncBase(session.userId, resource, mergedRaw);
    return { resource, revision: retry.revision, merged: true };
  }
}

export async function pushAllResources({ force = false, resources = null, session = loadCloudSession() } = {}) {
  if (!session?.accessToken) throw new Error('请先登录账户');
  const names = Array.isArray(resources) && resources.length ? resources : listAccountResourceNames();
  const pushed = [];
  const skipped = [];
  const failed = [];
  for (const resource of names) {
    try {
      const result = await pushResource(resource, { force, session });
      if (result.skipped) skipped.push(resource);
      else pushed.push(result);
    } catch (err) {
      failed.push({ resource, message: err?.message || String(err) });
    }
  }
  const state = loadAccountSyncState();
  saveAccountSyncState({ ...state, lastPushAt: nowIso() });
  dispatch(ACCOUNT_SYNC_EVENTS.PUSHED, { pushed, skipped, failed });
  if (failed.length && !pushed.length) {
    const error = new Error(failed[0].message || '上传失败');
    error.failed = failed;
    throw error;
  }
  return { pushed, skipped, failed, updatedAt: nowIso() };
}

export async function pullResources({ resources = null, force = false, session = loadCloudSession(), bypassLoginSyncGate = false } = {}) {
  if (!session?.accessToken) throw new Error('请先登录账户');
  const manifest = await fetchAccountManifest(session);
  const items = Array.isArray(manifest?.resources) ? manifest.resources : [];
  const wanted = Array.isArray(resources) && resources.length ? new Set(resources) : null;
  const toFetch = [];
  const tombstones = [];

  for (const item of items) {
    if (wanted && !wanted.has(item.resource)) continue;
    if (!keyForResource(item.resource)) continue;
    const state = readResourceState(item.resource);
    if (item.deleted) {
      if (state.revision && state.revision !== item.revision) tombstones.push(item);
      continue;
    }
    if (!item.revision) continue;
    const localRaw = readLocalResourceRaw(item.resource);
    const stale = force
      || state.revision !== item.revision
      || state.contentHash !== item.contentHash
      || localRaw === null;
    if (stale) toFetch.push(item);
  }

  const bundle = toFetch.length ? await fetchAccountBundle(toFetch.map((item) => item.resource), session) : { resources: {} };
  const applied = [];
  const reuploaded = [];

  for (const item of toFetch) {
    const entry = bundle?.resources?.[item.resource];
    if (!entry) continue;
    const key = keyForResource(item.resource);
    const remoteRaw = entry.data === null || entry.data === undefined ? null : JSON.stringify(entry.data);
    if (remoteRaw === null) continue;
    const localRaw = readLocalResourceRaw(item.resource);
    // 下行统一走「远端权威 + 保留本地独有」，避免另一端的数据删掉本机独有记录。
    const unionRaw = localRaw == null ? remoteRaw : mergePayloadValueRemoteWins(key, remoteRaw, localRaw);
    // 三方合并：别的设备删掉的条目（基线有、云端没有）不再因本机还留着而被回传复活；本机待上传的删除同理。
    const mergedRaw = localRaw != null && isItemMergeKey(key)
      ? applyBaseDeletions(unionRaw, { key, baseIds: readSyncBaseIds(session.userId, item.resource), localRaw, remoteRaw })
      : unionRaw;
    if (mergedRaw !== localRaw) {
      applyLocalResource(item.resource, mergedRaw);
      applied.push(item.resource);
    }
    writeResourceState(item.resource, {
      revision: entry.revision,
      contentHash: entry.contentHash,
      localHash: hashString(mergedRaw),
      updatedAt: entry.updatedAt,
      deleted: false
    });
    writeSyncBase(session.userId, item.resource, remoteRaw);
    if (mergedRaw !== remoteRaw) {
      // 本机有云端没有的记录 → 回传，让云端补齐。
      const mergedData = safeParse(mergedRaw);
      if (mergedData !== undefined && isLoginSyncWriteBlocked({ session, bypassLoginSyncGate })) {
        // 登录合并待确认：不回传，基线记为云端内容，资源保持 dirty，确认后再上传。
        writeResourceState(item.resource, { localHash: hashString(remoteRaw) });
        dirtyResources.add(item.resource);
      } else if (mergedData !== undefined) {
        const result = await putAccountResource(item.resource, {
          data: mergedData,
          baseRevision: entry.revision,
          end: getClientEnd(),
          bypassLoginSyncGate
        }, session);
        writeResourceState(item.resource, {
          revision: result.revision,
          contentHash: result.contentHash,
          localHash: hashString(mergedRaw),
          updatedAt: result.updatedAt,
          deleted: false
        });
        writeSyncBase(session.userId, item.resource, mergedRaw);
        reuploaded.push(item.resource);
      }
    }
  }

  for (const item of tombstones) {
    applyLocalResource(item.resource, null);
    writeSyncBase(session.userId, item.resource, null);
    writeResourceState(item.resource, {
      revision: item.revision,
      contentHash: '',
      localHash: '',
      updatedAt: item.updatedAt,
      deleted: true
    });
  }

  const state = loadAccountSyncState();
  saveAccountSyncState({ ...state, lastPullAt: nowIso(), lastManifestAt: manifest?.serverTime || nowIso() });
  dispatch(ACCOUNT_SYNC_EVENTS.PULLED, { applied, reuploaded, tombstones: tombstones.map((item) => item.resource) });
  return {
    applied,
    reuploaded,
    tombstones: tombstones.map((item) => item.resource),
    restoredKeyCount: applied.length,
    manifest
  };
}

export async function syncAllResources({ direction = 'both', force = false, session = loadCloudSession() } = {}) {
  const pulled = direction === 'push' ? null : await pullResources({ force, session });
  const pushedResult = direction === 'pull' ? null : await pushAllResources({ force, session });
  return { pulled, pushed: pushedResult };
}

export function getAccountSyncSummary() {
  const state = loadAccountSyncState();
  const resources = state.resources || {};
  const synced = Object.entries(resources).filter(([, item]) => Number(item?.revision || 0) > 0 && !item?.deleted);
  const updatedAtList = synced.map(([, item]) => String(item?.updatedAt || '')).filter(Boolean).sort();
  return {
    resourceCount: synced.length,
    lastPullAt: state.lastPullAt || '',
    lastPushAt: state.lastPushAt || '',
    remoteUpdatedAt: updatedAtList[updatedAtList.length - 1] || '',
    pendingResources: Array.from(dirtyResources)
  };
}

export function markResourceDirty(resource) {
  if (!resource) return false;
  dirtyResources.add(resource);
  return true;
}

export function markAllResourcesDirty() {
  listAccountResourceNames().forEach((resource) => dirtyResources.add(resource));
}

async function runPush() {
  // 功能演示中不推送（读到的是演示存储覆盖层）；待推送资源留到演示结束后再推。
  if (isFeatureDemoActive() || isLoginSyncPending()) {
    scheduleAccountPush({ delay: PULL_INTERVAL_MS });
    return;
  }
  if (pushInFlight || pullInFlight) {
    scheduleAccountPush({ delay: 800 });
    return;
  }
  const session = loadCloudSession();
  if (!session?.accessToken) return;
  const resources = Array.from(dirtyResources);
  if (!resources.length) return;
  dirtyResources.clear();
  pushInFlight = true;
  try {
    await pushAllResources({ resources, session });
  } catch (err) {
    resources.forEach((resource) => dirtyResources.add(resource));
    dispatch(ACCOUNT_SYNC_EVENTS.ERROR, { phase: 'push', message: err?.message || String(err) });
  } finally {
    pushInFlight = false;
  }
}

async function runPull() {
  // 功能演示中不拉取（不把账号数据并进演示覆盖层，也不触发回传）。
  if (pushInFlight || pullInFlight || suppressWatch || isFeatureDemoActive() || isLoginSyncPending()) return;
  const session = loadCloudSession();
  if (!session?.accessToken) return;
  pullInFlight = true;
  try {
    await pullResources({ session });
  } catch (err) {
    dispatch(ACCOUNT_SYNC_EVENTS.ERROR, { phase: 'pull', message: err?.message || String(err) });
  } finally {
    pullInFlight = false;
  }
}

export function scheduleAccountPush({ delay = PUSH_DEBOUNCE_MS } = {}) {
  if (typeof window === 'undefined') return false;
  const session = loadCloudSession();
  if (!session?.accessToken) return false;
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => { runPush(); }, delay);
  return true;
}

export function scheduleAccountPull({ delay = PULL_DEBOUNCE_MS } = {}) {
  if (typeof window === 'undefined') return false;
  const session = loadCloudSession();
  if (!session?.accessToken) return false;
  window.clearTimeout(pullTimer);
  pullTimer = window.setTimeout(() => { runPull(); }, delay);
  return true;
}

function observeStorageKey(key) {
  if (suppressWatch) return false;
  const descriptor = resourceForKey(key);
  if (!descriptor) return false;
  dirtyResources.add(descriptor.resource);
  scheduleAccountPush();
  return true;
}

export function startAccountAutoSync() {
  if (typeof window === 'undefined' || !window.localStorage || !window.Storage) return false;
  if (autoSyncStarted || !isAccountSyncEnabled()) return false;
  autoSyncStarted = true;

  const proto = window.Storage.prototype;
  const originalSetItem = proto.setItem;
  const originalRemoveItem = proto.removeItem;
  const originalClear = proto.clear;

  proto.setItem = function patchedSetItem(key, value) {
    const before = this === window.localStorage ? this.getItem(key) : null;
    const result = originalSetItem.call(this, key, value);
    if (this === window.localStorage && before !== String(value)) observeStorageKey(key);
    return result;
  };
  proto.removeItem = function patchedRemoveItem(key) {
    const had = this === window.localStorage && this.getItem(key) !== null;
    const result = originalRemoveItem.call(this, key);
    if (had) observeStorageKey(key);
    return result;
  };
  proto.clear = function patchedClear() {
    const result = originalClear.call(this);
    if (this === window.localStorage) {
      markAllResourcesDirty();
      scheduleAccountPush();
    }
    return result;
  };

  window.addEventListener('storage', (event) => {
    if (event?.key) observeStorageKey(event.key);
  });
  window.addEventListener('visibilitychange', () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') scheduleAccountPull();
  });
  window.addEventListener('focus', () => scheduleAccountPull());
  window.setInterval(() => scheduleAccountPull({ delay: 0 }), PULL_INTERVAL_MS);
  scheduleAccountPull({ delay: PULL_DEBOUNCE_MS });
  return true;
}
