-- Migration 005: email channel bindings for cross-user duplicate detection
-- Port of workers/notify D1 notify_channel_bindings table (used by accountEmailRoutes.js /save).

CREATE TABLE IF NOT EXISTS notify_channel_bindings (
  channel_type TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  channel_identity TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_type, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_notify_channel_bindings_owner
  ON notify_channel_bindings (owner_user_id, channel_type);
