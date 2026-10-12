import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../services/cn-data/src/db.js';
import { prepareExport } from './migration.mjs';
const here = fileURLToPath(new URL('.', import.meta.url));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'migration-test-'));
  const timestamp = '2026-10-12T00:00:00.000Z';
  const manifest = { format: 1, created_at: timestamp, tables: [], kv: [] };
  function add(name, rows, binding = false) {
    const file = `${name}.jsonl`;
    writeFileSync(join(dir, file), rows.map((r) => JSON.stringify(r) + '\n').join(''));
    manifest[binding ? 'kv' : 'tables'].push({ [binding ? 'binding' : 'name']: name, file, count: rows.length });
  }
  add('notify_user_feature_items', [{ owner_user_id: 'u', client_id: 'account:u', feature: 'plans', item_id: 'p', payload: '{"id":"p"}', updated_at: timestamp }]);
  add('notify_registration_links', [{ owner_user_id: 'u', registration_id: 'r', client_id: 'account:u', payload: '{}', updated_at: timestamp }]);
  add('account_resources', [{ user_id: 'u', resource: 'plans/store', feature: 'plans', payload: '', updated_at: timestamp }]);
  add('account_resource_records', [{ user_id: 'u', resource: 'plans/store', record_id: 'p', record_kind: 'item', payload: '{"id":"p"}' }]);
  add('account_holdings_transactions', [{ user_id: 'u', transaction_id: 't', payload: '', deleted: 1, updated_at: timestamp }]);
  add('backups', [{ user_id: 'u', version: 2, envelope: '', kv_key: 'backup:u', updated_at: timestamp }]);
  add('sync_events', [{ event_id: 'e' }]);
  add('NOTIFY_STATE', [{ key: 'holdings-rule:account:u', value: { enabled: true } }], true);
  add('SYNC_BACKUPS', [{ key: 'backup:u', value: { ciphertext: 'abc' } }], true);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}
test('migration maps live resource records/KV fallback, reruns safely and detects corruption', async () => {
  const { dir } = fixture();
  try {
    const path = join(dir, 'cn.db');
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [join(here, 'import-to-cn.mjs'), dir, path], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const db = openDb(path);
    assert.deepEqual(JSON.parse(db.prepare('SELECT payload FROM account_resources').get().payload), { plans: [{ id: 'p' }] });
    assert.equal(db.prepare('SELECT count(*) AS n FROM sync_outbox').get().n, 0);
    assert.equal(db.prepare('SELECT version FROM sync_backups').get().version, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM notify_configs').get().n, 2);
    assert.equal(spawnSync(process.execPath, [join(here, 'verify.mjs'), dir, path]).status, 0);
    db.exec("UPDATE sync_backups SET payload = '{}' ");
    assert.equal(spawnSync(process.execPath, [join(here, 'verify.mjs'), dir, path]).status, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('incomplete export and feature-key collision fail before target import', async () => {
  const { dir, manifest } = fixture();
  try {
    manifest.tables[0].count++;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(prepareExport(dir), /Incomplete export/);
    const file = join(dir, manifest.tables[0].file);
    const row = { owner_user_id: 'u', client_id: 'account:u', feature: 'dca', item_id: 'p', payload: '{}', updated_at: manifest.created_at };
    writeFileSync(file, JSON.stringify({ ...row, feature: 'plans' }) + '\n' + JSON.stringify(row) + '\n');
    await assert.rejects(prepareExport(dir), /collision/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
