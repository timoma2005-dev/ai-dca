// 一次性：把 CF KV 里 etf-pcf* 的键灌进本机 SQLite（历史快照是事件/环比计算的基线）。
// 用法：node seed.mjs /tmp/kvseed.jsonl   （每行 [key, value]；已存在的键不覆盖）
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKV } from './kv.mjs';
const DB = process.env.ETF_LOCAL_DB || '/var/lib/ai-dca-etf-local/kv.sqlite';
new SqliteKV(DB);
const db = new DatabaseSync(DB);
const ins = db.prepare('INSERT OR IGNORE INTO kv (key, value, expires_at, updated_at) VALUES (?, ?, NULL, ?)');
let n = 0;
db.exec('BEGIN');
for (const line of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const [k, v] = JSON.parse(line);
  if (k.startsWith('etf-pcf-daily-complete:')) continue;
  n += ins.run(k, v, Date.now()).changes;
}
db.exec('COMMIT');
console.log('seeded', n);
