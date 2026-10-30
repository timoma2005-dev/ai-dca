import { useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { acceptConversionPrompt, buildShareLandingPrompt, dismissShareLanding, shouldShowShareLanding } from '../app/conversionPrompts.js';
import { openAccountAuth } from '../app/accountAuthEvents.js';
import { trackFeatureEvent } from '../app/analytics.js';
import { useAutoPromptSlot } from '../app/promptQueue.js';

// 从溢价日报/分享链接（带 utm）进来的未登录访客：底部一条「开启提醒」入口。
export function ShareLandingBar() {
  const [visible, setVisible] = useState(() => shouldShowShareLanding());
  // 非模态提醒条：排在其它弹窗之后，有更高优先级的弹窗时先让位。
  const granted = useAutoPromptSlot('share-landing', visible, { priority: 10, yieldable: true });

  useEffect(() => {
    if (visible && granted) trackFeatureEvent('conversion', 'prompt_view', { trigger: 'share_landing' });
  }, [visible, granted]);

  if (!visible || !granted) return null;

  function handleAccept() {
    acceptConversionPrompt(buildShareLandingPrompt());
    openAccountAuth({ mode: 'register', source: 'share_landing', trigger: 'share_landing' });
    setVisible(false);
  }

  function handleDismiss() {
    dismissShareLanding();
    setVisible(false);
  }

  return (
    <div className="fixed bottom-[4.75rem] left-3 right-3 z-[114] sm:bottom-5 sm:left-auto sm:right-6 sm:w-[26rem]" role="region" aria-label="开启溢价提醒">
      <div className="flex items-center gap-3 rounded-xl border border-indigo-200 bg-white px-3 py-2.5 text-slate-900 shadow-xl shadow-slate-900/10">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
          <BellRing className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 text-xs leading-5 text-slate-600">
          <b className="block text-sm text-slate-950">溢价到低位时提醒你</b>
          每个交易日开盘前收日报，免费
        </div>
        <button
          type="button"
          onClick={handleAccept}
          className="inline-flex h-8 shrink-0 items-center rounded-full bg-indigo-600 px-3 text-xs font-bold text-white transition hover:bg-indigo-700"
        >
          开启提醒
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
