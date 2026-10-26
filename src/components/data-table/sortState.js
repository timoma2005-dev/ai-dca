// 表头排序三态（无 → 降序 → 升序 → 无）的统一描述（审计 batch2 #11）。
// 金融数据默认先降序，与 DataTableColumnHeader 的点击循环保持一致。
export function nextSortState(current) {
  if (current === 'desc') return 'asc';
  if (current === 'asc') return false;
  return 'desc';
}

const STATE_TEXT = { desc: '降序', asc: '升序' };
const ACTION_TEXT = { desc: '点击降序', asc: '点击升序', false: '点击取消排序' };

export function describeSortState(current, label = '') {
  const state = current === 'desc' || current === 'asc' ? current : false;
  const next = nextSortState(state);
  const action = ACTION_TEXT[String(next)];
  const stateText = state ? `当前${STATE_TEXT[state]}` : '未排序';
  const prefix = label ? `${label}：` : '';
  return {
    ariaSort: state === 'desc' ? 'descending' : state === 'asc' ? 'ascending' : 'none',
    stateText,
    actionText: action,
    title: `${prefix}${stateText}，${action}`,
  };
}
