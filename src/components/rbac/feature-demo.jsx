import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Coffee, LogIn, PlayCircle } from 'lucide-react';
import { DEMO_READONLY_MESSAGE, DEMO_RETAIN_MS, demoBannerNote, demoLimitOf, installFeatureDemo, loadDemoModule } from '../../app/demo/featureDemo.js';
import { showToast } from '../../app/toast.js';
import { DEMO_ACTIVE_FLAG } from '../../app/demo/demoMode.js';
import { FeatureDemoContext } from './demo-lock.jsx';

const RETAIN_MINUTES = Math.round(DEMO_RETAIN_MS / 60000);

function formatClock(totalSec) {
  const sec = Math.max(0, Math.ceil(totalSec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * 付费功能演示外壳：先安装沙箱（存储覆盖层 + fetch 拦截 / mock），再渲染真实页面；顶部常驻演示条。
 * 限制方式见 featureDemo.js 的 limit：只有 time 类显示倒计时并在到时弹出结束弹窗；count / save 类不计时。
 * 结束演示（按钮 / 到时 / 离开 tab / 刷新）：卸载沙箱（keepKeys 内容保留 15 分钟）并刷新页面，丢弃内存状态。
 * 布局：外层 flex 列 + h-full，内容区 flex-1 可滚动，兼容行情这类自带 h-full 布局的页面。
 * 内容区自带 Suspense：lazy 页面首次挂起时不会让外层 Suspense 隐藏本组件（隐藏会触发 layout effect 清理、卸载沙箱）；
 * 渲染 children 前同时要求 ready 且全局沙箱 flag 仍是本 tab，沙箱被卸载后绝不在无 mock 的环境里渲染页面。
 */
export function FeatureDemo({ tab, label = '', roleLabel = 'VIP', guest = false, onUpgrade, children }) {
  const limitInfo = demoLimitOf(tab);
  const envRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [left, setLeft] = useState(limitInfo.durationSec);
  const [ended, setEnded] = useState(false);
  const context = useMemo(
    () => ({ tab, limit: limitInfo.limit, visibleRows: limitInfo.visibleRows, guest, roleLabel, onUpgrade }),
    [tab, limitInfo.limit, limitInfo.visibleRows, guest, roleLabel, onUpgrade]
  );

  useLayoutEffect(() => {
    let lastToast = 0;
    let cancelled = false;
    // 先加载该功能的 mock 模块，再安装沙箱、渲染页面（页面首个请求就能命中 mock）。
    loadDemoModule(tab).catch(() => ({})).then((mod) => {
      if (cancelled) return;
      envRef.current = installFeatureDemo(tab, {
        module: mod,
        onBlocked: () => {
          const now = Date.now();
          if (now - lastToast < 3000) return;
          lastToast = now;
          showToast({ title: '演示模式', description: DEMO_READONLY_MESSAGE, tone: 'amber' });
        },
      });
      setReady(true);
    });
    const onUnload = () => envRef.current?.uninstall();
    window.addEventListener('pagehide', onUnload);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onUnload);
      const env = envRef.current;
      envRef.current = null;
      env?.uninstall();
      setReady(false);
      // 演示期间有写入：刷新页面，丢弃各模块里的内存状态。
      if (env?.dirty) window.setTimeout(() => window.location.reload(), 0);
    };
  }, [tab]);

  // 计时只作用于 time 类。
  useEffect(() => {
    if (!limitInfo.timed || !ready || ended) return undefined;
    const startedAt = Date.now();
    const total = limitInfo.durationSec;
    const timer = window.setInterval(() => {
      const remain = total - (Date.now() - startedAt) / 1000;
      setLeft(remain);
      if (remain <= 0) setEnded(true);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [limitInfo.timed, ready, ended, limitInfo.durationSec]);

  function exitDemo() {
    envRef.current?.uninstall();
    envRef.current = null;
    window.location.reload();
  }

  const live = ready && typeof window !== 'undefined' && window[DEMO_ACTIVE_FLAG] === tab;
  const ctaShort = guest ? '注册' : '升级';
  const ctaLong = guest ? '免费注册，领 3 个月 VIP' : '打赏开通';
  const CtaIcon = guest ? LogIn : Coffee;
  const status = limitInfo.timed ? `剩余 ${formatClock(left)}` : limitInfo.limit === 'count' ? '部分数据' : '不限时';

  return (
    <FeatureDemoContext.Provider value={context}>
      <div className="flex h-full min-h-0 flex-col" data-testid="feature-demo" data-demo-limit={limitInfo.limit}>
        <div className="sticky top-0 z-30 mx-3 mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs shadow-sm backdrop-blur sm:mx-6">
          <PlayCircle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0 flex-1 leading-5">
            <div>
              <span className="font-bold text-amber-900">演示模式</span>
              <span className="text-amber-800" data-testid="feature-demo-status"> · {status}</span>
            </div>
            <div className="text-[11px] leading-4 text-amber-700" data-testid="feature-demo-retain">{demoBannerNote(limitInfo, { guest, roleLabel })}</div>
          </div>
          {onUpgrade ? (
            <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 font-bold text-white hover:bg-amber-600" onClick={() => onUpgrade()}>
              <CtaIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {ctaShort}
            </button>
          ) : null}
          <button type="button" className="shrink-0 rounded-lg border border-amber-300 px-2 py-1 font-semibold text-amber-800 hover:bg-amber-100" onClick={exitDemo} data-testid="feature-demo-exit">
            结束演示
          </button>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          <Suspense fallback={<p className="p-5 text-center text-xs text-slate-400">正在加载演示…</p>}>{live ? children : null}</Suspense>
        </div>
        {ended ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-6" role="dialog" aria-modal="true" data-testid="feature-demo-ended">
            <div className="w-full max-w-xs rounded-2xl bg-white p-5 text-center shadow-xl">
              <h3 className="text-base font-bold text-slate-900">演示结束</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500 [text-wrap:balance]">
                {guest
                  ? '免费注册送 3 个月 VIP，行情、换基、通知都能直接用。'
                  : `喜欢${label ? `「${label}」` : '这个功能'}的话，开通 ${roleLabel} 后就能一直使用。`}
              </p>
              {limitInfo.keeps ? <p className="mt-1 text-xs leading-5 text-amber-700 [text-wrap:balance]">演示内容保留 {RETAIN_MINUTES} 分钟，{guest ? '注册' : '升级'}后自动带入你的账号。</p> : null}
              {onUpgrade ? (
                <button type="button" className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-amber-600" onClick={() => onUpgrade()}>
                  <CtaIcon className="h-4 w-4" aria-hidden="true" />
                  {ctaLong}
                </button>
              ) : null}
              <button type="button" className="mt-2 w-full rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-800" onClick={exitDemo}>
                退出演示
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </FeatureDemoContext.Provider>
  );
}
