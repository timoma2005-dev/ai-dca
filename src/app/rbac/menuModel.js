// 菜单 / 权限的纯函数模型（无 React、无网络），供侧边栏、移动底部导航、全局搜索与路由守卫共用。
// 菜单与权限以服务端 /api/sync/auth/me|menus 返回为准；这里只保留：
// - 内置 guest 兜底菜单（服务端不可达时，游客也能看到与种子一致的菜单）；
// - RBAC 管理的 tab 集合（这些 tab 必须有菜单权限才能进入）。
// 注意：客户端的 locked/perms 只用于展示，真正的拦截在服务端（auth check / cn-data / nginx auth_request）。

export const ROLE_LABELS = {
  guest: '游客',
  user: '普通用户',
  vip: 'VIP',
  svip: 'SVIP',
  admin: '管理员',
  superadmin: '超级管理员',
};

// 与 services/auth/migrations/002-rbac.sql 种子保持一致。
const SEED_MENUS = [
  ['home', '首页', 'House', 'primary', 10, '查看投资概览与今日动态'],
  ['markets', '行情中心', 'LineChart', 'primary', 20, '浏览市场行情与关注标的'],
  ['shares', '份额新增', 'BarChart3', 'primary', 30, 'ETF 份额变化与申购限额跟踪'],
  ['holdings', '持仓总览', 'Wallet', 'primary', 40, '查看持仓分布与收益表现'],
  ['tradePlans', '交易计划', 'ListChecks', 'primary', 50, '管理交易计划与执行记录'],
  ['fundSwitch', '基金切换', 'Shuffle', 'primary', 60, '切换定投目标基金，查看调仓方案'],
  ['notify', '通知管理', 'Bell', 'primary', 70, '管理消息推送与提醒设置'],
  ['articles', '文章', 'BookOpen', 'primary', 80, '基金科普指南与定投策略'],
  ['dataRepair', '数据修复', 'Wrench', 'primary', 90, '数据诊断与修复'],
  ['adminRadar', '雷达', 'Radar', 'admin', 120, '套利雷达与溢价监控'],
  ['adminAuction', '竞价看板', 'Gavel', 'admin', 130, '纳指期指与 ETF 竞价行情'],
  ['adminRbac', '权限管理', 'ShieldCheck', 'admin', 140, '用户角色、菜单权限与审计日志'],
];

export const RBAC_MANAGED_TABS = new Set(SEED_MENUS.map(([key]) => key));

const GUEST_OPEN = new Set(['home', 'markets', 'shares', 'articles']);
const GUEST_LOCKED = new Set(['holdings', 'tradePlans', 'fundSwitch', 'notify', 'dataRepair']);

function seedItem([key, label, icon, group, sort, subtitle], locked) {
  return {
    key, label, tab: key, icon, group, sort, subtitle, parentKey: null, locked,
    requiredRole: locked ? { code: 'user', name: ROLE_LABELS.user } : null,
    children: [],
  };
}

/** 服务端不可达时的游客兜底（与种子权限一致）。 */
export function buildGuestFallback() {
  const menus = SEED_MENUS
    .filter(([key]) => GUEST_OPEN.has(key) || GUEST_LOCKED.has(key))
    .map((row) => seedItem(row, GUEST_LOCKED.has(row[0])));
  const perms = [];
  for (const key of GUEST_OPEN) perms.push(`menu:${key}:view`, `menu:${key}:access`);
  for (const key of GUEST_LOCKED) perms.push(`menu:${key}:view`);
  return {
    loggedIn: false,
    username: '',
    roles: [],
    topRole: { code: 'guest', name: ROLE_LABELS.guest },
    menus,
    perms: perms.sort(),
    permVersion: 'guest-fallback',
    isAdmin: false,
    source: 'fallback',
  };
}

const USER_LOCKED = { adminRadar: 'vip', adminAuction: 'svip' };
const VIP_NAMES = { vip: 'VIP', svip: 'SVIP' };

/**
 * 已登录但还拿不到服务端菜单时（首屏无缓存 / auth 服务暂不可达）的兜底：
 * 与种子 user 角色一致（user 菜单可访问，VIP/SVIP 菜单锁住）；isAdmin 时全部可访问。
 * 只影响展示，服务端仍会拒绝越权请求。
 */
export function buildUserFallback({ isAdmin = false } = {}) {
  const menus = SEED_MENUS
    .filter(([key]) => isAdmin || key !== 'adminRbac')
    .map((row) => {
      const requiredCode = isAdmin ? null : USER_LOCKED[row[0]];
      const item = seedItem(row, Boolean(requiredCode));
      item.requiredRole = requiredCode ? { code: requiredCode, name: VIP_NAMES[requiredCode] } : null;
      return item;
    });
  const perms = [];
  for (const item of menus) {
    perms.push(`menu:${item.key}:view`);
    if (!item.locked) perms.push(`menu:${item.key}:access`);
  }
  return {
    loggedIn: true,
    username: '',
    roles: [{ code: isAdmin ? 'admin' : 'user', name: isAdmin ? ROLE_LABELS.admin : ROLE_LABELS.user, expiresAt: null }],
    topRole: { code: isAdmin ? 'admin' : 'user', name: isAdmin ? ROLE_LABELS.admin : ROLE_LABELS.user },
    menus,
    perms: perms.sort(),
    permVersion: '',
    isAdmin,
    source: 'fallback',
  };
}

export function flattenMenus(menus = []) {
  const out = [];
  const walk = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.key) continue;
      out.push(item);
      walk(item.children);
    }
  };
  walk(menus);
  return out;
}

export function findMenu(menus, key) {
  return flattenMenus(menus).find((item) => item.key === key || item.tab === key) || null;
}

export function hasPerm(state, perm) {
  return Array.isArray(state?.perms) && state.perms.includes(perm);
}

export function canAccessMenu(state, key) {
  return hasPerm(state, `menu:${key}:access`);
}

/**
 * ?tab= 路由守卫：
 * - ok：可访问；
 * - login：游客访问需要登录的 tab（锁住的菜单或隐藏的受管 tab）→ 弹登录；
 * - forbidden：已登录但角色不足 → 403 页（需要 VIP/SVIP…）。
 * 不受 RBAC 管理的 tab（例如旧的 strategy）一律 ok。
 */
export function evaluateTabAccess(state, tabKey) {
  const menu = findMenu(state?.menus, tabKey);
  const managed = RBAC_MANAGED_TABS.has(tabKey) || Boolean(menu);
  if (!managed) return { status: 'ok', menu: null, requiredRole: null };
  const loggedIn = Boolean(state?.loggedIn);
  if (menu && !menu.locked && canAccessMenu(state, menu.key)) return { status: 'ok', menu, requiredRole: null };
  if (canAccessMenu(state, tabKey)) return { status: 'ok', menu, requiredRole: null };
  const requiredRole = menu?.requiredRole || null;
  if (!loggedIn) return { status: 'login', menu, requiredRole: requiredRole || { code: 'user', name: ROLE_LABELS.user } };
  return { status: 'forbidden', menu, requiredRole };
}

/** 侧边栏分组：primary / admin（服务端 group 字段）。 */
/** 有权限的排在前面、锁定的排在后面，各自保持原有顺序（稳定分区）。 */
export function sortAccessibleFirst(items = []) {
  const list = Array.isArray(items) ? items : [];
  return [...list.filter((item) => !item?.locked), ...list.filter((item) => item?.locked)];
}

export function splitSidebarMenus(menus = []) {
  const items = flattenMenus(menus).filter((item) => !item.parentKey || !findMenu(menus, item.parentKey));
  return {
    primary: sortAccessibleFirst(items.filter((item) => item.group !== 'admin')),
    admin: sortAccessibleFirst(items.filter((item) => item.group === 'admin')),
  };
}

export function requiredRoleLabel(requiredRole) {
  if (!requiredRole) return '更高权限';
  return requiredRole.name || ROLE_LABELS[requiredRole.code] || requiredRole.code;
}

const LOGIN_ONLY_ROLES = new Set(['', 'guest', 'user']);
const PAID_ROLES = new Set(['vip', 'svip']);

/** 需要付费角色（VIP / SVIP）才能使用。 */
export function isPaidRole(requiredRole) {
  return PAID_ROLES.has(requiredRole?.code || '');
}

/** 锁定菜单的短标签：只需登录的显示「需登录」，付费功能显示「VIP 专享」，管理功能显示「仅管理员」。 */
export function lockLabelFor(requiredRole) {
  const code = requiredRole?.code || '';
  if (LOGIN_ONLY_ROLES.has(code)) return '需登录';
  if (PAID_ROLES.has(code)) return `${requiredRole.name || ROLE_LABELS[code]} 专享`;
  if (code === 'admin' || code === 'superadmin') return '仅管理员';
  return `需${requiredRoleLabel(requiredRole)}`;
}

export function isAdminState(state) {
  if (state?.isAdmin) return true;
  const codes = (Array.isArray(state?.roles) ? state.roles : []).map((role) => role?.code);
  return codes.includes('admin') || codes.includes('superadmin');
}

/** 头像角标：VIP 金色、SVIP 钻石、管理员盾牌（取最高角色）。 */
export function roleBadgeFor(topRole) {
  const code = topRole?.code || '';
  if (code === 'superadmin' || code === 'admin') return { kind: 'shield', label: ROLE_LABELS[code], tone: 'indigo' };
  if (code === 'svip') return { kind: 'diamond', label: 'SVIP', tone: 'violet' };
  if (code === 'vip') return { kind: 'crown', label: 'VIP', tone: 'gold' };
  return null;
}

const RING_TIERS = ['superadmin', 'admin', 'svip', 'vip'];

/** 头像光圈等级（参考 Google 账号头像外圈）：VIP 金、SVIP 紫粉、管理员蓝、超级管理员四色；其余无光圈。 */
export function roleRingFor(topRole) {
  const code = topRole?.code || '';
  if (!RING_TIERS.includes(code)) return null;
  return { tier: code, label: topRole?.name || ROLE_LABELS[code] };
}
