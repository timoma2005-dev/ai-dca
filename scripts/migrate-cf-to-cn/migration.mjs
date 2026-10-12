import { createReadStream, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openDb } from '../../services/cn-data/src/db.js';
import { assembleResourceRows } from '../../workers/account/src/recordRows.js';
import { getResourceDescriptor } from '../../workers/account/src/catalog.js';

export const keys = {
  notify_rules: ['user_id', 'client_id', 'rule_id'], notify_configs: ['user_id', 'config_key'],
  account_resources: ['user_id', 'resource'], account_holdings_transactions: ['user_id', 'transaction_id'], sync_backups: ['user_id']
};
export const hash = (payload) => createHash('sha256').update(payload).digest('hex');
const json = (value) => { const text = typeof value === 'string' ? value : JSON.stringify(value); JSON.parse(text); return text; };
const required = (value) => { if (typeof value !== 'string' || !value) throw new Error('Missing identity/timestamp'); return value; };
export async function prepareExport(directory) {
  const dir = resolve(directory);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.tables) || !Array.isArray(manifest.kv)) throw new Error('Invalid export manifest');
  const scratch = mkdtempSync(join(tmpdir(), 'cf-cn-'));
  const db = openDb(join(scratch, 'expected.db'));
  const source = new DatabaseSync(join(scratch, 'source.db'));
  source.exec('CREATE TABLE rows (name TEXT, payload TEXT); CREATE INDEX rows_name ON rows(name); CREATE TABLE kv (binding TEXT, key TEXT, value TEXT, PRIMARY KEY(binding,key))');
  const stats = { source: {}, skipped: {}, errors: 0 };
  function put(table, row) {
    for (const key of keys[table]) if (key !== 'client_id') required(row[key]);
    required(row.updated_at);
    const columns = Object.keys(row);
    const existing = db.prepare(`SELECT * FROM ${table} WHERE ${keys[table].map((key) => `${key} = ?`).join(' AND ')}`).get(...keys[table].map((key) => row[key]));
    if (existing) throw new Error(`Target key collision in ${table}; resolve source identities before importing`);
    db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?')})`).run(...columns.map((key) => row[key]));
  }
  const rows = function* (name) { for (const row of source.prepare('SELECT payload FROM rows WHERE name = ?').iterate(name)) yield JSON.parse(row.payload); };
  try {
    for (const entry of [...manifest.tables, ...manifest.kv]) {
      if (basename(entry.file) !== entry.file) throw new Error('Unsafe manifest path');
      let count = 0;
      const lines = createInterface({ input: createReadStream(join(dir, entry.file)), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line); count++;
        if (entry.binding) source.prepare('INSERT INTO kv VALUES (?, ?, ?)').run(entry.binding, required(row.key), json(row.value));
        else source.prepare('INSERT INTO rows VALUES (?, ?)').run(entry.name, JSON.stringify(row));
      }
      if (count !== entry.count) throw new Error(`Incomplete export: ${entry.file}`);
      stats.source[entry.name || entry.binding] = count;
    }
    for (const name of ['notify_features', 'notify_user_feature_items']) for (const r of rows(name)) {
      if (Number(r.deleted) === 1) { stats.skipped[name] = (stats.skipped[name] || 0) + 1; continue; }
      const payload = json(r.payload);
      put('notify_rules', { user_id: r.owner_user_id || r.user_id, client_id: r.client_id || '', rule_id: r.item_id || r.rule_id, rule_type: r.feature || r.rule_type, payload, enabled: JSON.parse(payload)?.enabled === false ? 0 : Number(r.enabled ?? 1), updated_at: r.updated_at });
    }
    for (const name of ['notify_links', 'notify_registration_links']) for (const r of rows(name)) {
      if (Number(r.deleted) === 1) { stats.skipped[name] = (stats.skipped[name] || 0) + 1; continue; }
      // Links have no cn rule type: preserve each row as a namespaced configuration.
      put('notify_configs', { user_id: r.owner_user_id || r.user_id, config_key: `registration-link:${JSON.stringify([r.registration_id, r.client_id])}`, payload: JSON.stringify(r), updated_at: r.updated_at });
    }
    for (const r of source.prepare("SELECT * FROM kv WHERE binding = 'NOTIFY_STATE'").iterate()) {
      const match = r.key.match(/^(holdings-rule:|switch:config:|switch:snapshot:)(.+)$/);
      if (!match) throw new Error('Unexpected notify KV key');
      const client = match[2];
      // Only account:<id> has an unambiguous account identity. Preserve legacy clients separately.
      const user = client.startsWith('account:') ? client.slice(8) : `legacy:${client}`;
      const configKey = match[1] === 'holdings-rule:' ? 'holdings-rule' : match[1] === 'switch:config:' ? 'switch-config' : r.key;
      const value = JSON.parse(r.value);
      put('notify_configs', { user_id: user, config_key: configKey, payload: r.value, updated_at: value?.updatedAt || value?.updated_at || manifest.created_at });
    }
    for (const table of ['account_holdings_transactions', 'account_resources']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      for (const r of rows(table)) {
        const row = Object.fromEntries(columns.filter((c) => Object.hasOwn(r, c)).map((c) => [c, r[c]]));
        if (table === 'account_resources' && !Number(r.deleted)) {
          const records = source.prepare("SELECT payload FROM rows WHERE name = 'account_resource_records' AND json_extract(payload, '$.user_id') = ? AND json_extract(payload, '$.resource') = ?").all(r.user_id, r.resource).map((record) => JSON.parse(record.payload));
          if (records.length) {
            console.warn(`Reconstructing ${r.resource}: memory proportional to one resource's records (source scan is streamed).`);
            const descriptor = getResourceDescriptor(r.resource);
            if (!descriptor) throw new Error(`Unknown resource ${r.resource}`);
            row.payload = JSON.stringify(assembleResourceRows(descriptor, records));
            row.bytes = Buffer.byteLength(row.payload); row.content_hash = hash(row.payload);
          }
        }
        put(table, row);
      }
    }
    // Current record data must never silently disappear because its manifest row is absent.
    for (const record of rows('account_resource_records')) {
      if (Number(record.deleted) === 1) continue;
      if (!db.prepare('SELECT 1 FROM account_resources WHERE user_id = ? AND resource = ? AND deleted = 0').get(record.user_id, record.resource)) {
        throw new Error('Active account resource records lack a live account_resources manifest');
      }
    }
    for (const r of rows('backups')) {
      const payload = r.envelope || source.prepare("SELECT value FROM kv WHERE binding = 'SYNC_BACKUPS' AND key = ?").get(r.kv_key)?.value;
      if (!payload) throw new Error('Backup missing D1 envelope and KV value');
      if (r.envelope && r.cipher_sha256 && hash(r.envelope) !== r.cipher_sha256) throw new Error('Backup ciphertext checksum mismatch');
      put('sync_backups', { user_id: r.user_id, payload: json(payload), version: r.version, updated_at: r.updated_at });
    }
    for (const [name, count] of Object.entries(stats.source)) if (!['notify_features', 'notify_user_feature_items', 'notify_links', 'notify_registration_links', 'NOTIFY_STATE', 'account_resources', 'account_holdings_transactions', 'backups', 'account_resource_records'].includes(name)) stats.skipped[name] = count;
    return { db, stats, close() { db.close(); source.close(); rmSync(scratch, { recursive: true, force: true }); } };
  } catch (error) { db.close(); source.close(); rmSync(scratch, { recursive: true, force: true }); throw error; }
}
