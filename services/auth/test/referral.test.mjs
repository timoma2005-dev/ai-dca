import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { ensureMembershipSchema, shanghaiDay } from '../src/membership.js';
import { ensureReferralSchema, inviteCodeFor, recordSignup, settleReferrals, referralSummary, grantSvipDays } from '../src/referral.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-02T02:00:00Z');
const RULES = { windowDays: 7, minActiveDays: 3, rewardDays: 7, monthlyCap: 2 };

function setup() {
  const db = openDb(':memory:');
  ensureMembershipSchema(db);
  ensureReferralSchema(db);
  return db;
}
function addUser(db, id, ip, at = T0) {
  db.prepare('INSERT INTO users (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, 'x', '', at.toISOString(), at.toISOString());
}
function active(db, id, days) {
  for (const d of days) db.prepare('INSERT OR IGNORE INTO user_activity_days (user_id, day) VALUES (?, ?)').run(id, shanghaiDay(new Date(T0.getTime() + d * DAY)));
}
function svip(db, id) {
  return db.prepare("SELECT expires_at FROM user_roles WHERE user_id = ? AND role_code = 'svip'").get(id)?.expires_at || null;
}

test('invite code is stable per user and unique', () => {
  const db = setup();
  addUser(db, 'a'); addUser(db, 'b');
  const a = inviteCodeFor(db, 'a');
  assert.match(a, /^[A-Z2-9]{6}$/);
  assert.equal(inviteCodeFor(db, 'a'), a);
  assert.notEqual(inviteCodeFor(db, 'b'), a);
});

test('reward only after 3 active days within 7 days; both sides get SVIP days', () => {
  const db = setup();
  addUser(db, 'inv'); recordSignup(db, { userId: 'inv', ip: '1.1.1.1', now: T0 });
  const code = inviteCodeFor(db, 'inv');
  addUser(db, 'new'); assert.equal(recordSignup(db, { userId: 'new', ip: '2.2.2.2', inviteCode: code.toLowerCase(), now: T0 }).referral.status, 'pending');
  active(db, 'new', [0, 1]);
  assert.equal(settleReferrals(db, { now: new Date(T0.getTime() + 2 * DAY), rules: RULES }).rewarded, 0);
  assert.equal(svip(db, 'inv'), null);
  active(db, 'new', [4]);
  assert.equal(settleReferrals(db, { now: new Date(T0.getTime() + 5 * DAY), rules: RULES }).rewarded, 1);
  assert.equal(svip(db, 'inv'), new Date(T0.getTime() + 12 * DAY).toISOString());
  assert.equal(svip(db, 'new'), new Date(T0.getTime() + 12 * DAY).toISOString());
  assert.equal(referralSummary(db, 'inv', { now: T0, rules: RULES }).rewarded, 1);
});

test('inactive referee expires after the window; same IP and self codes never count', () => {
  const db = setup();
  addUser(db, 'inv'); recordSignup(db, { userId: 'inv', ip: '1.1.1.1', now: T0 });
  const code = inviteCodeFor(db, 'inv');
  addUser(db, 'lazy'); recordSignup(db, { userId: 'lazy', ip: '3.3.3.3', inviteCode: code, now: T0 });
  active(db, 'lazy', [0, 8, 9]);
  settleReferrals(db, { now: new Date(T0.getTime() + 10 * DAY), rules: RULES });
  assert.equal(db.prepare("SELECT status FROM referrals WHERE referee_id = 'lazy'").get().status, 'expired');
  addUser(db, 'sock'); assert.equal(recordSignup(db, { userId: 'sock', ip: '1.1.1.1', inviteCode: code, now: T0 }).referral.reason, 'same_ip');
  addUser(db, 'sock2'); assert.equal(recordSignup(db, { userId: 'sock2', ip: '3.3.3.3', inviteCode: code, now: T0 }).referral.reason, 'same_ip');
  assert.equal(recordSignup(db, { userId: 'inv', inviteCode: code, now: T0 }).error, 'invalid_code');
  assert.equal(recordSignup(db, { userId: 'x', inviteCode: 'NOPE99', now: T0 }).error, 'invalid_code');
});

test('monthly cap stops rewards; permanent SVIP is never shortened', () => {
  const db = setup();
  addUser(db, 'inv'); recordSignup(db, { userId: 'inv', ip: '1.1.1.1', now: T0 });
  const code = inviteCodeFor(db, 'inv');
  for (const [i, id] of ['r1', 'r2', 'r3'].entries()) {
    addUser(db, id); recordSignup(db, { userId: id, ip: `9.9.9.${i}`, inviteCode: code, now: T0 }); active(db, id, [0, 1, 2]);
  }
  assert.equal(settleReferrals(db, { now: new Date(T0.getTime() + 3 * DAY), rules: RULES }).rewarded, 2);
  assert.equal(db.prepare("SELECT reason FROM referrals WHERE status = 'rejected'").get().reason, 'monthly_cap');
  addUser(db, 'perm');
  db.prepare("INSERT INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES ('perm', 'svip', NULL, 'admin', ?)").run(T0.toISOString());
  assert.equal(grantSvipDays(db, 'perm', 7, { now: T0 }), null);
  assert.equal(svip(db, 'perm'), null);
});
