export const MOBILE_BOTTOM_NAV_ITEMS = [
  { key: 'home', label: '首页', subtitle: '查看投资概览与今日动态' },
  { key: 'markets', label: '行情', subtitle: '浏览市场行情与关注标的' },
  { key: 'holdings', label: '持仓', subtitle: '查看持仓分布与收益表现' },
  { key: 'tradePlans', label: '计划', subtitle: '管理交易计划与执行记录' },
  { key: 'fundSwitch', label: '换基', subtitle: '切换定投目标基金，查看调仓方案', badge: '调仓工具', primary: true },
  { key: 'notify', label: '通知', subtitle: '管理消息推送与提醒设置' },
  { key: 'articles', label: '文章', subtitle: '基金科普指南与定投策略' },
];

export const MOBILE_BOTTOM_NAV_MAX_TABS = 5;

export function resolveMobileBottomNavItems(visibleTabs = null) {
  if (!Array.isArray(visibleTabs)) return MOBILE_BOTTOM_NAV_ITEMS;
  const visibleSet = new Set(visibleTabs);
  return MOBILE_BOTTOM_NAV_ITEMS.filter((item) => visibleSet.has(item.key));
}

export function splitMobileBottomNavItems(
  visibleTabs = null,
  maxTabs = MOBILE_BOTTOM_NAV_MAX_TABS,
) {
  const items = resolveMobileBottomNavItems(visibleTabs);
  const safeMaxTabs = Math.max(1, Number(maxTabs) || MOBILE_BOTTOM_NAV_MAX_TABS);
  if (items.length <= safeMaxTabs) {
    return { directItems: items, overflowItems: [] };
  }
  const directCount = Math.max(0, safeMaxTabs - 1);
  return {
    directItems: items.slice(0, directCount),
    overflowItems: items.slice(directCount),
  };
}
