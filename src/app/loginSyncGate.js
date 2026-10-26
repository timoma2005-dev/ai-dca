// 登录后「本地数据合并」门禁：登录一个账号后，在用户确认合并方式前，
// 禁止任何自动同步（拉取/推送）把本机数据静默并入该账号或用云端覆盖本机。
//
// - 门禁按 userId 持久化在 localStorage，页面刷新、切账号后依然有效；
// - 只对当前登录会话的 userId 生效：A 的门禁不会挡住 B，B 登录时重新设置；
// - 门禁由 loginSyncFlow 在用户确认（或无差异 / 云端为空自动处理）后解除。
import { loadCloudSession } from './authSession.js';

export const LOGIN_SYNC_PENDING_KEY = 'aiDcaLoginSyncPending';
export const LOGIN_SYNC_DIFF_EVENT = 'cloud-sync:login-diff';
export const LOGIN_SYNC_STATE_EVENT = 'cloud-sync:login-diff-state';

function storage() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function dispatchState(pending) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LOGIN_SYNC_STATE_EVENT, { detail: { pending } }));
}

export function readLoginSyncPending() {
  const ls = storage();
  if (!ls) return null;
  try {
    const parsed = JSON.parse(ls.getItem(LOGIN_SYNC_PENDING_KEY) || 'null');
    return parsed && typeof parsed === 'object' && parsed.userId ? parsed : null;
  } catch {
    return null;
  }
}

export function markLoginSyncPending(userId) {
  const ls = storage();
  const id = String(userId || '').trim();
  if (!ls || !id) return false;
  ls.setItem(LOGIN_SYNC_PENDING_KEY, JSON.stringify({ userId: id, since: new Date().toISOString() }));
  dispatchState(true);
  return true;
}

export function clearLoginSyncPending() {
  const ls = storage();
  if (!ls) return false;
  const had = ls.getItem(LOGIN_SYNC_PENDING_KEY) !== null;
  ls.removeItem(LOGIN_SYNC_PENDING_KEY);
  if (had) dispatchState(false);
  return had;
}

export const LOGIN_SYNC_BLOCKED_CODE = 'LOGIN_SYNC_PENDING';
export const LOGIN_SYNC_BLOCKED_MESSAGE = '数据未同步，处理数据同步后会上传';

/** 当前登录会话是否仍在等待用户确认合并方式（等待期间自动同步一律暂停）。 */
export function isLoginSyncPending(session = loadCloudSession()) {
  const userId = String(session?.userId || '').trim();
  if (!userId) return false;
  return readLoginSyncPending()?.userId === userId;
}

// 门禁打开期间，所有向云端的写入（交易行 PUT/DELETE、资源 PUT/PATCH/DELETE）都在
// 最底层的 API 出口统一拦截：改动只留在本地并保持 dirty/pending。
// 只有确认流程（loginSyncActions 执行用户选择）显式传 bypassLoginSyncGate 才能推送。
export function isLoginSyncWriteBlocked({ session, bypassLoginSyncGate = false } = {}) {
  return !bypassLoginSyncGate && isLoginSyncPending(session || loadCloudSession());
}

export function isLoginSyncBlockedError(error) {
  return error?.code === LOGIN_SYNC_BLOCKED_CODE;
}

export function assertLoginSyncWriteAllowed(options = {}) {
  if (!isLoginSyncWriteBlocked(options)) return;
  const error = new Error(LOGIN_SYNC_BLOCKED_MESSAGE);
  error.code = LOGIN_SYNC_BLOCKED_CODE;
  error.loginSyncBlocked = true;
  throw error;
}
