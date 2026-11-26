import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteeStatus, shortShanghaiDate } from '../src/app/inviteProgress.js';

const rules = { minActiveDays: 3, windowDays: 7, rewardDays: 7 };

test('shortShanghaiDate formats in Asia/Shanghai', () => {
  assert.equal(shortShanghaiDate('2026-11-30T17:00:00.000Z'), '12-01');
  assert.equal(shortShanghaiDate('bad'), '');
});

test('inviteeStatus explains progress and outcomes', () => {
  assert.deepEqual(inviteeStatus({ status: 'pending', activeDays: 1, windowEndsAt: '2026-12-02T02:00:00Z' }, rules),
    { tone: 'pending', label: '进行中', detail: '12-02 前还需活跃 2 天' });
  assert.equal(inviteeStatus({ status: 'pending', activeDays: 3 }, rules).detail, '已满足，等待结算');
  assert.equal(inviteeStatus({ status: 'rewarded' }, rules).detail, '双方各得 7 天 SVIP');
  assert.equal(inviteeStatus({ status: 'expired', activeDays: 2 }, rules).detail, '7 天内只活跃了 2 天');
  assert.equal(inviteeStatus({ status: 'rejected', reason: 'monthly_cap' }, rules).detail, '本月奖励名额已满');
  assert.equal(inviteeStatus({ status: 'rejected', reason: 'same_ip' }, rules).label, '不计入');
  assert.equal(inviteeStatus({ status: 'pending' }, { minActiveDays: 0 }).label, '发放中');
});
