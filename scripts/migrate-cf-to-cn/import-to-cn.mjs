import { openDb, withTransaction } from '../../services/cn-data/src/db.js';
import { prepareExport, keys } from './migration.mjs';

if (!process.argv[2]) throw new Error('Usage: node import-to-cn.mjs EXPORT_DIR [DB_PATH]');
const prepared = await prepareExport(process.argv[2]);
let target;
try {
  target = openDb(process.argv[3]);
  withTransaction(target, () => {
    for (const table of Object.keys(keys)) {
      let count = 0;
      for (const row of prepared.db.prepare(`SELECT * FROM ${table}`).iterate()) {
        const columns = Object.keys(row);
        target.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?')})`).run(...columns.map((key) => row[key]));
        count++;
      }
      console.log(`${table}: ${count} imported`);
    }
  });
  console.log(JSON.stringify(prepared.stats, null, 2));
  console.log('Import committed. No sync_outbox events created; run verification before cutover.');
} finally { target?.close(); prepared.close(); }
