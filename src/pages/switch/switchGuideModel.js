// 换基引导（「30 秒看懂换基」+「平时谁贵谁便宜」+ 方案卡）的纯计算部分。
// 数据来自 /api/notify/switch/guide（服务端按近 60 / 120 / 180 个交易日溢价算好的统计；有分钟线统计时用分钟口径）。

export const GUIDE_WINDOWS = [60, 120, 180];

export function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** 带正负号的百分比：-0.48 → "−0.48%" */
export function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
}

export function groupOf(rel) {
  if (rel >= 0.8) return 'high';
  if (rel <= -0.3) return 'low';
  return 'mid';
}

export const GROUP_LABEL = { high: '平时偏贵', mid: '平时居中', low: '平时偏便宜' };

/** 按平时偏离从高到低排行，附分组。 */
export function buildLadder(guide, days) {
  const win = guide?.win?.[days];
  if (!win) return [];
  return Object.keys(win.rel || {})
    .filter((code) => Number.isFinite(Number(win.rel[code])))
    .sort((a, b) => win.rel[b] - win.rel[a])
    .map((code) => ({
      code,
      name: guide.names?.[code] || code,
      rel: Number(win.rel[code]),
      relToday: Number(win.relToday?.[code]),
      group: groupOf(Number(win.rel[code]))
    }));
}

/** a−b 的价差统计 { m, lo, hi }（中位数、25%、75% 分位）。 */
export function pairStat(guide, a, b, days) {
  const pairs = guide?.win?.[days]?.pairs || {};
  const direct = pairs[`${a}-${b}`];
  if (direct) return { m: direct[0], lo: direct[1], hi: direct[2] };
  const reverse = pairs[`${b}-${a}`];
  if (reverse) return { m: -reverse[0], lo: -reverse[2], hi: -reverse[1] };
  return null;
}

/**
 * 选好「我持有 hold → 想换 target」后的方案：
 * X = 两只里平时更贵的（规则里的 H 组），Y = 平时更便宜的（L 组）。
 * go  = 价差（X−Y）升到这里，卖 X 换 Y（规则 upperPct）
 * back = 价差回到这里，卖 Y 换回 X（规则 lowerPct）
 */
export function buildPlan(guide, hold, target, days) {
  const first = pairStat(guide, hold, target, days);
  if (!first) return null;
  const X = first.m >= 0 ? hold : target;
  const Y = X === hold ? target : hold;
  const stat = pairStat(guide, X, Y, days);
  const gap = round2(Number(guide.today?.[X]) - Number(guide.today?.[Y]));
  const go = Math.round(stat.hi * 10) / 10;
  let back = Math.round(stat.lo * 10) / 10;
  if (back > go - 0.3) back = round2(go - 0.3);
  const min = Math.floor(Math.min(stat.lo, gap, back) - 1.5);
  const max = Math.ceil(Math.max(stat.hi, gap, go) + 1.5);
  return { X, Y, stat, gap, go, back, min, max, holdX: hold === X };
}

/** 当前价差相对两条线的结论。 */
export function judgePlan({ holdX, gap, go, back, stat, nameX, nameY, codeX, codeY }) {
  const d = gap - stat.m;
  if (holdX) {
    if (gap >= go) {
      return {
        kind: 'go',
        title: '✅ 可以换了',
        why: `已到你定的 ${fmtPct(go)}，${nameY}这会儿格外便宜。`,
        trade: { sell: `${nameX} ${codeX}`, buy: `${nameY} ${codeY}` }
      };
    }
    return {
      kind: 'wait',
      title: `⏳ 拿着${nameX}，再等等`,
      why: d > 0.15
        ? `离你定的 ${fmtPct(go)} 还差 ${fmtPct(go - gap)}。`
        : '没比平时多，换过去不划算。'
    };
  }
  if (gap <= back) {
    return {
      kind: 'back',
      title: `🔁 可以换成${nameX}了`,
      why: `已到你定的 ${fmtPct(back)}，${nameX}这会儿格外便宜。`,
      trade: { sell: `${nameY} ${codeY}`, buy: `${nameX} ${codeX}` }
    };
  }
  return {
    kind: 'wait',
    title: `⏳ 拿着${nameY}，再等等`,
    why: d < -0.15
      ? `离你定的 ${fmtPct(back)} 还差 ${fmtPct(gap - back)}。`
      : `没比平时少，换回${nameX}不划算。`
  };
}

/** 生成给 SwitchStrategyBoardExperience.handleSaveRule 的 payload（与规则弹窗同结构）。 */
export function buildGuideRulePayload({ plan, hold, target, name }) {
  return {
    name,
    highCodes: [plan.X],
    lowCodes: [plan.Y],
    highCode: plan.X,
    lowCode: plan.Y,
    upperPct: plan.go,
    lowerPct: plan.back,
    holdingSide: plan.holdX ? 'H' : 'L',
    holdingFundCode: hold,
    candidateFundCodes: [target]
  };
}
