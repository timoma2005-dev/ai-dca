import { PlayCircle } from 'lucide-react';
import { ONBOARDING_START_EVENT } from '../../app/onboarding/state.js';
import { trackFeatureEvent } from '../../app/analytics.js';

/** 空状态里的「跟着做」入口：启动同一套步骤提示，不改变页面原有按钮。 */
export function FollowAlongHint({ flow, text = '跟着做，约 1 分钟' }) {
  return (
    <button
      type="button"
      data-onboarding-follow={flow}
      className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-100"
      onClick={() => {
        trackFeatureEvent('onboarding', 'follow_along', { flowId: flow, version: 1 });
        window.dispatchEvent(new CustomEvent(ONBOARDING_START_EVENT, { detail: { flow } }));
      }}
    >
      <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
      {text}
    </button>
  );
}
