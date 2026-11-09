import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { purgeDeletedPlanRules } from '../src/notify/routes.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE notify_rules(user_id TEXT, client_id TEXT, rule_id TEXT, rule_type TEXT, payload TEXT, enabled INTEGER, updated_at TEXT, PRIMARY KEY(user_id,client_id,rule_id));
  CREATE TABLE sync_outbox(event_id TEXT, target TEXT, event_type TEXT, payload TEXT, next_attempt_at TEXT, created_at TEXT, status TEXT DEFAULT 'pending', claimed_at TEXT);
  CREATE TABLE account_resources(user_id TEXT, resource TEXT, deleted INTEGER);
  CREATE TABLE account_resource_records(user_id TEXT, resource TEXT, record_id TEXT, record_kind TEXT, deleted INTEGER)`);
  return db;
}

test('purgeDeletedPlanRules drops plan rules whose plans/store item is deleted or missing, keeps live plans and other rule types', () => {
  const db = setup();
  db.prepare("INSERT INTO account_resources VALUES('u1','plans/store',0)").run();
  db.prepare("INSERT INTO account_resource_records VALUES('u1','plans/store','live','item',0)").run();
  db.prepare("INSERT INTO account_resource_records VALUES('u1','plans/store','gone','item',1)").run();
  for (const [id, type] of [['live', 'plans'], ['gone', 'plans'], ['never', 'plans'], ['m1', 'market-alerts']]) {
    db.prepare("INSERT INTO notify_rules VALUES('u1','account:u1',?,?,'{}',1,'x')").run(id, type);
  }
  assert.deepEqual(purgeDeletedPlanRules(db, { userId: 'u1' }).sort(), ['gone', 'never']);
  assert.deepEqual(db.prepare('SELECT rule_id FROM notify_rules ORDER BY rule_id').all().map((r) => r.rule_id), ['live', 'm1']);
  assert.deepEqual(db.prepare('SELECT event_type, payload FROM sync_outbox').all().map((r) => `${r.event_type}:${JSON.parse(r.payload).rule_id}`).sort(), ['delete-rule:gone', 'delete-rule:never']);
});

test('purgeDeletedPlanRules does nothing when the user has no plans/store resource yet', () => {
  const db = setup();
  db.prepare("INSERT INTO notify_rules VALUES('u2','account:u2','p','plans','{}',1,'x')").run();
  assert.deepEqual(purgeDeletedPlanRules(db, { userId: 'u2' }), []);
});
