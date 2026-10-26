// 弹窗互斥：全局确认弹窗（删除等）打开期间，登录数据同步弹窗不弹出 / 不叠加，
// 等确认弹窗关闭后再按需出现，避免取消确认后残留一层同步弹窗。
let confirmOpen = false;
const listeners = new Set();

export function setBlockingConfirmOpen(open) {
  const next = Boolean(open);
  if (next === confirmOpen) return;
  confirmOpen = next;
  listeners.forEach((listener) => listener(confirmOpen));
}

export function isBlockingConfirmOpen() {
  return confirmOpen;
}

export function subscribeBlockingConfirm(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 登录同步弹窗是否应在收到差异事件时弹出：只在登录流程 / 用户主动打开时弹（silent=false），
 * 启动时后台补跑的检查（silent=true）只记录待处理，由账户菜单「处理数据同步」入口打开。
 */
export function shouldAutoOpenLoginSync(detail = {}) {
  return !detail?.silent;
}
