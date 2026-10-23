import { useCallback, useEffect, useRef } from 'react';
import { readLedgerState } from '../app/holdingsLedger.js';
import { getActiveHoldingCodeList } from '../app/holdingsLedgerCore.js';
import { loadCloudSession } from '../app/authSession.js';
import { pullHoldingTransactions } from '../app/holdingTransactionsSync.js';

// 竞价看板静态页（public/auction-board.html）的持仓由账户自动判断：
// 读取当前用户的交易流水，取净份额 > 0 的基金代码，通过同源 postMessage 推给 iframe。
export function readAuctionHeldCodes() {
  try {
    return getActiveHoldingCodeList(readLedgerState().transactions || []);
  } catch {
    return [];
  }
}

// 每个持仓代码的本轮买入：最近一笔 BUY 的日期与价格；若带 switchPairId，同时给出配对卖出的代码与价格，
// 供看板计算本轮收益 / 相对卖出标的的相对收益。
export function readAuctionRounds(codes = readAuctionHeldCodes()) {
  try {
    const txs = readLedgerState().transactions || [];
    return codes.map((code) => {
      const buys = txs
        .filter((tx) => String(tx?.code) === code && tx?.type === 'BUY' && Number(tx?.price) > 0)
        .sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));
      const last = buys.at(-1);
      if (!last) return null;
      const pair = last.switchPairId
        ? txs.find((tx) => tx?.switchPairId === last.switchPairId && tx?.type === 'SELL' && String(tx?.code) !== code)
        : null;
      return {
        code,
        date: String(last.date || ''),
        price: Number(last.price),
        fromCode: pair ? String(pair.code) : '',
        fromPrice: pair ? Number(pair.price) || 0 : 0
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const HELD_REFRESH_MS = 60000;

export default function AdminAuctionExperience() {
  const frameRef = useRef(null);
  const readyRef = useRef(false);

  const pushHeld = useCallback(() => {
    const target = frameRef.current && frameRef.current.contentWindow;
    if (!target || !readyRef.current) return;
    const codes = readAuctionHeldCodes();
    target.postMessage({ type: 'ai-dca-auction-held', codes, rounds: readAuctionRounds(codes) }, window.location.origin);
  }, []);

  const loadHoldings = useCallback(async () => {
    const session = loadCloudSession();
    if (session?.accessToken) {
      try {
        await pullHoldingTransactions({ session });
      } catch {
        // 拉取失败时用已有本地/runtime 账本兜底
      }
    }
    readyRef.current = true;
    pushHeld();
  }, [pushHeld]);

  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data && event.data.type === 'ai-dca-auction-ready') pushHeld();
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('storage', pushHeld);
    loadHoldings();
    const timer = window.setInterval(loadHoldings, HELD_REFRESH_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', pushHeld);
      window.clearInterval(timer);
    };
  }, [pushHeld, loadHoldings]);

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
