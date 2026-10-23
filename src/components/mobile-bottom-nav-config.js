import { sortAccessibleFirst } from '../app/rbac/menuModel.js';
// 移动端底部导航：哪些菜单出现、是否锁住，全部来自服务端 RBAC 菜单（flattenMenus 后传入）。
// 本地只保留移动端的展示配置（顺序、短标签、副标题、徽标）；服务端新增而这里没有配置的菜单按其 sort 追加在末尾。
export const MOBILE_BOTTOM_NAV_ITEMS = [
  { key: 'home', label: '首页', subtitle: '查看投资概览与今日动态' },
  { key: 'markets', label: '行情', subtitle: '浏览市场行情与关注标的' },
  { key: 'holdings', label: '持仓', subtitle: '查看持仓分布与收益表现' },
  { key: 'tradePlans', label: '计划', subtitle: '管理交易计划与执行记录' },
  { key: 'shares', label: '份额新增', subtitle: 'ETF 份额变化与申购限额跟踪' },
  { key: 'fundSwitch', label: '换基', subtitle: '切换定投目标基金，查看调仓方案', badge: '调仓工具', primary: true },
  { key: 'notify', label: '通知', subtitle: '管理消息推送与提醒设置' },
  { key: 'articles', label: '文章', subtitle: '基金科普指南与定投策略' },
  { key: 'adminRadar', label: '雷达', subtitle: '套利雷达与溢价监控' },
  { key: 'adminAuction', label: '竞价看板', subtitle: '纳指期指与 ETF 竞价行情' },
  { key: 'adminRbac', label: '权限管理', subtitle: '用户角色、菜单权限与审计日志' },
];

// 移动端不放进底部导航的菜单（桌面侧边栏仍可见）。
export const MOBILE_EXCLUDED_KEYS = new Set(['dataRepair']);

export const MOBILE_BOTTOM_NAV_MAX_TABS = 5;

/**
 * @param {Array<{key:string,label?:string,subtitle?:string,locked?:boolean,requiredRole?:object,sort?:number}>} menus 服务端可见菜单（扁平）
 * @param {string[]|null} visibleTabs 场景可见 tab（可选，进一步过滤）
 */
export function resolveMobileBottomNavItems(menus = [], visibleTabs = null) {
  const visibleSet = Array.isArray(visibleTabs) ? new Set(visibleTabs) : null;
  const byKey = new Map((Array.isArray(menus) ? menus : []).filter((m) => m?.key).map((m) => [m.key, m]));
  const known = new Set(MOBILE_BOTTOM_NAV_ITEMS.map((item) => item.key));
  const ordered = MOBILE_BOTTOM_NAV_ITEMS
    .filter((item) => byKey.has(item.key))
    .map((item) => ({ ...item, locked: Boolean(byKey.get(item.key).locked), requiredRole: byKey.get(item.key).requiredRole || null }));
  const extras = [...byKey.values()]
    .filter((menu) => !known.has(menu.key))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    .map((menu) => ({ key: menu.key, label: menu.label, subtitle: menu.subtitle || '', locked: Boolean(menu.locked), requiredRole: menu.requiredRole || null }));
  return [...ordered, ...extras].filter((item) => !MOBILE_EXCLUDED_KEYS.has(item.key) && (!visibleSet || visibleSet.has(item.key) || !known.has(item.key)));
}

export function splitMobileBottomNavItems(menus = [], visibleTabs = null, maxTabs = MOBILE_BOTTOM_NAV_MAX_TABS) {
  const items = resolveMobileBottomNavItems(menus, visibleTabs);
  const safeMaxTabs = Math.max(1, Number(maxTabs) || MOBILE_BOTTOM_NAV_MAX_TABS);
  if (items.length <= safeMaxTabs) {
    return { directItems: items, overflowItems: [] };
  }
  const directCount = Math.max(0, safeMaxTabs - 1);
  return {
    directItems: items.slice(0, directCount),
    // 「更多」里有权限的排在前面，锁定的排在后面。
    overflowItems: sortAccessibleFirst(items.slice(directCount)),
  };
}
