import { useCallback, useEffect, useRef } from 'react';
import { readLedgerState } from '../app/holdingsLedger.js';
import { getActiveHoldingCodeList } from '../app/holdingsLedgerCore.js';

// 竞价看板静态页（public/auction-board.html）的持仓由账户自动判断：
// 读取当前用户的交易流水，取净份额 > 0 的基金代码，通过同源 postMessage 推给 iframe。
export function readAuctionHeldCodes() {
  try {
    return getActiveHoldingCodeList(readLedgerState().transactions || []);
  } catch {
    return [];
  }
}

const HELD_REFRESH_MS = 30000;

export default function AdminAuctionExperience() {
  const frameRef = useRef(null);

  const pushHeld = useCallback(() => {
    const target = frameRef.current && frameRef.current.contentWindow;
    if (!target) return;
    target.postMessage({ type: 'ai-dca-auction-held', codes: readAuctionHeldCodes() }, window.location.origin);
  }, []);

  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data && event.data.type === 'ai-dca-auction-ready') pushHeld();
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('storage', pushHeld);
    const timer = window.setInterval(pushHeld, HELD_REFRESH_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', pushHeld);
      window.clearInterval(timer);
    };
  }, [pushHeld]);

  return (
    <section
      className="h-[calc(100vh-10rem)] min-h-[560px] w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:h-[calc(100vh-8rem)] sm:min-h-[640px]"
      aria-label="竞价看板"
    >
      <iframe
        ref={frameRef}
        title="纳指期指与ETF竞价看板"
        src="/auction-board.html"
        className="h-full w-full border-0"
        loading="eager"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={pushHeld}
      />
    </section>
  );
}
