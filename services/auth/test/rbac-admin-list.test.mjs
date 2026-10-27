import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAnalyticsDb, userLastActiveDates } from '../src/analyticsRead.js';
import { openDb, closeDb } from '../src/db.js';
import { registerUser } from '../src/auth.js';
import { listGuests, searchUsers, userStats } from '../src/rbacAdmin.js';
import { createApp } from '../src/server.js';

describe('rbac admin user and guest activity lists', () => {
  let dir;
  let db;
  let analytics;
  let previousPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rbac-admin-list-'));
    previousPath = process.env.AI_DCA_CN_DATA_DB;
    process.env.AI_DCA_CN_DATA_DB = join(dir, 'cn-data.db');
    db = openDb(join(dir, 'auth.sqlite'));
    const insertUser = db.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const [id, name] of [['usr_role', 'alice'], ['usr_plain', 'bob'], ['usr_session', 'zoe']]) {
      insertUser.run(id, name, 'hash', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    }
    db.prepare("INSERT INTO user_roles (user_id, role_code, granted_by, created_at) VALUES (?, 'vip', 'test', ?)")
      .run('usr_role', '2026-10-01T00:00:00.000Z');
    const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
    insertSession.run('old', 'usr_session', '2026-10-20T12:00:00.000Z', '2030-01-01T00:00:00.000Z');
    insertSession.run('latest', 'usr_session', '2026-10-22T12:00:00.000Z', '2030-01-01T00:00:00.000Z');

    analytics = new DatabaseSync(process.env.AI_DCA_CN_DATA_DB);
    analytics.exec(`CREATE TABLE analytics_daily_users (
      event_date TEXT NOT NULL, identity TEXT NOT NULL, is_visitor_only INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_date, identity)
    )`);
    const activity = analytics.prepare('INSERT INTO analytics_daily_users VALUES (?, ?, ?)');
    for (const row of [
      ['2026-10-21', 'usr_session', 0],
      ['2026-10-19', 'usr_role', 0],
      ['2026-10-23', 'usr_role', 0],
      ['2026-10-20', 'visitor-one-long-identity', 1],
      ['2026-10-22', 'visitor-one-long-identity', 1],
      ['2026-10-21', 'visitor-two', 1],
    ]) activity.run(...row);
  });

  afterEach(() => {
    analytics.close();
    closeDb(db);
    if (previousPath === undefined) delete process.env.AI_DCA_CN_DATA_DB;
    else process.env.AI_DCA_CN_DATA_DB = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('userStats counts every user and only non-VIP active roles as privileged', () => {
    assert.deepEqual(userStats(db), { total: 3, privileged: 0 });
    db.prepare("INSERT INTO user_roles (user_id, role_code, granted_by, created_at) VALUES ('usr_plain', 'svip', 't', 'x')").run();
    db.prepare("INSERT INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES ('usr_session', 'admin', '2000-01-01T00:00:00.000Z', 't', 'x')").run();
    assert.deepEqual(userStats(db), { total: 3, privileged: 1 });
  });

  it('includes all three users, including users without role rows, and combines activity before limiting', () => {
    const users = searchUsers(db);
    assert.deepEqual(users.map((u) => u.username), ['alice', 'zoe', 'bob']);
    assert.equal(users.length, 3);
    assert.equal(users[0].lastActiveAt, '2026-10-23');
    assert.equal(users[1].lastActiveAt, '2026-10-22T12:00:00.000Z');
    assert.equal(users[2].lastActiveAt, null);
    assert.deepEqual(users[1].roles, []);
    assert.deepEqual(users[2].roles, []);
    analytics.prepare('INSERT INTO analytics_daily_users VALUES (?, ?, 0)').run('2026-10-24', 'usr_session');
    assert.equal(searchUsers(db, { limit: 1 })[0].username, 'zoe', 'limit applies after analytics dates are merged');
    assert.equal(searchUsers(db, { limit: 1 })[0].lastActiveAt, '2026-10-24');
  });

  it('compares analytics dates at midnight, keeps session time on the same day, and orders ties by username', () => {
    analytics.prepare('INSERT INTO analytics_daily_users VALUES (?, ?, 0)').run('2026-10-22', 'usr_session');
    assert.equal(searchUsers(db).find((u) => u.id === 'usr_session').lastActiveAt, '2026-10-22T12:00:00.000Z');
    db.prepare('DELETE FROM sessions').run();
    analytics.prepare('INSERT INTO analytics_daily_users VALUES (?, ?, 0)').run('2026-10-23', 'usr_session');
    assert.deepEqual(searchUsers(db).map((u) => u.username), ['alice', 'zoe', 'bob']);
    assert.deepEqual(searchUsers(db, { q: 'o' }).map((u) => u.username), ['bob', 'zoe'], 'search keeps username order');
    assert.equal(searchUsers(db, { q: 'usr_plain' })[0].username, 'bob');
  });

  it('aggregates only visitor-only dates, with first/last dates and active day counts', () => {
    assert.deepEqual(listGuests(), { available: true, guests: [
      { visitorId: 'visitor-one-long-identity', firstSeenDate: '2026-10-20', lastActiveDate: '2026-10-22', activeDays: 2 },
      { visitorId: 'visitor-two', firstSeenDate: '2026-10-21', lastActiveDate: '2026-10-21', activeDays: 1 },
    ] });
    assert.equal(listGuests({ limit: 1 }).guests.length, 1);
    assert.equal(userLastActiveDates().get('usr_role'), '2026-10-23');
  });

  it('reads analytics in read-only mode and closes each aggregate connection', () => {
    const reader = openAnalyticsDb();
    try {
      assert.throws(() => reader.exec('DELETE FROM analytics_daily_users'), /readonly/);
    } finally {
      reader.close();
    }
    assert.equal(listGuests().available, true);
    // 聚合调用后没有遗留读事务阻碍后续写入。
    analytics.exec('BEGIN EXCLUSIVE; DELETE FROM analytics_daily_users; COMMIT;');
    assert.deepEqual(listGuests(), { available: true, guests: [] });
  });

  it('degrades for missing, corrupt or incompatible analytics DBs without breaking users or creating files', () => {
    const missing = join(dir, 'missing.db');
    const corrupt = join(dir, 'corrupt.db');
    const incompatible = join(dir, 'incompatible.db');
    writeFileSync(corrupt, 'not a sqlite database');
    new DatabaseSync(incompatible).close();
    for (const path of [missing, corrupt, incompatible, dir]) {
      process.env.AI_DCA_CN_DATA_DB = path;
      assert.deepEqual(listGuests(), { available: false, guests: [] });
      assert.deepEqual(userLastActiveDates(), new Map());
      const users = searchUsers(db);
      assert.equal(users.length, 3);
      assert.equal(users[0].username, 'zoe');
      assert.equal(users[0].lastActiveAt, '2026-10-22T12:00:00.000Z');
      assert.deepEqual(users.slice(1).map((u) => u.lastActiveAt), [null, null]);
    }
    assert.equal(existsSync(missing), false);
    process.env.AI_DCA_CN_DATA_DB = missing;
    assert.equal(openAnalyticsDb(), null);
  });

  it('accepts limits above 100 and caps both lists at 500', () => {
    const insertUser = db.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const activity = analytics.prepare('INSERT INTO analytics_daily_users VALUES (?, ?, 1)');
    db.exec('BEGIN');
    analytics.exec('BEGIN');
    for (let i = 0; i < 505; i += 1) {
      insertUser.run(`usr_extra_${i}`, `extra${String(i).padStart(3, '0')}`, 'hash', '2026-10-01', '2026-10-01');
      activity.run('2026-10-20', `visitor-extra-${i}`);
    }
    db.exec('COMMIT');
    analytics.exec('COMMIT');
    assert.equal(searchUsers(db, { limit: 200 }).length, 200);
    assert.equal(searchUsers(db, { q: 'extra', limit: 999 }).length, 500);
    assert.equal(searchUsers(db, { limit: 999 }).length, 500);
    assert.equal(listGuests({ limit: 999 }).guests.length, 500);
    assert.equal(listGuests().guests.length, 200);
  });

  it('protects /guests with the same admin permission gate as /users and returns JSON', async () => {
    const root = registerUser(db, { username: 'lovexl', clientPasswordHash: 'a'.repeat(64) });
    const user = registerUser(db, { username: 'ordinary', clientPasswordHash: 'a'.repeat(64) });
    const server = createServer(createApp(db));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/sync/auth/admin/guests`;
    try {
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: 'Bearer forged' } })).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: `Bearer ${user.accessToken}` } })).status, 403);
      const res = await fetch(`${url}?limit=1`, { headers: { authorization: `Bearer ${root.accessToken}` } });
      assert.equal(res.status, 200);
      const result = await res.json();
      assert.equal(result.available, true);
      assert.equal(result.guests.length, 1);
      process.env.AI_DCA_CN_DATA_DB = join(dir, 'missing.db');
      const unavailable = await fetch(url, { headers: { authorization: `Bearer ${root.accessToken}` } });
      assert.deepEqual(await unavailable.json(), { ok: true, available: false, guests: [] });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
