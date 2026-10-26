// 侧栏导航项无障碍属性（审计 batch2 #20）：折叠为纯图标时仍要有可读名称、悬停提示与当前页标识。
export function sidenavLinkA11y(item = {}, activeKey = '') {
  const label = String(item.label || item.key || '').trim();
  const name = item.locked ? `${label}（需要更高权限）` : label;
  return {
    'aria-label': name,
    title: name,
    'aria-current': item.key === activeKey ? 'page' : undefined,
  };
}
