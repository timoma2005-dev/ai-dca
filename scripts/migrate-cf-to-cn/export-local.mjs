import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(process.argv[2]);
mkdirSync(out, { mode: 0o700 }); // Refuse to overwrite an earlier export.
const manifest = { format: 1, created_at: new Date().toISOString(), tables: [], kv: [] };
function wrangler(args, output) {
  const fd = openSync(output, 'w', 0o600);
  try {
    const result = spawnSync('npx', ['wrangler', ...args], { cwd: root, stdio: ['inherit', fd, 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    if (result.error || result.status !== 0) throw new Error(`wrangler failed (${result.status}): ${args.slice(0, 3).join(' ')}`);
  } finally { closeSync(fd); }
}
const databases = new Map();
const namespaces = new Map();
for (const worker of ['notify', 'account', 'sync']) {
  const config = join(root, 'workers', worker, 'wrangler.toml');
  const text = readFileSync(config, 'utf8');
  for (const block of text.split(/(?=^\[)/m)) {
    const fields = Object.fromEntries([...block.matchAll(/^\s*(\w+)\s*=\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]));
    if (block.startsWith('[[d1_databases]]')) databases.set(fields.database_id, { ...fields, config });
    if (block.startsWith('[[kv_namespaces]]')) namespaces.set(fields.id, { ...fields, config });
  }
}
console.warn('Memory warning: D1 SQL and each complete KV key listing are parsed in memory; row JSON is streamed. Allow RAM for the largest SQL dump/key list.');
for (const [id, database] of databases) {
  const sql = join(out, `d1-${id}.sql`);
  wrangler(['d1', 'export', database.database_name, '--remote', `--config=${database.config}`, `--output=${sql}`], join(out, `d1-${id}.log`));
  const db = new DatabaseSync(join(out, `.staging-${id}.db`));
  try {
    db.exec(readFileSync(sql, 'utf8'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    for (const { name } of tables) {
      if (!/^(account_|notify_(features|links|user_feature_items|registration_links|user_records)$|backups$|backup_versions$|sync_events$)/.test(name)) continue;
      if (!/^[a-z_]+$/.test(name)) throw new Error('Unsafe source table name');
      const file = `d1-${id}-${name}.jsonl`;
      writeFileSync(join(out, file), '', { mode: 0o600 });
      let count = 0;
      for (const row of db.prepare(`SELECT * FROM "${name}"`).iterate()) {
        appendFileSync(join(out, file), JSON.stringify(row) + '\n'); count++;
      }
      manifest.tables.push({ name, file, count });
    }
  } finally { db.close(); unlinkSync(join(out, `.staging-${id}.db`)); }
}
for (const [id, namespace] of namespaces) {
  const prefixes = namespace.binding === 'NOTIFY_STATE' ? ['holdings-rule:', 'switch:config:', 'switch:snapshot:'] : [''];
  const file = `kv-${namespace.binding}.jsonl`;
  writeFileSync(join(out, file), '', { mode: 0o600 });
  let count = 0;
  for (const [index, prefix] of prefixes.entries()) {
    const listing = join(out, `.keys-${id}-${index}.json`);
    // Wrangler fetchListResult follows every API cursor internally; CLI emits a complete array.
    wrangler(['kv', 'key', 'list', `--namespace-id=${id}`, `--prefix=${prefix}`, `--config=${namespace.config}`, '--remote'], listing);
    const keys = JSON.parse(readFileSync(listing, 'utf8'));
    if (!Array.isArray(keys)) throw new Error('Expected fully paginated Wrangler key array; upgrade Wrangler');
    for (let offset = 0; offset < keys.length; offset += 100) {
      const names = keys.slice(offset, offset + 100).map((key) => key.name);
      if (names.some((name) => typeof name !== 'string')) throw new Error('Invalid KV key listing');
      const batch = join(out, '.batch.json');
      const valuesFile = join(out, '.values.json');
      writeFileSync(batch, JSON.stringify(names), { mode: 0o600 });
      wrangler(['kv', 'bulk', 'get', batch, `--namespace-id=${id}`, `--config=${namespace.config}`, '--remote'], valuesFile);
      const values = JSON.parse(readFileSync(valuesFile, 'utf8'));
      for (const key of names) {
        if (!values[key] || values[key].value == null) throw new Error(`KV value disappeared during export (${namespace.binding}); freeze writes and retry`);
        appendFileSync(join(out, file), JSON.stringify({ key, ...values[key] }) + '\n'); count++;
      }
      unlinkSync(batch); unlinkSync(valuesFile);
    }
    unlinkSync(listing);
  }
  manifest.kv.push({ binding: namespace.binding, id, file, count });
}
// Written last: incomplete exports cannot be imported.
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log(`Export complete: ${out}`);
