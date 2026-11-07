-- Only this strategy's atomic, permanent ingress claims. No account/channel changes.
CREATE TABLE IF NOT EXISTS notify_four_etf_signal_claims (
    owner_user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, event_id)
);
