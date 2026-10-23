export const ACCOUNT_MENU_RELOAD_KEY = 'aiDcaAccountMenuReload_v1';

// 仅用于账户菜单：旧页面的 chunk 失效时重试一次，再至多重载当前标签页一次。
export async function loadAccountMenu(importModule, {
  getSessionStorage = () => (typeof window === 'undefined' ? null : window.sessionStorage),
  reload = () => window.location.reload(),
} = {}) {
  try {
    return await importModule();
  } catch {
    try {
      return await importModule();
    } catch (error) {
      try {
        const storage = getSessionStorage();
        if (storage && !storage.getItem(ACCOUNT_MENU_RELOAD_KEY)) {
          // 必须先持久化标记；成功加载也不清除，避免同一 session 反复重载。
          storage.setItem(ACCOUNT_MENU_RELOAD_KEY, '1');
          reload();
        }
      } catch {
        // 无法持久化防循环标记时不自动重载；保留原始导入错误。
      }
      throw error;
    }
  }
}
