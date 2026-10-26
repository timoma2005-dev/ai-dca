import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENTIMENT_STALE_MS, createSentimentStore, deriveSentimentSnapshot, mergeSentimentEntries, sentimentCellState,
} from '../src/pages/markets/marketSentimentSnapshot.js';

const codes = ['159509', '513100', '159501'];

test('no data yet: snapshot is not ready and carries no fabricated values', () => {
  const snap = deriveSentimentSnapshot({}, { breadthCodes: codes, loading: true });
  assert.equal(snap.ready, false);
  assert.deepEqual(snap.breadth, { up: 0, down: 0, missing: 3 });
  assert.equal(snap.fearGreed.value, null);
  assert.equal(snap.vix.value, null);
  assert.equal(snap.qqq.value, null);
});

test('failed / partial fetch keeps last good value per symbol instead of reverting', () => {
  const t0 = 1_000_000;
  let { entries } = mergeSentimentEntries({}, { QQQ: { changePercent: 0.8 }, VOO: { changePercent: 0.5 } }, ['QQQ', 'VOO'], t0);
  ({ entries } = mergeSentimentEntries(entries, { QQQ: { changePercent: null }, VOO: {} }, ['QQQ', 'VOO'], t0 + 5000));
  assert.equal(entries.QQQ.value, 0.8);
  assert.equal(entries.QQQ.at, t0);
  const snap = deriveSentimentSnapshot(entries, { breadthCodes: [], now: t0 + SENTIMENT_STALE_MS + 1 });
  assert.equal(snap.qqq.stale, true);
  const cell = sentimentCellState(snap.qqq, { format: (v) => `${v}%` });
  assert.equal(cell.text, '0.8%');
  assert.equal(cell.note, '延迟');
});

test('cell placeholder: loading shows … and missing shows —, never 暂无', () => {
  assert.equal(sentimentCellState({ value: null }, { loading: true }).text, '…');
  assert.equal(sentimentCellState({ value: null }, { loading: false }).text, '—');
});

test('breadth counts only symbols with data; VIX/F&G need a positive level', () => {
  const { entries } = mergeSentimentEntries({}, {
    '159509': { changePercent: 1.2 }, sz159501: { changePercent: -0.4 }, '^VIX': { price: 0 }, CNN_FNG: { value: 41.6 },
  }, [...codes, '^VIX', 'CNN_FNG'], 10);
  const snap = deriveSentimentSnapshot(entries, { breadthCodes: codes, now: 10 });
  assert.deepEqual(snap.breadth, { up: 1, down: 1, missing: 1 });
  assert.equal(snap.vix.value, null);
  assert.equal(snap.fearGreed.value, 42);
});

test('shared store: one poller for all subscribers, one snapshot for strip + report', async () => {
  let calls = 0;
  let timers = 0;
  const store = createSentimentStore({
    breadthCodes: codes,
    fetchQuotes: async (list) => { calls += 1; return { quotes: Object.fromEntries(list.map((c) => [c, { changePercent: -1, price: 20 }])) }; },
    setTimer: () => { timers += 1; return 1; },
    clearTimer: () => {},
    now: () => 5000,
  });
  const offA = store.subscribe(() => {});
  const offB = store.subscribe(() => {});
  await store.refresh();
  assert.equal(timers, 1);
  assert.equal(calls, 2); // ETF + US，两个订阅者共享
  const snap = store.getSnapshot();
  assert.deepEqual(snap.breadth, { up: 0, down: 3, missing: 0 });
  assert.equal(snap.lastSuccessAt, 5000);
  assert.equal(snap.loading, false);
  offA(); offB();
});

test('store marks error but keeps values when every fetch fails', async () => {
  let fail = false;
  const store = createSentimentStore({
    breadthCodes: codes,
    fetchQuotes: async (list) => { if (fail) throw new Error('down'); return { quotes: Object.fromEntries(list.map((c) => [c, { changePercent: 1, price: 20 }])) }; },
    setTimer: () => 1, clearTimer: () => {}, now: () => 1,
  });
  await store.refresh();
  fail = true;
  await store.refresh();
  const snap = store.getSnapshot();
  assert.equal(snap.error, '行情指标暂不可用');
  assert.equal(snap.qqq.value, 1);
  assert.equal(snap.breadth.up, 3);
});
