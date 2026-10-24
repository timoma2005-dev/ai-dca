import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Coffee, PlayCircle, X } from 'lucide-react';
import { DEMO_FEATURES, DEMO_READONLY_MESSAGE, installFeatureDemo } from '../../app/demo/featureDemo.js';
import { showToast } from '../../app/toast.js';

function formatClock(totalSec) {
  const sec = Math.max(0, Math.ceil(totalSec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * 付费功能演示外壳：先安装沙箱（存储覆盖层 + fetch 拦截），再渲染真实页面；顶部常驻演示条与倒计时。
 * 退出 / 到时：卸载沙箱并刷新页面，丢弃演示期间的内存状态，保证不会污染真实数据。
 */
export function FeatureDemo({ tab, label = '', roleLabel = 'VIP', onUpgrade, children }) {
  const feature = DEMO_FEATURES[tab] || { durationSec: 300 };
  const envRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [left, setLeft] = useState(feature.durationSec);
  const [ended, setEnded] = useState(false);

  useLayoutEffect(() => {
    let lastToast = 0;
    envRef.current = installFeatureDemo(tab, {
      onBlocked: () => {
        const now = Date.now();
        if (now - lastToast < 3000) return;
        lastToast = now;
        showToast({ title: '演示模式', description: DEMO_READONLY_MESSAGE, tone: 'amber' });
      },
    });
    setReady(true);
    return () => {
      const env = envRef.current;
      envRef.current = null;
      env?.uninstall();
      // 演示期间有写入：刷新页面，丢弃各模块里的内存状态。
      if (env?.dirty) window.setTimeout(() => window.location.reload(), 0);
    };
  }, [tab]);

  useEffect(() => {
    if (!ready || ended) return undefined;
    const startedAt = Date.now();
    const total = feature.durationSec;
    const timer = window.setInterval(() => {
      const remain = total - (Date.now() - startedAt) / 1000;
      setLeft(remain);
      if (remain <= 0) setEnded(true);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ready, ended, feature.durationSec]);

  function exitDemo() {
    envRef.current?.uninstall();
    envRef.current = null;
    window.location.reload();
  }

  return (
    <div className="relative" data-testid="feature-demo">
      <div className="sticky top-0 z-30 mx-3 mb-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs shadow-sm backdrop-blur sm:mx-6">
        <PlayCircle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1 leading-5">
          <span className="font-bold text-amber-900">演示模式</span>
          <span className="text-amber-800"> · 剩余 {formatClock(left)}</span>
          <span className="hidden text-amber-700 sm:inline"> · 操作不会保存</span>
        </div>
        {onUpgrade ? (
          <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 font-bold text-white hover:bg-amber-600" onClick={() => onUpgrade()}>
            <Coffee className="h-3.5 w-3.5" aria-hidden="true" />
            开通
          </button>
        ) : null}
        <button type="button" aria-label="退出演示" className="shrink-0 rounded-lg p-1 text-amber-700 hover:bg-amber-100" onClick={exitDemo}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {ready ? children : null}
      {ended ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-6" role="dialog" aria-modal="true" data-testid="feature-demo-ended">
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 text-center shadow-xl">
            <h3 className="text-base font-bold text-slate-900">演示结束</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500 [text-wrap:balance]">喜欢{label ? `「${label}」` : '这个功能'}的话，开通 {roleLabel} 后就能一直使用，数据也会保存在你的账号里。</p>
            {onUpgrade ? (
              <button type="button" className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-amber-600" onClick={() => onUpgrade()}>
                <Coffee className="h-4 w-4" aria-hidden="true" />
                打赏开通
              </button>
            ) : null}
            <button type="button" className="mt-2 w-full rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-800" onClick={exitDemo}>
              退出演示
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
