import { useEffect, useMemo, useRef, useState } from 'react';
import { Crown, X } from 'lucide-react';
import { trackFeatureEvent } from '../../app/analytics.js';
import { VIP_EXPIRY_DISMISS_KEY, formatExpiryDate, vipExpiryNotice } from '../../app/onboarding/vipExpiry.js';

function readDismissed() {
  try { return window.localStorage.getItem(VIP_EXPIRY_DISMISS_KEY) || ''; } catch { return ''; }
}

/** 首页 VIP 到期提醒：到期前 7 天出现，可按到期日关闭。 */
export function VipExpiryNotice({ roles, onUpgrade, demoActive = false }) {
  const notice = useMemo(() => vipExpiryNotice(roles), [roles]);
  const [dismissed, setDismissed] = useState(readDismissed);
  const tracked = useRef('');
  const visible = Boolean(notice) && !demoActive && dismissed !== notice?.expiresAt;
  useEffect(() => {
    if (!visible || tracked.current === notice.expiresAt) return;
    tracked.current = notice.expiresAt;
    trackFeatureEvent('membership', 'expiry_notice_view', { role: notice.code, daysLeft: notice.daysLeft });
  }, [visible, notice]);
  if (!visible) return null;
  const date = formatExpiryDate(notice.expiresAt);
  const dismiss = () => {
    try { window.localStorage.setItem(VIP_EXPIRY_DISMISS_KEY, notice.expiresAt); } catch { /* 隐私模式下只在本次会话隐藏 */ }
    setDismissed(notice.expiresAt);
    trackFeatureEvent('membership', 'expiry_notice_dismiss', { role: notice.code, daysLeft: notice.daysLeft });
  };
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4" data-testid="vip-expiry-notice">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700"><Crown className="h-[18px] w-[18px]" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-extrabold text-amber-900">{notice.name} 还有 {notice.daysLeft} 天到期{date ? `（${date}）` : ''}</h2>
          <p className="mt-0.5 text-xs leading-5 text-amber-800">到期后切换提醒和通知会停止推送，溢价拉开时就收不到换基信号了。</p>
          <button
            type="button"
            className="mt-2 inline-flex h-8 items-center rounded-lg bg-amber-500 px-3 text-xs font-extrabold text-white hover:bg-amber-600"
            onClick={() => { trackFeatureEvent('membership', 'expiry_notice_renew', { role: notice.code, daysLeft: notice.daysLeft }); onUpgrade?.(); }}
          >
            打赏续费
          </button>
        </div>
        <button type="button" aria-label="关闭到期提醒" className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-amber-500 hover:bg-amber-100" onClick={dismiss}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
