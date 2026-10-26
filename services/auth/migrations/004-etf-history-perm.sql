-- 份额页单只基金「历史」（份额 / 申购额度 / 溢价，近一年）：仅 SVIP 及以上。
-- nginx auth_request /_rbac/etf-history → /api/sync/auth/check?perm=api:etf-history，
-- 通过后静态返回 /var/lib/ai-dca-etf-history/{code}.json（services/etf-history/build_history.py 生成）。
INSERT OR IGNORE INTO permissions (code, kind, menu_key, description, created_at) VALUES
  ('api:etf-history', 'api', NULL, '份额历史（份额/额度/溢价）/api/etf-history/*', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('svip', 'api:etf-history');
