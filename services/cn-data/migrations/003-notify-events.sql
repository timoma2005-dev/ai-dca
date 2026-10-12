-- Phase 2 of docs/plan-all-routes-to-cn.md: replica of the notify worker's
-- D1 notify_user_records table (workers/notify/src/notifyRowStorage.js
-- ensureNotifyRowSchema). Stores per-user notify events, delivery failures,
-- registrations, and client/channel/meta records consumed by
-- GET /api/notify/status and GET /api/notify/events.
CREATE TABLE IF NOT EXISTS notify_user_records (
  owner_user_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS idx_notify_user_records_type_id
  ON notify_user_records (record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_notify_user_records_owner_type
  ON notify_user_records (owner_user_id, record_type);
