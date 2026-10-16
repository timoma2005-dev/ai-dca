import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { resolveEtfPcfDailyTrigger } from '../src/index.js';

const DAILY_CRON = '0 1 * * 1-5';

for (const [name, cron, timestamp, expected] of [
  ['weekday trading day', DAILY_CRON, '2026-10-16T01:00:00Z',
    { shouldRun: true, date: '2026-10-16', reason: 'ok' }],
  ['National Day holiday', DAILY_CRON, '2026-10-01T01:00:00Z',
    { shouldRun: false, date: '2026-10-01', reason: 'non-trading-day' }],
  ['Saturday', DAILY_CRON, '2026-10-17T01:00:00Z',
    { shouldRun: false, date: '2026-10-17', reason: 'non-trading-day' }],
  ['fund limit cron', '0 12 * * *', '2026-10-16T12:00:00Z',
    { shouldRun: false, date: null, reason: 'wrong-cron' }],
  ['legacy daily cron', '0 1 * * *', '2026-10-16T01:00:00Z',
    { shouldRun: true, date: '2026-10-16', reason: 'ok' }],
  ['Shanghai midnight boundary', DAILY_CRON, '2026-10-18T16:00:00Z',
    { shouldRun: true, date: '2026-10-19', reason: 'ok' }]
]) {
  test(name, () => {
    assert.deepEqual(resolveEtfPcfDailyTrigger({ cron, scheduledTime: Date.parse(timestamp) }), expected);
  });
}

test('invalid scheduled times fail closed', () => {
  for (const scheduledTime of ['2026-10-16T01:00:00Z', '1792112400000', undefined, null, NaN, Infinity, 1e20]) {
    assert.deepEqual(resolveEtfPcfDailyTrigger({ cron: DAILY_CRON, scheduledTime }), {
      shouldRun: false, date: null, reason: 'invalid-scheduled-time'
    });
  }
});

test('scheduled handler skips refresh work on holidays, weekends and invalid times', async (t) => {
  const log = t.mock.method(globalThis.console, 'log', () => {});
  const waitUntil = t.mock.fn();
  for (const cron of [DAILY_CRON, '0 1 * * *']) {
    for (const scheduledTime of [Date.parse('2026-10-01T01:00:00Z'), Date.parse('2026-10-17T01:00:00Z'), undefined]) {
      await worker.scheduled({ cron, scheduledTime }, {}, { waitUntil });
    }
  }
  assert.equal(waitUntil.mock.callCount(), 0);
  assert.equal(log.mock.callCount(), 6);
  assert.equal(log.mock.calls[0].arguments[0], '[etf-pcf] skip daily refresh: non-trading-day');
  assert.equal(log.mock.calls[0].arguments[1].reason, 'non-trading-day');
});
