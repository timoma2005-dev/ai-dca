CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    visitor_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  );

CREATE INDEX IF NOT EXISTS idx_analytics_events_date_type ON analytics_events (event_date, type);

CREATE INDEX IF NOT EXISTS idx_analytics_events_date_created ON analytics_events (event_date, created_at DESC);

CREATE TABLE IF NOT EXISTS analytics_daily_stats (
    event_date TEXT PRIMARY KEY,
    pv INTEGER NOT NULL DEFAULT 0,
    switch_runs INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE IF NOT EXISTS analytics_daily_users (
    event_date TEXT NOT NULL,
    identity TEXT NOT NULL,
    is_visitor_only INTEGER NOT NULL DEFAULT 0,
    has_page_view INTEGER NOT NULL DEFAULT 0,
    has_page_engagement INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_date, identity)
  );

CREATE INDEX IF NOT EXISTS idx_analytics_daily_users_date_flags
    ON analytics_daily_users (event_date, has_page_view, has_page_engagement);

CREATE TABLE IF NOT EXISTS backups (
    user_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    kv_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    key_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    envelope TEXT NOT NULL DEFAULT '',
    cipher_sha256 TEXT NOT NULL DEFAULT '',
    last_end_id TEXT NOT NULL DEFAULT '',
    last_end_type TEXT NOT NULL DEFAULT ''
  );

CREATE TABLE IF NOT EXISTS backup_versions (
    user_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kv_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    key_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    envelope TEXT NOT NULL DEFAULT '',
    cipher_sha256 TEXT NOT NULL DEFAULT '',
    last_end_id TEXT NOT NULL DEFAULT '',
    last_end_type TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, version)
  );

CREATE INDEX IF NOT EXISTS idx_backup_versions_user_version ON backup_versions (user_id, version DESC);
