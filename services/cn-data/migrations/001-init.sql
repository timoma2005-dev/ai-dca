CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE notify_rules (
 user_id TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT '', rule_id TEXT NOT NULL,
 rule_type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id, client_id, rule_id)
);
CREATE TABLE notify_configs (
 user_id TEXT NOT NULL, config_key TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 updated_at TEXT NOT NULL, PRIMARY KEY(user_id, config_key)
);
CREATE TABLE IF NOT EXISTS account_holdings_transactions (
    user_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by_end_id TEXT NOT NULL DEFAULT '',
    updated_by_end_type TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, transaction_id)
  );
CREATE TABLE IF NOT EXISTS account_resources (
    user_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    feature TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by_end_id TEXT NOT NULL DEFAULT '',
    updated_by_end_type TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, resource)
  );
CREATE INDEX idx_account_resources_user_updated ON account_resources(user_id, updated_at DESC);
CREATE INDEX idx_holdings_transactions_user_code_date ON account_holdings_transactions(user_id, transaction_id, updated_at DESC);
CREATE TABLE sync_backups (
 user_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)),
 version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sync_outbox (
 event_id TEXT PRIMARY KEY, target TEXT NOT NULL CHECK(target IN ('notify','account','sync')),
 event_type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','dead')),
 retry_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL,
 last_error TEXT NOT NULL DEFAULT '', claimed_at TEXT
);
CREATE INDEX idx_outbox_due ON sync_outbox(status, next_attempt_at, created_at);
