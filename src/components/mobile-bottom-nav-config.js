export const MOBILE_BOTTOM_NAV_ITEMS = [
  { key: 'home', label: '首页', subtitle: '查看投资概览与今日动态' },
  { key: 'markets', label: '行情', subtitle: '浏览市场行情与关注标的' },
  { key: 'holdings', label: '持仓', subtitle: '查看持仓分布与收益表现' },
  { key: 'tradePlans', label: '计划', subtitle: '管理交易计划与执行记录' },
  { key: 'shares', label: '份额新增', subtitle: 'ETF 份额变化与申购限额跟踪' },
  { key: 'fundSwitch', label: '换基', subtitle: '切换定投目标基金，查看调仓方案', badge: '调仓工具', primary: true },
  { key: 'notify', label: '通知', subtitle: '管理消息推送与提醒设置' },
  { key: 'articles', label: '文章', subtitle: '基金科普指南与定投策略' },
  { key: 'adminQuant', label: '量化', subtitle: '量化策略回测与模拟盘', adminOnly: true },
  { key: 'adminRadar', label: '雷达', subtitle: '套利雷达与溢价监控', adminOnly: true },
  { key: 'adminAuction', label: '竞价看板', subtitle: '纳指期指与 ETF 竞价行情', adminOnly: true },
];

export const MOBILE_BOTTOM_NAV_MAX_TABS = 5;

export function resolveMobileBottomNavItems(visibleTabs = null, isAdmin = false) {
  if (!Array.isArray(visibleTabs)) {
    return MOBILE_BOTTOM_NAV_ITEMS.filter((item) => isAdmin || !item.adminOnly);
  }
  const visibleSet = new Set(visibleTabs);
  return MOBILE_BOTTOM_NAV_ITEMS.filter(
    (item) => visibleSet.has(item.key) && (isAdmin || !item.adminOnly),
  );
}

export function splitMobileBottomNavItems(
  visibleTabs = null,
  maxTabs = MOBILE_BOTTOM_NAV_MAX_TABS,
  isAdmin = false,
) {
  const items = resolveMobileBottomNavItems(visibleTabs, isAdmin);
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
