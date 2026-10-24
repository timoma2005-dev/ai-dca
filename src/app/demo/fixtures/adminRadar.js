// 纳指雷达（adminRadar）演示 mock：只读。
// 雷达页演示期间只会发出一个 GET：/api/notify/nasdaq-radar（radarClient，主域名 / CF 备用域名同 pathname）。
// 返回结构与 workers/notify/src/nasdaqRadar.js 的 computeNasdaqRadar 一致，日期按本地交易日历推导到「预期快照日」，
// 新鲜度显示为已到预期基准日。手动计算 POST /api/notify/nasdaq-radar/compute 不提供 mock，由演示框架按写入拦截（403），
// 计算按钮本身也只给 isAnalyticsAdmin。演示不保存任何内容（无 keepKeys / getState）。
import { RADAR_PREMIUM_SOURCE, expectedSnapshotDate } from '../../radarModel.js';
import { getPreviousTradingDayShanghai } from '../../holidaysCN.js';

export const RADAR_DEMO_PATH = '/api/notify/nasdaq-radar';

// 12 只标准纳斯达克 100 QDII ETF（与 Worker NASDAQ_ETFS 同集合），名称取接口实际返回的简称；base 为示例溢价中枢（%）。
export const RADAR_DEMO_ETFS = Object.freeze([
  { code: '513100', name: '纳指ETF国泰', base: 14.9 },
  { code: '159501', name: '纳指ETF嘉实', base: 16.2 },
  { code: '159941', name: '纳指ETF广发', base: 14.3 },
  { code: '159696', name: '纳指ETF易方达', base: 14.6 },
  { code: '159659', name: '纳斯达克100ETF招商', base: 12.7 },
  { code: '159632', name: '纳斯达克ETF华安', base: 10.6 },
  { code: '513300', name: '纳斯达克ETF华夏', base: 11.5 },
  { code: '513870', name: '纳指ETF富国', base: 12.2 },
  { code: '513110', name: '纳指ETF华泰柏瑞', base: 9.8 },
  { code: '159660', name: '纳指ETF汇添富', base: 11.9 },
  { code: '513390', name: '纳指100ETF博时', base: 10.1 },
  { code: '159513', name: '纳斯达克100ETF大成', base: 9.7 },
]);

const HISTORY_DAYS = 20;
const FEATURE_DAYS = 14;
const BASE_WEIGHTS = ['规模', '当前流动性', 'ADTV20', 'Amihud20', '当前Spread', 'TrackingDifference', 'TrackingError'];

// 确定性抖动（-1, 1）：同一天同一标的数值稳定，刷新不跳。
function jitter(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 20001) / 10000 - 1;
}

function rankedFor(date) {
  const drift = jitter(`day:${date}`) * 0.9; // 整体溢价随日期起伏
  return RADAR_DEMO_ETFS
    .map(({ code, name, base }) => ({ code, name, premium: +(base + drift + jitter(`${date}:${code}`) * 0.85).toFixed(2) }))
    .sort((a, b) => (a.premium !== b.premium ? b.premium - a.premium : a.code.localeCompare(b.code)));
}

function pairFor(ranked) {
  const sell = ranked[0];
  const buy = ranked[ranked.length - 1];
  return { sell, buy, spread: +(sell.premium - buy.premium).toFixed(4) };
}

function previousTradingDays(date, count) {
  const days = [];
  let cur = date;
  for (let i = 0; i < count; i += 1) {
    cur = getPreviousTradingDayShanghai(cur);
    days.push(cur);
  }
  return days; // 由近到远
}

/** 演示快照（纯函数，now 为 epoch 毫秒）。 */
export function buildRadarDemoSnapshot(now = Date.now()) {
  const date = expectedSnapshotDate(now);
  const ranked = rankedFor(date);
  const best = pairFor(ranked);
  const pastDays = previousTradingDays(date, HISTORY_DAYS);
  const past = pastDays.map((day) => ({ date: day, ...pairFor(rankedFor(day)) }));
  const spreads = past.map((item) => item.spread).sort((a, b) => a - b);
  const percentile = Math.round((spreads.filter((v) => v <= best.spread).length / spreads.length) * 100);
  const recent = [{ date, ...best }, ...past.slice(0, 4)];
  return {
    date,
    computedAt: `${date}T13:36:08.000Z`, // 北京时间 21:36:08（21:35 定时计算后）
    premiumSource: RADAR_PREMIUM_SOURCE,
    etfs: ranked,
    bestPair: {
      sell: { ...best.sell },
      buy: { ...best.buy },
      spread: best.spread,
      percentile,
      historyDays: spreads.length,
    },
    recentOpportunities: recent.map((item) => ({ date: item.date, pair: `${item.sell.code} → ${item.buy.code}`, spread: item.spread })),
    dataCoverage: {
      featureHistoryDays: FEATURE_DAYS,
      maxFeatureHistoryDays: 90,
      benchmarkSymbols: { nasdaq100: '^NDX', usdcny: 'CNY=X' },
      sources: {
        premium: RADAR_PREMIUM_SOURCE,
        fundMetrics: 'markets/fund-metrics',
        orderBook: 'tencent+sina-fallback',
        benchmarkKline: 'markets/r2:yahoo',
      },
      featureCompleteness: { total: 12, premium: 12, turnover: 12, marketCapital: 12, totalShares: 0, spread: 12, depth5: 12 },
    },
    maturity: {
      days: FEATURE_DAYS,
      level: 3,
      label: '参考评分',
      dots: '●●●○○',
      enabledWeights: { base: [...BASE_WEIGHTS], premiumStats20: [], liquidityStats30: [] },
    },
    demo: true,
  };
}

export const RADAR_TEASER_PATH = '/api/notify/demo-teaser/radar';

/**
 * 用服务端「公开数据预告」拼出雷达快照：前 3 名与最佳价差是当天真实数据；
 * 其余标的、买入侧、历史配对服务端不下发，这里只放占位（界面按 visibleRows 遮罩，不进 DOM）。
 */
export function buildRadarTeaserSnapshot(teaser) {
  if (!teaser || !Array.isArray(teaser.top) || !teaser.top.length || !teaser.bestPair) return null;
  const top = teaser.top.map((e) => ({ code: String(e.code), name: String(e.name || ''), premium: Number(e.premium) }));
  const floor = top[top.length - 1].premium;
  const spread = Number(teaser.bestPair.spread);
  const buyPremium = +(top[0].premium - spread).toFixed(2);
  const hidden = Math.max(1, Number(teaser.hiddenCount) || 0);
  const fillers = Array.from({ length: hidden }, (_, i) => ({
    code: `demo-hidden-${i + 1}`,
    name: '升级查看',
    premium: i === hidden - 1 ? buyPremium : +(floor - ((floor - buyPremium) * (i + 1)) / hidden).toFixed(2),
  }));
  const buy = fillers[fillers.length - 1];
  const fallback = buildRadarDemoSnapshot();
  return {
    ...fallback,
    date: teaser.date || fallback.date,
    computedAt: teaser.computedAt || fallback.computedAt,
    premiumSource: teaser.premiumSource || fallback.premiumSource,
    etfs: [...top, ...fillers],
    bestPair: {
      sell: { ...top[0] },
      buy: { ...buy },
      spread,
      percentile: teaser.bestPair.percentile ?? fallback.bestPair.percentile,
      historyDays: teaser.bestPair.historyDays ?? fallback.bestPair.historyDays,
    },
    recentOpportunities: (teaser.recent || []).map((r) => ({ date: r.date, pair: '升级查看', spread: Number(r.spread) })),
    demo: true,
    teaser: true,
  };
}

async function loadTeaser(realFetch) {
  if (typeof realFetch !== 'function') return null;
  try {
    const res = await realFetch(RADAR_TEASER_PATH, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ok ? json.data : null;
  } catch {
    return null;
  }
}

export default {
  keepKeys: [],
  createFixtures() {
    let pending = null; // 每次演示只取一次预告；失败时整场演示用示例数据
    return {
      routes: {
        [`GET ${RADAR_DEMO_PATH}`]: async ({ realFetch } = {}) => {
          if (!pending) pending = loadTeaser(realFetch).then(buildRadarTeaserSnapshot);
          const snapshot = await pending;
          return { ok: true, data: snapshot || buildRadarDemoSnapshot() };
        },
      },
    };
  },
};
