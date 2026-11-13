import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.js';
import {
  AUTO_GRANTOR,
  activeDaysOf,
  ensureMembershipSchema,
  evaluateUser,
  membershipSummary,
  recomputeAll,
  recordActivity,
  registeredDaysOf,
  resetActivityCache,
  shanghaiDay,
  targetTier,
} from '../src/membership.js';

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const db = openDb(':memory:');
  ensureMembershipSchema(db);
  resetActivityCache();
  return db;
}

function addUser(db, id, createdAt) {
  db.prepare('INSERT INTO users (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, id, 'x', '', createdAt, createdAt);
}

function addDays(db, id, now, count) {
  for (let i = 0; i < count; i += 1) {
    db.prepare('INSERT OR IGNORE INTO user_activity_days (user_id, day) VALUES (?, ?)').run(id, shanghaiDay(new Date(now.getTime() - i * DAY)));
  }
}

function autoRoles(db, id) {
  return db.prepare('SELECT role_code FROM user_roles WHERE user_id = ? AND granted_by = ?').all(id, AUTO_GRANTOR).map((r) => r.role_code);
}

test('targetTier thresholds', () => {
  assert.equal(targetTier(30, 20), 'svip');
  assert.equal(targetTier(30, 19), 'vip');
  assert.equal(targetTier(30, 10), 'vip');
  assert.equal(targetTier(30, 9), '');
  assert.equal(targetTier(29, 30), '');
});

test('registered days and window use Beijing calendar days', () => {
  const now = new Date('2026-11-13T07:00:00Z');
  assert.equal(registeredDaysOf('2026-10-14T15:59:00Z', now), 30); // 北京 10-14 23:59
  assert.equal(registeredDaysOf('2026-10-14T16:00:00Z', now), 29); // 北京 10-15 00:00
  assert.equal(shanghaiDay(new Date('2026-11-12T16:30:00Z')), '2026-11-13');
});

test('upgrade, then automatic downgrade when activity falls out of the window', () => {
  const db = setup();
  try {
    const now = new Date('2026-11-13T07:00:00Z');
    addUser(db, 'u1', new Date(now.getTime() - 60 * DAY).toISOString());
    addDays(db, 'u1', now, 20);
    assert.equal(activeDaysOf(db, 'u1', now), 20);
    assert.deepEqual(evaluateUser(db, 'u1', { now }), { changed: true, tier: 'svip', prevTier: '' });
    assert.deepEqual(autoRoles(db, 'u1'), ['svip']);
    // 15 天没来：近 30 天只剩 15 天 → VIP；25 天没来：只剩 5 天 → 普通
    const mid = new Date(now.getTime() + 15 * DAY);
    const later = new Date(now.getTime() + 25 * DAY);
    assert.equal(activeDaysOf(db, 'u1', mid), 15);
    assert.equal(activeDaysOf(db, 'u1', later), 5);
    recomputeAll(db, { now: mid });
    assert.deepEqual(autoRoles(db, 'u1'), ['vip']);
    recomputeAll(db, { now: later });
    assert.deepEqual(autoRoles(db, 'u1'), []);
    const summary = membershipSummary(db, 'u1', { now: later });
    assert.equal(summary.tier, '');
    assert.equal(summary.prevTier, 'vip');
  } finally {
    closeDb(db);
  }
});

test('recordActivity writes once per day and upgrades immediately', () => {
  const db = setup();
  try {
    const now = new Date('2026-11-13T07:00:00Z');
    addUser(db, 'u2', new Date(now.getTime() - 40 * DAY).toISOString());
    addDays(db, 'u2', new Date(now.getTime() - DAY), 9);
    assert.equal(recordActivity(db, 'u2', { now }), true);
    assert.equal(recordActivity(db, 'u2', { now }), false);
    assert.deepEqual(autoRoles(db, 'u2'), ['vip']);
  } finally {
    closeDb(db);
  }
});

test('manual grants are left alone and do not flap', () => {
  const db = setup();
  try {
    const now = new Date('2026-11-13T07:00:00Z');
    addUser(db, 'u3', new Date(now.getTime() - 40 * DAY).toISOString());
    db.prepare("INSERT INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES ('u3', 'vip', NULL, 'admin', ?)").run(now.toISOString());
    addDays(db, 'u3', now, 12);
    assert.equal(evaluateUser(db, 'u3', { now }).changed, false);
    assert.equal(evaluateUser(db, 'u3', { now }).changed, false);
    addDays(db, 'u3', now, 25);
    assert.equal(evaluateUser(db, 'u3', { now }).tier, 'svip');
    recomputeAll(db, { now: new Date(now.getTime() + 60 * DAY) });
    assert.deepEqual(db.prepare("SELECT role_code, granted_by FROM user_roles WHERE user_id = 'u3'").all().map((r) => ({ ...r })), [{ role_code: 'vip', granted_by: 'admin' }]);
  } finally {
    closeDb(db);
  }
});
