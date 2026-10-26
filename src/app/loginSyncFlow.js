// 登录后首次同步的编排：云端为空 → 强制上传本机数据；云端有数据 → 先算差异，
// 无差异直接走原拉取，有差异则交给合并对话框，由用户确认后再执行并启动自动同步。
//
// 注册流程与演示模式保持原逻辑；旧版整包迁移（action-required）由 postAuthSync 先处理，迁移后才进入这里。
import { loadCloudSession } from './authSession.js';
import { isFeatureDemoActive } from './demo/demoMode.js';
import { clearLoginSyncPending, LOGIN_SYNC_DIFF_EVENT, markLoginSyncPending } from './loginSyncGate.js';
import { computeLoginSyncDiff, hasLocalAccountData, hasRemoteAccountData } from './loginSyncDiff.js';
import { applyLoginSyncChoices, DEFAULT_LOGIN_SYNC_DEPS, loadLoginSyncSides } from './loginSyncActions.js';

let pendingDiff = null;
const inFlightByUser = new Map();

function dispatch(name, detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function userIdOf(session) {
  return String(session?.userId || '').trim();
}

/** 当前账号待确认的差异（对话框挂载晚于事件时用来补开）。 */
export function getPendingLoginSyncDiff(session = loadCloudSession()) {
  if (!pendingDiff || pendingDiff.userId !== userIdOf(session)) return null;
  return pendingDiff;
}

export function resetLoginSyncFlowForTest() {
  pendingDiff = null;
}

function finishWithoutDialog() {
  pendingDiff = null;
  clearLoginSyncPending();
}

async function runLegacyFlow(cloudSync, { action, hasRemoteBackup }) {
  // 注册 / 演示模式：保持原逻辑。
  finishWithoutDialog();
  cloudSync.startCloudAutoSync();
  if (hasRemoteBackup) {
    const pulled = await cloudSync.restoreEncryptedCloudBackup();
    dispatch('cloud-sync:auto-restored', { result: pulled });
    return 'pulled';
  }
  if (action === 'register') {
    const uploaded = await cloudSync.uploadEncryptedCloudBackup({ force: true });
    dispatch('cloud-sync:auto-uploaded', { result: uploaded });
    return uploaded?.skipped ? 'skipped-upload' : 'uploaded';
  }
  return 'no-remote';
}

/**
 * 首次同步入口（postAuthSync 调用）。返回值：
 * pulled | uploaded | skipped-upload | no-remote | diff-pending
 */
export function runLoginAccountSync(cloudSync, options = {}) {
  const session = options.session || loadCloudSession();
  // reuseExisting：启动时补跑的检查不打断已弹出/已取消的对话框。
  if (options.reuseExisting && getPendingLoginSyncDiff(session)) return Promise.resolve('diff-pending');
  const key = `${options.action || 'login'}:${userIdOf(session)}`;
  const existing = inFlightByUser.get(key);
  if (existing) return existing;
  const run = runLoginAccountSyncOnce(cloudSync, { ...options, session })
    .finally(() => { inFlightByUser.delete(key); });
  inFlightByUser.set(key, run);
  return run;
}

async function runLoginAccountSyncOnce(cloudSync, {
  action = 'login',
  session,
  assertSession = () => {},
  deps = DEFAULT_LOGIN_SYNC_DEPS,
  demoActive = isFeatureDemoActive()
} = {}) {
  assertSession();
  const remoteMeta = await cloudSync.refreshRemoteCloudMeta();
  const hasRemoteBackup = Boolean(remoteMeta?.version);
  cloudSync.ensureLocalChangeBaseline();
  if (action === 'register' || demoActive) return runLegacyFlow(cloudSync, { action, hasRemoteBackup });

  const userId = userIdOf(session);
  markLoginSyncPending(userId);
  const sides = await loadLoginSyncSides({ session, deps });
  assertSession();

  if (!hasRemoteAccountData(sides)) {
    // 云端为空的老账号：与注册一致，强制上传本机数据；本机也没有数据就跳过。
    finishWithoutDialog();
    if (!hasLocalAccountData(sides)) {
      cloudSync.startCloudAutoSync();
      return 'no-remote';
    }
    deps.resetHoldingSyncState();
    const uploaded = await cloudSync.uploadEncryptedCloudBackup({ force: true });
    dispatch('cloud-sync:auto-uploaded', { result: uploaded });
    cloudSync.startCloudAutoSync();
    return uploaded?.skipped ? 'skipped-upload' : 'uploaded';
  }

  const diff = computeLoginSyncDiff(sides);
  if (!diff.hasDiff) {
    finishWithoutDialog();
    deps.resetHoldingSyncState();
    const pulled = await cloudSync.restoreEncryptedCloudBackup();
    dispatch('cloud-sync:auto-restored', { result: pulled });
    cloudSync.startCloudAutoSync();
    return 'pulled';
  }

  // 有差异：保持门禁（暂停自动同步），等待用户在对话框中选择。
  pendingDiff = { userId, sides, diff, createdAt: new Date().toISOString() };
  dispatch(LOGIN_SYNC_DIFF_EVENT, { userId, diff });
  return 'diff-pending';
}

/** 对话框确认：按选择执行，全部成功后解除门禁并启动自动同步。 */
export async function confirmLoginSync(choices = {}, {
  session = loadCloudSession(),
  deps = DEFAULT_LOGIN_SYNC_DEPS,
  cloudSync = null
} = {}) {
  const current = getPendingLoginSyncDiff(session);
  if (!current) throw new Error('没有待确认的数据同步，或账号已切换，请重新打开同步。');
  const result = await applyLoginSyncChoices({ sides: current.sides, diff: current.diff, choices, session, deps });
  if (userIdOf(loadCloudSession()) !== current.userId) {
    pendingDiff = null;
    throw new Error('账号已切换，本次同步结果未生效。');
  }
  if (result.failed.length) {
    // 部分失败：保持门禁，丢弃旧差异，重试时重新计算。
    pendingDiff = null;
    const error = new Error(`有 ${result.failed.length} 项同步失败：${result.failed[0].label} ${result.failed[0].message}`);
    error.result = result;
    throw error;
  }
  finishWithoutDialog();
  const mod = cloudSync || await import('./cloudSync.js');
  mod.startCloudAutoSync();
  dispatch('cloud-sync:auto-restored', { result });
  return result;
}
