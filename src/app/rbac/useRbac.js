import { useEffect, useState } from 'react';
import { CLOUD_SYNC_SESSION_EVENT, loadCloudSession } from '../authSession.js';
import { RBAC_CHANGED_EVENT, readRbacState, refreshRbac } from './rbacStore.js';

/** 订阅当前用户的菜单 / 角色；挂载与会话变化时向服务端刷新一次（带 60 秒去重）。 */
export function useRbac() {
  const [state, setState] = useState(() => readRbacState());

  useEffect(() => {
    let cancelled = false;
    function handleChanged(event) {
      if (cancelled) return;
      setState(event?.detail?.state || readRbacState());
    }
    function handleSession() {
      setState(readRbacState(loadCloudSession()));
      refreshRbac({ force: true });
    }
    window.addEventListener(RBAC_CHANGED_EVENT, handleChanged);
    window.addEventListener(CLOUD_SYNC_SESSION_EVENT, handleSession);
    refreshRbac();
    return () => {
      cancelled = true;
      window.removeEventListener(RBAC_CHANGED_EVENT, handleChanged);
      window.removeEventListener(CLOUD_SYNC_SESSION_EVENT, handleSession);
    };
  }, []);

  return state;
}
