/**
 * 雷达评分 v2 展示层纯函数。数据来自 Worker 快照 data.scoring（见 workers/notify/src/radarScoring.js），
 * 只做排序、文案与格式化，不在前端重新打分。
 */

export const ETF_SHORT_NAMES = Object.freeze({
  513100: '国泰',
  159501: '嘉实',
  159941: '广发',
  159696: '易方达',
  159659: '招商',
  159632: '华安',
  513300: '华夏',
  513870: '富国',
  513110: '华泰柏瑞',
  159660: '汇添富',
  513390: '博时',
  159513: '大成',
});

export function shortName(code, fallback = '') {
  return ETF_SHORT_NAMES[String(code)] || fallback || String(code || '');
}

export function hasScoring(data) {
  const scoring = data?.scoring;
  return Boolean(scoring && typeof scoring === 'object' && scoring.etfs && Object.keys(scoring.etfs).length >= 2);
}

/** 份额数：1,000,000 → 100万；不设限 / 暂停 单独文案 */
export function formatShares(shares, { unlimited = false } = {}) {
  if (unlimited) return '不设限';
  const n = Number(shares);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n >= 1e8) return `${+(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${+(n / 1e4).toFixed(1)}万`;
  return String(n);
}

const QUOTA_TONES = {
  relax: 'rose',
  relaxing: 'amber',
  steady: 'slate',
  tight: 'emerald',
  closed: 'indigo',
  unknown: 'slate',
};

/** 份额状态徽标：label + 色调 + 一句说明 */
export function quotaBadge(quota) {
  const state = quota?.state || 'unknown';
  const tone = QUOTA_TONES[state] || 'slate';
  const limitText = formatShares(quota?.limitShares, { unlimited: quota?.unlimited });
  const prevText = formatShares(quota?.prevLimitShares);
  let detail = '';
  if (state === 'relax' || state === 'tight') {
    detail = `${prevText}→${limitText}份`;
  } else if (state === 'relaxing') {
    detail = quota?.changeDate ? `${String(quota.changeDate).slice(5)} 起放开` : '放开中';
  } else if (state === 'closed') {
    detail = '只能赎回';
  } else if (state === 'steady') {
    detail = `${limitText}份/日`;
  }
  return { state, tone, label: quota?.label || '暂无额度数据', detail };
}

/** 额度 / 日均成交（%）的颜色：≥2% 红（套利资金充足，溢价难维持），0.5–2% 橙 */
export function quotaRatioTone(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 'muted';
  if (n >= 2) return 'high';
  if (n >= 0.5) return 'mid';
  return 'low';
}

export const SCORE_SORTS = Object.freeze({
  overall: '综合',
  sell: '按卖出',
  buy: '按买入',
  quota: '只看份额异动',
});

/** 表格行：按排序方式排列 12 只 ETF */
export function scoredRows(data, sort = 'overall') {
  const scoring = data?.scoring;
  if (!hasScoring(data)) return [];
  const rec = scoring.recommendedPair;
  const rows = Object.values(scoring.etfs).map((item) => ({
    ...item,
    short: shortName(item.code, item.name),
    badge: quotaBadge(item.quota),
    isRecommendedSell: rec?.sell?.code === item.code,
    isRecommendedBuy: rec?.buy?.code === item.code,
  }));
  const byPremium = (a, b) => (b.premium ?? -Infinity) - (a.premium ?? -Infinity);
  if (sort === 'sell') return rows.sort((a, b) => b.sellScore - a.sellScore || byPremium(a, b));
  if (sort === 'buy') return rows.sort((a, b) => b.buyScore - a.buyScore || byPremium(b, a));
  if (sort === 'quota') {
    return rows
      .filter((row) => !['steady', 'unknown'].includes(row.quota?.state))
      .sort(byPremium);
  }
  return rows.sort(byPremium);
}

/** 今日份额异动（放开 / 收紧 / 暂停 / 放开中），用于侧栏「份额动态」 */
export function quotaEvents(data) {
  if (!hasScoring(data)) return { events: [], steadyCount: 0 };
  const events = [];
  let steadyCount = 0;
  const order = { relax: 0, tight: 1, relaxing: 2, closed: 3 };
  for (const item of Object.values(data.scoring.etfs)) {
    const state = item.quota?.state;
    if (state in order) {
      const badge = quotaBadge(item.quota);
      let text = `${shortName(item.code, item.name)} ${badge.detail}`;
      if ((state === 'relax' || state === 'relaxing') && Number.isFinite(item.quota?.deltaRatioPct)) {
        text += `，新增≈日均成交 ${item.quota.deltaRatioPct.toFixed(1)}%`;
      }
      events.push({ code: item.code, state, label: badge.label, tone: badge.tone, text, order: order[state] });
    } else {
      steadyCount += 1;
    }
  }
  events.sort((a, b) => a.order - b.order);
  return { events, steadyCount };
}

/** Hero 下方的提示条：果断卖出 / 买入加分 / 已跳过 */
export function heroNotes(data) {
  if (!hasScoring(data)) return [];
  const { recommendedPair: pair, etfs, blockedPairs = [] } = data.scoring;
  const notes = [];
  if (!pair) return notes;
  const sell = etfs[pair.sell.code];
  const buy = etfs[pair.buy.code];
  if (sell?.sellTag) {
    const q = sell.quota;
    const dr = Number.isFinite(q?.deltaRatioPct) ? `，新增额度约占日均成交 ${q.deltaRatioPct.toFixed(1)}%` : '';
    notes.push({ kind: 'sell', tag: sell.sellTag, text: `${shortName(sell.code, sell.name)}${q.label}：申购上限 ${quotaBadge(q).detail}${dr}，套利盘会压低溢价` });
  } else if (sell?.quota?.state === 'relaxing') {
    notes.push({ kind: 'sell', tag: '卖出加分', text: `${shortName(sell.code, sell.name)}额度放开中，溢价易继续回落` });
  }
  if (buy?.quota?.state === 'tight') {
    notes.push({ kind: 'buy', tag: '买入加分', text: `${shortName(buy.code, buy.name)}额度刚收紧（${quotaBadge(buy.quota).detail}），溢价下方有支撑` });
  } else if (buy?.quota?.state === 'closed') {
    notes.push({ kind: 'buy', tag: '买入加分', text: `${shortName(buy.code, buy.name)}暂停申购，没有新增套利盘压溢价` });
  }
  const skipped = blockedPairs.find((item) => item.buy.code !== pair.buy.code);
  if (skipped) {
    const b = etfs[skipped.buy.code];
    notes.push({
      kind: 'skip',
      tag: '已跳过',
      text: `${shortName(b.code, b.name)}溢价更低（${b.premium?.toFixed(2)}%），但额度${b.quota?.label}，溢价可能继续下行，${b.buyBlocked}再买`,
    });
  }
  return notes;
}

/** 分项明细：用于展开行 / 侧栏「为什么卖 / 为什么买」 */
export function scoreBreakdown(item, side = 'sell') {
  if (!item) return [];
  const parts = item.parts?.[side] || {};
  const q = item.quota || {};
  const vsPeer = Number.isFinite(item.premiumVsPeer) ? `${item.premiumVsPeer > 0 ? '+' : ''}${item.premiumVsPeer.toFixed(2)} pp` : '—';
  const own = item.premiumPercentile60 != null ? `p${item.premiumPercentile60}（${item.historyDays} 天）` : '历史不足';
  const ratio = Number.isFinite(q.quotaRatioPct) ? `额度≈日均成交 ${q.quotaRatioPct.toFixed(2)}%` : '';
  return [
    { label: side === 'sell' ? '溢价高于同类' : '溢价低于同类', detail: vsPeer, points: parts.peer, max: 40 },
    { label: '自身历史分位', detail: own, points: parts.own, max: 20 },
    { label: `份额：${q.label || '暂无'}`, detail: [quotaBadge(q).detail, ratio].filter(Boolean).join(' · '), points: parts.quota, max: 25 },
    { label: side === 'sell' ? '可卖性' : '交易成本', detail: `流动性 ${item.liquidity ?? '—'}/100`, points: parts.liquidity, max: 15 },
  ];
}

/** 额度阶梯：从 series 取某只 ETF 的申购上限序列（-1 = 不设限） */
export function limitSteps(data, code) {
  const series = data?.series;
  const arr = series?.etfs?.[code]?.limit;
  if (!Array.isArray(series?.dates) || !Array.isArray(arr)) return [];
  return series.dates
    .map((date, i) => ({ date, limit: arr[i] }))
    .filter((item) => item.limit !== null && item.limit !== undefined);
}
