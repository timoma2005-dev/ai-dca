// 本机版 Workers KV：只实现 etf-shares worker 用到的 get(key[, 'json']) / put(key, value, { expirationTtl })。
import { DatabaseSync } from 'node:sqlite';

export class SqliteKV {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL)');
    this.getStmt = this.db.prepare('SELECT value, expires_at FROM kv WHERE key = ?');
    this.putStmt = this.db.prepare('INSERT INTO kv (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at');
    this.delStmt = this.db.prepare('DELETE FROM kv WHERE key = ?');
  }
  async get(key, type) {
    const row = this.getStmt.get(String(key));
    if (!row) return null;
    if (row.expires_at && row.expires_at <= Date.now()) { this.delStmt.run(String(key)); return null; }
    if (type === 'json') return JSON.parse(row.value);
    return row.value;
  }
  async put(key, value, opts = {}) {
    const ttl = Number(opts?.expirationTtl);
    const expiresAt = Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.putStmt.run(String(key), text, expiresAt, Date.now());
  }
  async delete(key) { this.delStmt.run(String(key)); }
}
