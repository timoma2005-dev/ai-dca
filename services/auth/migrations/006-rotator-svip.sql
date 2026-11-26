-- 2026-11-26：日内轮动（adminRotator）从仅超级管理员下放到 SVIP 及以上。
-- 与雷达 / 竞价看板一致：普通用户菜单可见但锁住（引导升级），SVIP 可访问并可调 /api/rotator/*。
-- superadmin 原有三条授权保留（继承链上本就覆盖，不影响结果）。
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('user', 'menu:adminRotator:view'),
  ('svip', 'menu:adminRotator:access'),
  ('svip', 'api:rotator');
UPDATE permissions SET description = '日内轮动看板 /api/rotator/*（读状态、设置持仓与阈值；SVIP 及以上）' WHERE code = 'api:rotator';
