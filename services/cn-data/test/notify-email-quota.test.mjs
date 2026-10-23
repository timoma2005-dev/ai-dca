import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EMAIL_DAILY_LIMITS, emailLimitForRoles, roleClosureFor, emailSentToday, recordEmailSent } from '../src/notify/emailQuota.js';

function authDb(grants = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE roles (code TEXT PRIMARY KEY, parent_code TEXT, is_virtual INTEGER DEFAULT 0);
    CREATE TABLE user_roles (user_id TEXT, role_code TEXT, expires_at TEXT);`);
  const ins = db.prepare('INSERT INTO roles (code, parent_code, is_virtual) VALUES (?, ?, ?)');
  for (const [code, parent, virtual] of [['guest', null, 1], ['user', 'guest', 0], ['vip', 'user', 0], ['svip', 'vip', 0], ['admin', 'svip', 0], ['auction_viewer', 'user', 0]]) ins.run(code, parent, virtual);
  const grant = db.prepare('INSERT INTO user_roles (user_id, role_code, expires_at) VALUES (?, ?, ?)');
  for (const [user, role, expires] of grants) grant.run(user, role, expires ?? null);
  return db;
}

test('email daily limit: user 10, vip 20, svip 50, admin inherits svip, expired vip falls back', () => {
  assert.deepEqual(EMAIL_DAILY_LIMITS, { user: 10, vip: 20, svip: 50 });
  const auth = authDb([['v', 'vip'], ['s', 'svip'], ['a', 'admin'], ['old', 'vip', '2000-01-01T00:00:00.000Z'], ['av', 'auction_viewer']]);
  const limit = (id) => emailLimitForRoles(roleClosureFor(auth, id));
  assert.equal(limit('nobody'), 10);
  assert.equal(limit('v'), 20);
  assert.equal(limit('s'), 50);
  assert.equal(limit('a'), 50);
  assert.equal(limit('old'), 10);
  assert.equal(limit('av'), 10);
});

test('email quota counter is per user per day', () => {
  const db = new DatabaseSync(':memory:');
  assert.equal(emailSentToday(db, 'u1', '2026-10-24'), 0);
  recordEmailSent(db, 'u1', '2026-10-24');
  recordEmailSent(db, 'u1', '2026-10-24');
  recordEmailSent(db, 'u2', '2026-10-24');
  assert.equal(emailSentToday(db, 'u1', '2026-10-24'), 2);
  assert.equal(emailSentToday(db, 'u1', '2026-10-25'), 0);
  assert.equal(emailSentToday(db, 'u2', '2026-10-24'), 1);
});
