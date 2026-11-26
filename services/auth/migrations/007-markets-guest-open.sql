-- 行情中心对游客只读开放（数据接口本就公开）；提醒、自选同步等写操作仍由各自接口鉴权。
INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES
  ('guest', 'menu:markets:access');
