-- 红利低波年线看板（adminHongli）：仅超级管理员可见可访问。
-- 前端 ?tab=adminHongli iframe 嵌入 /api/hongli/embed；后端 /opt/ai-dca-hongli/hongli_api.py（127.0.0.1:18092）。
-- nginx auth_request /_rbac/hongli → /api/sync/auth/check?perm=api:hongli。
INSERT OR IGNORE INTO menus (key, label, tab, icon, group_name, sort, parent_key, subtitle, enabled, created_at, updated_at) VALUES
  ('adminHongli', '红利低波', 'adminHongli', 'CandlestickChart', 'admin', 136, NULL, '红利低波全收益指数年线偏离看板与回测', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO permissions (code, kind, menu_key, description, created_at) VALUES
  ('menu:adminHongli:view',   'menu_view',   'adminHongli', '红利低波年线看板（可见）',   strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('menu:adminHongli:access', 'menu_access', 'adminHongli', '红利低波年线看板（可访问）', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:hongli',              'api',         NULL,          '红利低波年线看板 /api/hongli/*（看板数据、回测、刷新采集；仅超级管理员）', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('superadmin', 'menu:adminHongli:view'), ('superadmin', 'menu:adminHongli:access'), ('superadmin', 'api:hongli');
