import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildOnboardingTasks } from './catalog.js';
import { readOnboardingSignals } from './signals.js';
import { ONBOARDING_CHANGED_EVENT, currentOnboardingAccount, readOnboardingState } from './state.js';

const SESSION_EVENT = 'cloud-sync:session-changed';
const REFRESH_MS = 10000;

/**
 * 任务卡状态：账号分区的教程进度 + 真实数据信号。
 * 登录 / 退出、其它标签页修改、云同步恢复（定期重读）都会刷新。
 */
export function useOnboarding({ loggedIn, accessOf, enabled = true } = {}) {
  const [snapshot, setSnapshot] = useState(() => ({
    account: currentOnboardingAccount(),
    state: readOnboardingState(),
    signals: readOnboardingSignals()
  }));

  const refresh = useCallback(() => {
    setSnapshot({ account: currentOnboardingAccount(), state: readOnboardingState(), signals: readOnboardingSignals() });
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    refresh();
    const onStorage = (event) => {
      if (!event?.key || event.key.startsWith('aiDca')) refresh();
    };
    window.addEventListener(ONBOARDING_CHANGED_EVENT, refresh);
    window.addEventListener(SESSION_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      window.removeEventListener(ONBOARDING_CHANGED_EVENT, refresh);
      window.removeEventListener(SESSION_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  const tasks = useMemo(
    () => buildOnboardingTasks({ loggedIn, signals: snapshot.signals, state: snapshot.state, accessOf }),
    [loggedIn, snapshot, accessOf]
  );

  return { ...snapshot, tasks, refresh };
}
