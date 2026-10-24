import { useEffect, useRef } from 'react';
import { showToast } from '../toast.js';
import { importDemoSessions, isFeatureDemoActive } from './featureDemo.js';

export const DEMO_IMPORTED_TOAST = Object.freeze({ title: '已保留演示内容', description: '演示中保存的内容已带入你的账号。', tone: 'emerald' });

/**
 * 注册 / 升级后：15 分钟内的演示内容自动带入账号（写回真实存储，由云同步推送），带入成功弹提示。
 * canAccessTab(rbac, tab) 需为稳定引用（模块级函数）。importDemoSessions 会同步摘掉待带入的会话，
 * 所以 rbac 变化导致 effect 重跑时不能丢掉上一次的提示：只在组件卸载后不再提示。
 */
export function useDemoSessionImport(rbac, canAccessTab) {
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!rbac?.loggedIn || isFeatureDemoActive()) return;
    (async () => {
      let imported = [];
      try {
        imported = await importDemoSessions({ canAccess: (tab) => canAccessTab(rbac, tab) });
      } catch {
        return; // 带入失败不影响页面；内容仍按 15 分钟过期
      }
      if (mountedRef.current && imported.length) showToast(DEMO_IMPORTED_TOAST);
    })();
  }, [rbac, canAccessTab]);
}
