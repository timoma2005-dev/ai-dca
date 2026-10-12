import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
export const nowIso = () => new Date().toISOString();
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function openDb(path = process.env.CN_DATA_DB_PATH || '/var/lib/ai-dca-cn-data/cn-data.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const name of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
      withTransaction(db, () => {
        if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) return;
        db.exec(readFileSync(join(migrationsDir, name), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(name, nowIso());
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function closeDb(db) { db?.close(); }
