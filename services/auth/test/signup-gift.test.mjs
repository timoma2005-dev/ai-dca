import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signupGiftExpiresAt, SIGNUP_GIFT, registerUser } from '../src/auth.js';
import { openDb, closeDb } from '../src/db.js';

test('signup gift: 3 months VIP ending 23:59:59 Beijing time', () => {
  assert.deepEqual(SIGNUP_GIFT, { role: 'vip', months: 3 });
  assert.equal(signupGiftExpiresAt(new Date('2026-10-24T01:00:00Z')), '2027-01-24T15:59:59.000Z');
  // 北京时间已是次日
  assert.equal(signupGiftExpiresAt(new Date('2026-10-24T17:00:00Z')), '2027-01-25T15:59:59.000Z');
  // 月末截断：11-30 + 3 个月 → 2 月最后一天
  assert.equal(signupGiftExpiresAt(new Date('2026-11-30T04:00:00Z')), '2027-02-28T15:59:59.000Z');
});

test('registerUser grants the signup VIP inside the register transaction (can be switched off)', () => {
  const db = openDb(':memory:');
  try {
    delete process.env.AUTH_SIGNUP_GIFT;
    const res = registerUser(db, { username: 'giftuser', clientPasswordHash: 'a'.repeat(64) });
    assert.ok(!res.error, res.error);
    const id = db.prepare('SELECT id FROM users WHERE username = ?').get('giftuser').id;
    const row = db.prepare('SELECT role_code, expires_at, granted_by FROM user_roles WHERE user_id = ?').get(id);
    assert.equal(row.role_code, 'vip');
    assert.equal(row.granted_by, 'signup-gift');
    assert.ok(row.expires_at > new Date().toISOString());
    process.env.AUTH_SIGNUP_GIFT = '0';
    registerUser(db, { username: 'plainuser', clientPasswordHash: 'b'.repeat(64) });
    const id2 = db.prepare('SELECT id FROM users WHERE username = ?').get('plainuser').id;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ?').get(id2).n, 0);
  } finally {
    delete process.env.AUTH_SIGNUP_GIFT;
    closeDb(db);
  }
});
