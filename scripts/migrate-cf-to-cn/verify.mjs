import { DatabaseSync } from 'node:sqlite';
import { prepareExport, keys, hash } from './migration.mjs';
if (!process.argv[2]) throw new Error('Usage: node verify.mjs EXPORT_DIR [DB_PATH]');
const prepared = await prepareExport(process.argv[2]);
let target;
try {
  target = new DatabaseSync(process.argv[3] || process.env.CN_DATA_DB_PATH || '/var/lib/ai-dca-cn-data/cn-data.db', { readOnly: true });
  for (const [table, primary] of Object.entries(keys)) {
    const expected = prepared.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const actual = target.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    let ok = expected === actual;
    let checked = 0;
    for (const row of prepared.db.prepare(`SELECT * FROM ${table} ORDER BY random() LIMIT 5`).iterate()) {
      const other = target.prepare(`SELECT * FROM ${table} WHERE ${primary.map((key) => `${key} = ?`).join(' AND ')}`).get(...primary.map((key) => row[key]));
      if (!other || hash(row.payload) !== hash(other.payload) || Object.keys(row).some((key) => row[key] !== other[key])) ok = false;
      checked++;
    }
    // Also compare counts per user; global counts alone can hide missing users.
    for (const row of prepared.db.prepare(`SELECT user_id, count(*) AS n FROM ${table} GROUP BY user_id`).iterate()) {
      if (target.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).get(row.user_id).n !== row.n) ok = false;
    }
    console.log(`${ok ? 'PASS' : 'FAIL'} ${table}: export(mapped)=${expected}, cn=${actual}, payload hashes checked=${checked}`);
    if (!ok) process.exitCode = 1;
  }
  console.log(JSON.stringify(prepared.stats, null, 2));
} finally { target?.close(); prepared.close(); }
