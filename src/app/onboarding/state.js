// 新手入门进度：按账号分区的 localStorage（游客单独一份）。
// 只记录「教程」状态（关闭、看过演示、手动完成标记）；任务是否真正完成由 signals.js 读取真实数据判断。
// 不依赖 authSession / 业务模块，方便被同步、自选等底层模块直接调用 markOnboardingTask。

export const ONBOARDING_VERSION = 1;
export const ONBOARDING_STORAGE_PREFIX = `aiDcaOnboarding:v${ONBOARDING_VERSION}:`;
export const ONBOARDING_CHANGED_EVENT = 'onboarding:changed';
export const ONBOARDING_OPEN_EVENT = 'onboarding:open';
export const ONBOARDING_START_EVENT = 'onboarding:start';
// 游客「先看看」：直接进入付费功能演示，再在演示里跑一遍步骤提示（detail: { tab, flow }）。
export const ONBOARDING_START_DEMO_EVENT = 'onboarding:start-demo';
const SESSION_KEY = 'aiDcaCloudSyncSession';

function storage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 当前账号分区名：已登录用小写用户名，否则 guest。 */
export function currentOnboardingAccount(ls = storage()) {
  try {
    const session = JSON.parse(ls?.getItem(SESSION_KEY) || 'null');
    const name = session?.accessToken ? String(session.username || '').trim().toLowerCase() : '';
    return name || 'guest';
  } catch {
    return 'guest';
  }
}

export function emptyOnboardingState() {
  return { dismissed: false, celebrated: false, seenDemo: false, done: {} };
}

export function normalizeOnboardingState(raw) {
  const base = emptyOnboardingState();
  if (!raw || typeof raw !== 'object') return base;
  const done = {};
  if (raw.done && typeof raw.done === 'object') {
    for (const [task, at] of Object.entries(raw.done)) {
      const ts = Number(at);
      if (task && Number.isFinite(ts) && ts > 0) done[task] = ts;
    }
  }
  return {
    dismissed: Boolean(raw.dismissed),
    celebrated: Boolean(raw.celebrated),
    seenDemo: Boolean(raw.seenDemo),
    done
  };
}

export function readOnboardingState(account = currentOnboardingAccount(), ls = storage()) {
  try {
    return normalizeOnboardingState(JSON.parse(ls?.getItem(ONBOARDING_STORAGE_PREFIX + account) || 'null'));
  } catch {
    return emptyOnboardingState();
  }
}

function emitChanged(account, state) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent(ONBOARDING_CHANGED_EVENT, { detail: { account, state } }));
  } catch {
    // CustomEvent 不可用时忽略
  }
}

export function writeOnboardingState(patch = {}, account = currentOnboardingAccount(), ls = storage()) {
  const current = readOnboardingState(account, ls);
  const next = normalizeOnboardingState({
    ...current,
    ...patch,
    done: { ...current.done, ...(patch.done || {}) }
  });
  try {
    ls?.setItem(ONBOARDING_STORAGE_PREFIX + account, JSON.stringify(next));
  } catch {
    // 配额不足时忽略，教程状态不是关键数据
  }
  emitChanged(account, next);
  return next;
}

/** 业务动作成功后调用（保存切换方案、发送测试通知、加入自选）。重复调用不会改变首次完成时间。 */
export function markOnboardingTask(task, { now = Date.now(), account = currentOnboardingAccount(), ls = storage() } = {}) {
  if (!task) return null;
  // 付费功能演示里的「保存 / 测试」是模拟数据，不计入真实账号进度。
  if (typeof window !== 'undefined' && window.__AI_DCA_FEATURE_DEMO__) return null;
  const current = readOnboardingState(account, ls);
  if (current.done[task]) return current;
  return writeOnboardingState({ done: { [task]: now } }, account, ls);
}

// 当前是否有步骤提示在展示：注册提示等其它弹层据此让路（同一时刻只出现一个主要提示）。
let hintActive = false;
export function setOnboardingHintActive(value) {
  hintActive = Boolean(value);
}
export function isOnboardingHintActive() {
  return hintActive;
}
