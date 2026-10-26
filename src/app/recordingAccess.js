// 录入门槛：未登录用户第一次录入数据时，二选一——登录（多端同步）或仅在本机使用（不同步）。
// 选了「仅在本机使用」会记在本机，以后不再询问；之后登录时会提示「用本机数据覆盖云端」。
import { isRemoteAccountSessionActive } from './accountRuntimeStore.js';
import { isFeatureDemoActive } from './demo/demoMode.js';

export const LOCAL_ONLY_MODE_KEY = 'aiDcaLocalOnlyMode:v1';
export const RECORDING_ACCESS_EVENT = 'ai-dca:recording-access-request';

let pendingRequest = null;

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function isLocalOnlyModeChosen() {
  try {
    return Boolean(storage()?.getItem(LOCAL_ONLY_MODE_KEY));
  } catch {
    return false;
  }
}

export function setLocalOnlyMode(enabled = true) {
  try {
    if (enabled) storage()?.setItem(LOCAL_ONLY_MODE_KEY, JSON.stringify({ chosenAt: new Date().toISOString() }));
    else storage()?.removeItem(LOCAL_ONLY_MODE_KEY);
  } catch {
    // 忽略存储失败：最坏情况是下次再问一次。
  }
}

export function canRecordWithoutPrompt({ sessionActive = isRemoteAccountSessionActive(), demoActive = isFeatureDemoActive() } = {}) {
  return Boolean(sessionActive || demoActive || isLocalOnlyModeChosen());
}

/** 当前待回答的请求（对话框挂载晚于请求时补开）。 */
export function getPendingRecordingAccessRequest() {
  return pendingRequest;
}

/**
 * 录入前调用。已登录 / 演示中 / 已选本机模式 → 直接 true；
 * 否则弹出选择框：选「仅在本机使用」→ true；选「登录」或关闭 → false（调用方中止本次录入）。
 */
export function requestRecordingAccess({ source = '' } = {}) {
  if (canRecordWithoutPrompt()) return Promise.resolve(true);
  if (typeof window === 'undefined') return Promise.resolve(true);
  if (pendingRequest) return pendingRequest.promise;
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  pendingRequest = { source: String(source || ''), promise, resolve };
  window.dispatchEvent(new CustomEvent(RECORDING_ACCESS_EVENT, { detail: { source } }));
  return promise;
}

export function resolveRecordingAccess(allowed) {
  const current = pendingRequest;
  pendingRequest = null;
  current?.resolve(Boolean(allowed));
}
