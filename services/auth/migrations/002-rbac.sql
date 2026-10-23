-- 002-rbac.sql: 角色 / 菜单 / 权限（RBAC）。
-- 设计见 docs/plan-rbac.md。
-- 约定：
--   * 角色继承：roles.parent_code 指向父角色，子角色拥有父角色全部权限。
--     guest(虚拟，未登录) ← user ← vip ← svip ← admin ← superadmin。
--   * 所有登录用户隐式拥有 user 角色，user_roles 只存额外授予的角色。
--   * 权限编码：menu:<key>:view（菜单可见）、menu:<key>:access（可访问）、api:<name>。
--     有 view 无 access 的菜单在前端显示为 locked（带锁）。
--   * user_roles.expires_at 为空表示永久；过期行在计算时自动忽略（不删除，保留审计）。

CREATE TABLE IF NOT EXISTS roles (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_code TEXT REFERENCES roles(code),
  level INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_virtual INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role_code TEXT NOT NULL REFERENCES roles(code),
  expires_at TEXT,
  granted_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_code)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles (role_code);

CREATE TABLE IF NOT EXISTS menus (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  tab TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT 'primary',
  sort INTEGER NOT NULL DEFAULT 0,
  parent_key TEXT REFERENCES menus(key),
  subtitle TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  menu_key TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  perm_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, perm_code)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log (target_type, target_id);

-- ── 种子：角色 ──
INSERT OR IGNORE INTO roles (code, name, parent_code, level, is_system, is_virtual, description, created_at, updated_at) VALUES
  ('guest',      '游客',       NULL,    0,   1, 1, '未登录访客（虚拟角色，不可授予）', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('user',       '普通用户',   'guest', 10,  1, 0, '所有登录用户默认拥有', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('vip',        'VIP',        'user',  20,  1, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('svip',       'SVIP',       'vip',   30,  1, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('admin',      '管理员',     'svip',  90,  1, 0, '可管理角色/菜单/权限，不能任命管理员', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('superadmin', '超级管理员', 'admin', 100, 1, 0, '唯一可任命/撤销管理员', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('auction_viewer', '竞价看板', 'user', 12, 0, 0, '只开放竞价看板（迁移自前端单独白名单）', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ── 种子：菜单 ──
INSERT OR IGNORE INTO menus (key, label, tab, icon, group_name, sort, parent_key, subtitle, enabled, created_at, updated_at) VALUES
  ('home',        '首页',     'home',        'House',        'primary', 10,  NULL, '查看投资概览与今日动态', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('markets',     '行情中心', 'markets',     'LineChart',    'primary', 20,  NULL, '浏览市场行情与关注标的', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('shares',      '份额新增', 'shares',      'BarChart3',    'primary', 30,  NULL, 'ETF 份额变化与申购限额跟踪', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('holdings',    '持仓总览', 'holdings',    'Wallet',       'primary', 40,  NULL, '查看持仓分布与收益表现', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('tradePlans',  '交易计划', 'tradePlans',  'ListChecks',   'primary', 50,  NULL, '管理交易计划与执行记录', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fundSwitch',  '基金切换', 'fundSwitch',  'Shuffle',      'primary', 60,  NULL, '切换定投目标基金，查看调仓方案', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('notify',      '通知管理', 'notify',      'Bell',         'primary', 70,  NULL, '管理消息推送与提醒设置', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('articles',    '文章',     'articles',    'BookOpen',     'primary', 80,  NULL, '基金科普指南与定投策略', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dataRepair',  '数据修复', 'dataRepair',  'Wrench',       'primary', 90,  NULL, '数据诊断与修复', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('adminQuant',  '量化',     'adminQuant',  'FlaskConical', 'admin',   110, NULL, '量化策略回测与模拟盘', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('adminRadar',  '雷达',     'adminRadar',  'Radar',        'admin',   120, NULL, '套利雷达与溢价监控', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('adminAuction','竞价看板', 'adminAuction','Gavel',        'admin',   130, NULL, '纳指期指与 ETF 竞价行情', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('adminRbac',   '权限管理', 'adminRbac',   'ShieldCheck',  'admin',   140, NULL, '用户角色、菜单权限与审计日志', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ── 种子：权限（每个菜单 view + access，以及 api:*）──
INSERT OR IGNORE INTO permissions (code, kind, menu_key, description, created_at)
  SELECT 'menu:' || key || ':view', 'menu_view', key, label || '（可见）', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM menus;
INSERT OR IGNORE INTO permissions (code, kind, menu_key, description, created_at)
  SELECT 'menu:' || key || ':access', 'menu_access', key, label || '（可访问）', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM menus;
INSERT OR IGNORE INTO permissions (code, kind, menu_key, description, created_at) VALUES
  ('api:account',              'api', NULL, '账户数据接口 /api/account/*（cn-data 8081）', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:notify',               'api', NULL, '通知接口 /api/notify/*（cn-data 8081）', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:fund-switch',          'api', NULL, '基金切换接口 /api/notify/switch/*', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:sync',                 'api', NULL, '同步/备份接口 /api/sync', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:nasdaq-radar',         'api', NULL, '纳指雷达读取 /api/notify/nasdaq-radar', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:nasdaq-radar-compute', 'api', NULL, '纳指雷达手动计算 /api/notify/nasdaq-radar/compute', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:paper-trade',          'api', NULL, '量化模拟盘 /api/market-collector/api/paper-trade/*', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:rbac-admin',           'api', NULL, '权限管理接口（用户角色/角色/菜单/审计）', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('api:rbac-grant-admin',     'api', NULL, '任命/撤销管理员（仅超级管理员）', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ── 种子：角色权限（只写本级新增，继承由 parent_code 计算）──
-- guest：home/markets/shares/articles 可访问；user 菜单仅可见（locked）。
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('guest', 'menu:home:view'), ('guest', 'menu:home:access'),
  ('guest', 'menu:markets:view'), ('guest', 'menu:markets:access'),
  ('guest', 'menu:shares:view'), ('guest', 'menu:shares:access'),
  ('guest', 'menu:articles:view'), ('guest', 'menu:articles:access'),
  ('guest', 'menu:holdings:view'), ('guest', 'menu:tradePlans:view'), ('guest', 'menu:fundSwitch:view'),
  ('guest', 'menu:notify:view'), ('guest', 'menu:dataRepair:view');
-- user：user 菜单可访问；VIP/SVIP 菜单可见但锁住（引导升级）。
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('user', 'menu:holdings:access'), ('user', 'menu:tradePlans:access'), ('user', 'menu:fundSwitch:access'),
  ('user', 'menu:notify:access'), ('user', 'menu:dataRepair:access'),
  ('user', 'menu:adminRadar:view'), ('user', 'menu:adminAuction:view'), ('user', 'menu:adminQuant:view'),
  ('user', 'api:account'), ('user', 'api:notify'), ('user', 'api:fund-switch'), ('user', 'api:sync');
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('vip', 'menu:adminRadar:access'), ('vip', 'api:nasdaq-radar');
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('svip', 'menu:adminAuction:access'), ('svip', 'menu:adminQuant:access'), ('svip', 'api:paper-trade');
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('admin', 'menu:adminRbac:view'), ('admin', 'menu:adminRbac:access'),
  ('admin', 'api:rbac-admin'), ('admin', 'api:nasdaq-radar-compute');
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('superadmin', 'api:rbac-grant-admin');
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('auction_viewer', 'menu:adminAuction:access');

-- ── 种子：已有账号的角色（替代 auth.js 里写死的 ADMIN_USERNAMES 与前端竞价白名单）──
-- 账号尚未在本地库时由 rbac.js applyBootstrapGrants 在注册/登录时补一次。
INSERT OR IGNORE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at)
  SELECT id, 'superadmin', NULL, 'migration:002-rbac', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM users WHERE username = 'lovexl';
INSERT OR IGNORE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at)
  SELECT id, 'admin', NULL, 'migration:002-rbac', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM users WHERE username IN ('wanghao0902', 'de88903');
INSERT OR IGNORE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at)
  SELECT id, 'auction_viewer', NULL, 'migration:002-rbac', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM users WHERE username = '551668745qq.com';

INSERT INTO sync_state (key, value) VALUES ('rbac_version', '1')
  ON CONFLICT(key) DO NOTHING;
-- 标记已发放的种子账号，避免撤销后在下次登录又被 bootstrap 重新授予。
INSERT OR IGNORE INTO sync_state (key, value)
  SELECT 'rbac_bootstrap:' || username, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM users
  WHERE username IN ('lovexl', 'wanghao0902', 'de88903', '551668745qq.com');

INSERT INTO audit_log (actor_id, actor_username, action, target_type, target_id, detail, created_at)
  VALUES (NULL, 'system', 'rbac.migrate', 'schema', '002-rbac', '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
