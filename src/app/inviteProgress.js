// 邀请明细的展示文案：被邀请人的达标进度与结算状态。
export function shortShanghaiDate(iso = '') {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 8 * 60 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function inviteeStatus(item = {}, rules = {}) {
  const minActiveDays = Number(rules.minActiveDays || 3);
  const windowDays = Number(rules.windowDays || 7);
  const activeDays = Number(item.activeDays || 0);
  if (item.status === 'rewarded') return { tone: 'success', label: '已达标', detail: `双方各得 ${rules.rewardDays || 7} 天 SVIP` };
  if (item.status === 'pending') {
    const left = Math.max(0, minActiveDays - activeDays);
    const until = shortShanghaiDate(item.windowEndsAt);
    return { tone: 'pending', label: '进行中', detail: left ? `${until ? `${until} 前` : ''}还需活跃 ${left} 天` : '已满足，等待结算' };
  }
  if (item.status === 'expired') return { tone: 'muted', label: '未达标', detail: `${windowDays} 天内只活跃了 ${activeDays} 天` };
  if (item.reason === 'monthly_cap') return { tone: 'muted', label: '已达标', detail: '本月奖励名额已满' };
  if (item.reason === 'same_ip') return { tone: 'muted', label: '不计入', detail: '与你在同一网络注册' };
  return { tone: 'muted', label: '不计入', detail: '' };
}
