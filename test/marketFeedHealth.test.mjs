import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarketFeedHealth, isMarketTradingTime, FEED_STALE_MS } from '../src/pages/markets/marketFeedHealth.js';

const cnMorning = Date.parse('2026-10-26T10:00:00+08:00'); // 周一 10:00 北京
const cnLunch = Date.parse('2026-10-26T12:10:00+08:00');
const usOpen = Date.parse('2026-10-26T10:30:00-04:00');

test('trading sessions: CN morning yes, lunch break no, weekend no; US regular hours', () => {
  assert.equal(isMarketTradingTime('cn', cnMorning), true);
  assert.equal(isMarketTradingTime('cn', cnLunch), false);
  assert.equal(isMarketTradingTime('cn', Date.parse('2026-10-25T10:00:00+08:00')), false);
  assert.equal(isMarketTradingTime('us', usOpen), true);
  assert.equal(isMarketTradingTime('us', cnMorning), false);
});

test('rows alone no longer mean connected: stale fetch in trading hours -> 数据延迟', () => {
  const h = evaluateMarketFeedHealth({ market: 'cn', lastSuccessAt: cnMorning - FEED_STALE_MS - 1000, hasRows: true, now: cnMorning });
  assert.equal(h.status, 'delayed');
  assert.equal(h.label, '数据延迟');
});

test('old server timestamp during trading is delayed even if fetch succeeded', () => {
  const h = evaluateMarketFeedHealth({ market: 'cn', lastSuccessAt: cnMorning - 1000, dataTimestamp: '2026-10-26 09:40:00', now: cnMorning });
  assert.equal(h.status, 'delayed');
});

test('fresh success is live; lunch break is 休市中; nothing yet is waiting', () => {
  assert.equal(evaluateMarketFeedHealth({ market: 'cn', lastSuccessAt: cnMorning - 5000, dataTimestamp: '2026-10-26 09:59:50', now: cnMorning }).status, 'live');
  assert.equal(evaluateMarketFeedHealth({ market: 'cn', lastSuccessAt: cnLunch - 40 * 60000, hasRows: true, now: cnLunch }).label, '休市中');
  assert.equal(evaluateMarketFeedHealth({ market: 'cn', now: cnMorning }).status, 'waiting');
});
