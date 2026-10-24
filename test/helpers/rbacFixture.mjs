// 与线上 2026-10-23 权限数据同构的小型夹具：7 个角色、13 个菜单、9 个接口权限。
const MENUS = [
  ['home', '首页', 'House', 'primary', 10], ['markets', '行情中心', 'LineChart', 'primary', 20], ['shares', '份额新增', 'BarChart3', 'primary', 30],
  ['holdings', '持仓总览', 'Wallet', 'primary', 40], ['tradePlans', '交易计划', 'ListChecks', 'primary', 50], ['fundSwitch', '基金切换', 'Shuffle', 'primary', 60],
  ['notify', '通知管理', 'Bell', 'primary', 70], ['articles', '文章', 'BookOpen', 'primary', 80], ['dataRepair', '数据修复', 'Wrench', 'primary', 90],
  ['adminQuant', '量化', 'FlaskConical', 'admin', 110], ['adminRadar', '雷达', 'Radar', 'admin', 120], ['adminAuction', '竞价看板', 'Gavel', 'admin', 130],
  ['adminRbac', '权限管理', 'ShieldCheck', 'admin', 140],
];
const APIS = ['api:account', 'api:notify', 'api:fund-switch', 'api:sync', 'api:nasdaq-radar', 'api:nasdaq-radar-compute', 'api:paper-trade', 'api:rbac-admin', 'api:rbac-grant-admin'];
const ROLE_PERMS = {
  guest: ['menu:home:view', 'menu:home:access', 'menu:markets:view', 'menu:markets:access', 'menu:shares:view', 'menu:shares:access', 'menu:articles:view', 'menu:articles:access', 'menu:holdings:view', 'menu:tradePlans:view', 'menu:fundSwitch:view', 'menu:notify:view', 'menu:dataRepair:view'],
  user: ['menu:holdings:access', 'menu:tradePlans:access', 'menu:fundSwitch:access', 'menu:notify:access', 'menu:dataRepair:access', 'menu:adminRadar:view', 'menu:adminAuction:view', 'menu:adminQuant:view', 'api:account', 'api:notify', 'api:fund-switch', 'api:sync'],
  vip: ['menu:adminRadar:access', 'api:nasdaq-radar'],
  svip: ['menu:adminAuction:access', 'menu:adminQuant:access', 'api:paper-trade'],
  admin: ['menu:adminRbac:view', 'menu:adminRbac:access', 'api:rbac-admin', 'api:nasdaq-radar-compute'],
  superadmin: ['api:rbac-grant-admin'],
  auction_viewer: ['menu:adminAuction:access'],
};
const ROLES = [
  ['guest', '游客', null, 0, { isVirtual: true, isSystem: true }],
  ['user', '普通用户', 'guest', 10, { isSystem: true }],
  ['auction_viewer', '竞价看板', 'user', 12, {}],
  ['vip', 'VIP', 'user', 20, { isSystem: true }],
  ['svip', 'SVIP', 'vip', 30, { isSystem: true }],
  ['admin', '管理员', 'svip', 90, { isSystem: true, privileged: true }],
  ['superadmin', '超级管理员', 'admin', 100, { isSystem: true, privileged: true }],
];

export function rbacFixture() {
  return {
    roles: ROLES.map(([code, name, parent, level, extra]) => ({
      code, name, parent, level, description: '', isSystem: false, isVirtual: false, privileged: false,
      perms: [...ROLE_PERMS[code]], userCount: code === 'user' ? null : 1, ...extra,
    })),
    menus: MENUS.map(([key, label, icon, group, sort]) => ({ key, label, tab: key, icon, group, sort, parentKey: null, subtitle: '', enabled: true })),
    permissions: [
      ...MENUS.flatMap(([key, label]) => [
        { code: `menu:${key}:view`, kind: 'menu_view', description: `${label}（可见）` },
        { code: `menu:${key}:access`, kind: 'menu_access', description: `${label}（可访问）` },
      ]),
      ...APIS.map((code) => ({ code, kind: 'api', description: code })),
    ],
  };
}
