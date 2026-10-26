import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useMarketsWatchRefresh } from '../src/pages/markets/useMarketsWatchRefresh.js';

// 审计 batch1 #4：挂起的请求不能让手动刷新永远被 inflight 去重吞掉。
function captureRefresh(props) {
  let refresh = null;
  function Probe() { refresh = useMarketsWatchRefresh(props); return null; }
  renderToString(createElement(Probe));
  return refresh;
}

test('manual refresh (force) bypasses the inflight dedupe of a hung request', async () => {
  let calls = 0;
  const hung = new Promise(() => {});
  const noop = () => {};
  const refresh = captureRefresh({
    requestedWatchSymbols: ['159509'],
    trackedWatchSymbols: ['159509'],
    market: 'cn',
    includeFundFees: false,
    includePremiumSnapshots: false,
    includeHighPointSnapshots: false,
    fetchQuotes: () => { calls += 1; return calls === 1 ? hung : Promise.resolve({ quotes: { 159509: { price: 1.2 } }, generatedAt: '2026-10-26 10:00:00' }); },
    getNavSnapshots: async () => ({}),
    fetchFundFees: async () => ({}),
    buildOtcFundQuoteFromSnapshot: () => null,
    fetchPremiumQuotes: async () => ({ quotes: {} }),
    setWatchQuotes: noop,
    setWatchNavSnapshots: noop,
    setFundFeesByCode: noop,
    setWatchLoading: noop,
    onRefreshComplete: noop,
  });
  void refresh();
  await new Promise((r) => setTimeout(r, 10));
  void refresh();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, 'auto refresh is still deduped while inflight');
  await refresh({ force: true });
  assert.equal(calls, 2, 'forced refresh re-fetches');
});
