-- 日内轮动看板（adminRotator）：仅超级管理员可见可访问。
-- 前端 ?tab=adminRotator 每 5 秒读 /api/rotator/status，可手动设置持仓 POST /api/rotator/holding；
-- nginx auth_request /_rbac/rotator → /api/sync/auth/check?perm=api:rotator，后端 /root/tzzb-tencent/rotator_api.py（127.0.0.1:18091）。
INSERT OR IGNORE INTO menus (key, label, tab, icon, group_name, sort, parent_key, subtitle, enabled, created_at, updated_at) VALUES
  ('adminRotator', '日内轮动', 'adminRotator', 'Repeat', 'admin', 135, NULL, '纳指 ETF 溢价偏离轮动（腾讯源实时）', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO permissions (code, kind, menu_key, description, created_at) VALUES
  ('menu:adminRotator:view',   'menu_view',   'adminRotator', '日内轮动（可见）',   strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('menu:adminRotator:access', 'menu_access', 'adminRotator', '日内轮动（可访问）', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:rotator',              'api',         NULL,           '日内轮动看板 /api/rotator/*（读状态、设置持仓）', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('superadmin', 'menu:adminRotator:view'), ('superadmin', 'menu:adminRotator:access'), ('superadmin', 'api:rotator');
