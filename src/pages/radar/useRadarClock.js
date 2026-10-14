import { useEffect, useState } from 'react';

/**
 * 秒级本地时钟（plan §3.2.4）：
 * - 只在启用（管理员且雷达 Tab 活跃，由挂载与 props 保证）时运行；
 * - 每次 tick 从最新 Date.now() 重算，不逐秒减计数；
 * - 回到前台（visibilitychange → visible）立即重算并重启 tick；
 * - 卸载清理 timer 与监听；
 * - 到零、秒级 tick 与时段切换都不触发任何 GET / POST（本 hook 不发请求）。
 */
export function useRadarClock({ enabled = false } = {}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    const tick = () => setNow(Date.now());
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        tick();
        schedule();
      }, 1000);
    };
    tick();
    schedule();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        tick();
        schedule();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled]);

  return now;
}

export default useRadarClock;
