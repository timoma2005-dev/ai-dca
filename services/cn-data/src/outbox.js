import { randomUUID } from 'node:crypto';
import { nowIso, withTransaction } from './db.js';

export const BASE_RETRY_DELAY_MS = 5000;
export const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
// Larger than a sequential 20-event batch at 15 seconds per request.
export const CLAIM_LEASE_MS = 10 * 60 * 1000;
export function enqueueEvent(db, target, eventType, payload) {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`INSERT INTO sync_outbox
    (event_id, target, event_type, payload, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, target, eventType, JSON.stringify(payload), now, now);
  return id;
}
export function claimPendingEvents(db, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid claim limit');
  return withTransaction(db, () => {
    const now = nowIso();
    db.prepare(`UPDATE sync_outbox SET status = 'pending', claimed_at = NULL
      WHERE status = 'processing' AND claimed_at <= ?`).run(new Date(Date.now() - CLAIM_LEASE_MS).toISOString());
    const rows = db.prepare(`SELECT * FROM sync_outbox WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at, rowid LIMIT ?`).all(now, limit);
    const mark = db.prepare("UPDATE sync_outbox SET status = 'processing', claimed_at = ? WHERE event_id = ?");
    for (const row of rows) mark.run(now, row.event_id);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  });
}
export function markEventDone(db, id) {
  db.prepare('DELETE FROM sync_outbox WHERE event_id = ?').run(id);
}
export function markEventFailed(db, id, error, minimumDelayMs = 0) {
  withTransaction(db, () => {
    const row = db.prepare('SELECT retry_count FROM sync_outbox WHERE event_id = ?').get(id);
    if (!row) return;
    const count = row.retry_count + 1;
    const delay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.min(count, 12));
    const next = new Date(Date.now() + Math.max(minimumDelayMs, Math.round(delay * (0.9 + Math.random() * 0.2)))).toISOString();
    db.prepare(`UPDATE sync_outbox SET status = 'pending', retry_count = ?, next_attempt_at = ?,
      last_error = ?, claimed_at = NULL WHERE event_id = ?`).run(count, next, String(error || '').slice(0, 500), id);
  });
}
export function markEventDead(db, id, error) {
  db.prepare("UPDATE sync_outbox SET status = 'dead', last_error = ?, claimed_at = NULL WHERE event_id = ?")
    .run(String(error || '').slice(0, 500), id);
}
export function outboxStats(db) {
  const stats = { pending: 0, processing: 0, dead: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM sync_outbox GROUP BY status').all()) stats[row.status] = row.n;
  return stats;
}
