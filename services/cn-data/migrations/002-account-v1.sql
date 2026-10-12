-- Phase 1 of docs/plan-all-routes-to-cn.md: account worker /api/account/v1/* tables.
-- account_holdings_transactions and account_resources already exist from 001-init.sql.
CREATE TABLE IF NOT EXISTS account_holdings_transaction_meta (
    user_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by_end_id TEXT NOT NULL DEFAULT '',
    updated_by_end_type TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS account_holdings_transaction_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    operation TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT NOT NULL,
    updated_by_end_id TEXT NOT NULL DEFAULT '',
    updated_by_end_type TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_holdings_transaction_history_user_tx
    ON account_holdings_transaction_history (user_id, transaction_id, seq DESC);
CREATE TABLE IF NOT EXISTS account_resource_records (
    user_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    record_id TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    record_kind TEXT NOT NULL DEFAULT 'item',
    position INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '{}',
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_end_id TEXT NOT NULL DEFAULT '',
    updated_by_end_type TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, resource, record_id)
);
CREATE INDEX IF NOT EXISTS idx_account_resource_records_collection
    ON account_resource_records (user_id, resource, deleted, position);
CREATE TABLE IF NOT EXISTS account_resource_history (
    user_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by_end_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, resource, revision)
);
CREATE TABLE IF NOT EXISTS account_migrations (
    user_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT '',
    legacy_version INTEGER NOT NULL DEFAULT 0,
    imported_resources INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_data_notices (
    user_id TEXT PRIMARY KEY,
    notice_version TEXT NOT NULL DEFAULT '',
    choice TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
