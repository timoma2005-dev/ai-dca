/**
 * 纳指 ETF 换基评分 v2（纯函数，无 IO）。方案见 notes/radar-score-v2-plan.md。
 *
 * 核心思路：溢价由「申购额度」决定——额度放开（套利资金进场）后溢价回落，收紧后溢价走高。
 * 因此卖出要看「高溢价 + 刚放开」，买入要看「低溢价 + 额度没在放开」。
 *
 * 回测（2025-10 ~ 2026-10，深市 7 只，PCF 限额 + 收盘溢价）：
 *  - 限额放大 ≥2 倍后 5 日，相对同类的溢价平均回落 0.39pp（21/29 次回落）；
 *  - 限额收紧 ≥2 倍后 5 日，相对同类溢价平均上升 0.59pp；
 *  - 每日按新评分选对 vs 旧版「最高溢价→最低溢价」，持有 5 日相对收益 +0.21pp vs +0.14pp，胜率 60% vs 58%。
 * 结论：份额因子方向稳定但幅度不大，所以只占 25%~30%，价差仍是主项。
 *
 * v2.1（2026-10-29，360 交易日回填重测，见 ai-dca CN 运维项目 backfill/wbt*.py）：
 *  - 「相对同类溢价」近 5 个月几乎没有预测力（卖出分 5 日 IC 0.02），自身 60 日分位三段都稳定在 0.2 以上，
 *    单品权重改为 自身分位 60 / 份额 25 / 流动性 15，同类溢价只展示不计分；
 *  - 「暂停申购 → 溢价有支撑」没有得到验证（10 日相对溢价反而 −0.09pp），暂停申购按中性处理；
 *  - 新增「平价换基」：两只溢价相差 ≤0.5pp、卖出分 + 买入分 − 100 ≥ 10 时也值得换，
 *    回测 5 日相对溢价平均收敛约 0.27pp、胜率 63%~77%，三段都稳定。纸面跟踪，不发通知。
 */

export const SCORING_VERSION = 'v2.1-shadow-20261029';

/** 单品评分权重（满分 100）。peer=0：同类溢价只展示，不计分（v2.1）。 */
export const ETF_WEIGHTS = Object.freeze({ peer: 0, own: 60, quota: 25, liquidity: 15 });
/** 平价换基：溢价差绝对值上限（pp）与最低分数差 */
export const PARITY_MAX_SPREAD = 0.5;
export const PARITY_MIN_EDGE = 10;

const DEFAULT_COMMISSION_PCT = 0.01; // 单边佣金（%），保守取万一
const DEFAULT_SPREAD_BPS = 6; // 缺盘口时的默认买卖价差（bps）
const RELAX_RATIO = 2; // 限额放大 ≥2 倍视为放开
const STRONG_DELTA_R = 1; // 新增额度 ≥ 日均成交额 1% 视为实质放开（%）
const RELAXING_DAYS = 3; // 放开后 3 个交易日内视为「放开中」

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clip01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function mean(values) {
  const arr = values.filter(Number.isFinite);
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

function median(values) {
  const arr = values.filter((v) => v != null && (Number.isFinite(v) || v === Infinity)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** value 在 values 中的分位（0~1），样本不足返回 0.5 */
export function percentileRank(values, value) {
  const arr = values.filter(Number.isFinite);
  if (arr.length < 3 || !Number.isFinite(value)) return 0.5;
  return arr.filter((v) => v <= value).length / arr.length;
}

/**
 * PCF 记录 → 当日有效申购上限（份）。
 * 0 = 暂停申购；Infinity = 不设限；null = 无数据。取总量 / 净申购两个上限中较小者。
 */
export function effectiveSubscribeLimit(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.subscriptionAllowed === false) return 0;
  const caps = [];
  for (const key of ['totalSubscribeLimit', 'netSubscribeLimit']) {
    if (record[`${key}Kind`] === 'limited') {
      const v = num(record[`${key}Shares`]);
      if (v != null && v >= 0) caps.push(v);
    }
  }
  return caps.length ? Math.min(...caps) : Infinity;
}

const QUOTA_LABELS = {
  relax: '刚放开',
  relaxing: '放开中',
  steady: '额度稳定',
  tight: '刚收紧',
  closed: '暂停申购',
  unknown: '暂无额度数据',
};

/**
 * 份额状态。limits：[{ date, limit }] 按日期升序，最后一条是今天。
 * nav：单位净值；adtvYuan：20 日日均成交额（元）。
 */
export function classifyQuota(limits = [], { nav = null, adtvYuan = null } = {}) {
  const series = limits.filter((item) => item && item.limit !== null && item.limit !== undefined);
  const today = series[series.length - 1];
  const out = {
    state: 'unknown',
    label: QUOTA_LABELS.unknown,
    limitShares: null,
    prevLimitShares: null,
    unlimited: false,
    quotaRatioPct: null,
    deltaRatioPct: null,
    strong: false,
    changeDate: null,
  };
  if (!today) return out;
  const L = today.limit;
  out.limitShares = Number.isFinite(L) ? L : null;
  out.unlimited = L === Infinity;
  const prev = series.length >= 2 ? series[series.length - 2].limit : null;
  out.prevLimitShares = Number.isFinite(prev) ? prev : null;
  const navOk = Number.isFinite(nav) && nav > 0 && Number.isFinite(adtvYuan) && adtvYuan > 0;
  if (navOk && Number.isFinite(L)) out.quotaRatioPct = round((L * nav / adtvYuan) * 100, 3);

  const baseline = median(series.slice(-21, -1).map((item) => item.limit));
  const relaxedAt = (i) => {
    if (i < 1) return false;
    const a = series[i].limit; const b = series[i - 1].limit;
    if (a === Infinity && b !== Infinity) return true;
    return Number.isFinite(a) && Number.isFinite(b) && b >= 0 && a >= Math.max(b * RELAX_RATIO, b + 1) && a > 0;
  };
  const tightenedAt = (i) => {
    if (i < 1) return false;
    const a = series[i].limit; const b = series[i - 1].limit;
    if (b === Infinity && Number.isFinite(a)) return true;
    return Number.isFinite(a) && Number.isFinite(b) && b > 0 && a <= b / RELAX_RATIO;
  };
  const deltaRatio = (limit, base) => {
    if (!navOk) return null;
    if (limit === Infinity) return Infinity;
    const b = Number.isFinite(base) ? base : 0;
    return ((limit - b) * nav / adtvYuan) * 100;
  };
  const last = series.length - 1;

  if (L === 0) {
    out.state = 'closed';
  } else if (relaxedAt(last)) {
    out.state = 'relax';
    out.changeDate = today.date;
    const dr = deltaRatio(L, Math.min(Number.isFinite(prev) ? prev : Infinity, Number.isFinite(baseline) ? baseline : Infinity));
    out.deltaRatioPct = dr === Infinity ? null : round(dr, 3);
    out.strong = dr === Infinity || (dr != null && dr >= STRONG_DELTA_R);
  } else if (tightenedAt(last)) {
    out.state = 'tight';
    out.changeDate = today.date;
    const dr = deltaRatio(L, prev);
    out.deltaRatioPct = dr === Infinity ? null : round(dr, 3);
  } else {
    out.state = 'steady';
    for (let k = 1; k < RELAXING_DAYS && last - k >= 1; k += 1) {
      if (relaxedAt(last - k)) {
        // 放开后仍维持高额度才算「放开中」
        const relaxedLimit = series[last - k].limit;
        if (L === Infinity || (Number.isFinite(relaxedLimit) && L >= relaxedLimit * 0.8)) {
          out.state = 'relaxing';
          out.changeDate = series[last - k].date;
          const dr = deltaRatio(L, series[last - k - 1].limit);
          out.deltaRatioPct = dr === Infinity ? null : round(dr, 3);
          out.strong = dr === Infinity || (dr != null && dr >= STRONG_DELTA_R);
        }
        break;
      }
    }
  }
  out.label = QUOTA_LABELS[out.state];
  return out;
}

/** 份额因子：对卖出越有利越接近 1（买入取 1 − x） */
export function quotaSellFactor(quota) {
  switch (quota?.state) {
    case 'relax': return quota.strong ? 1 : 0.85;
    case 'relaxing': return quota.strong ? 0.85 : 0.7;
    case 'tight': return 0.1;
    // v2.1：回测里暂停申购并没有让溢价更坚挺，按中性处理
    case 'closed': return 0.45;
    case 'steady': {
      // 回测：额度/成交额 < 0.5% 的「近乎关门」基金相对同类溢价高 0.34pp，溢价更粘
      const r = quota.quotaRatioPct;
      if (Number.isFinite(r) && r < 0.5) return 0.3;
      return 0.45;
    }
    default: return 0.45;
  }
}

/**
 * 成交额统一为「元」。fund-metrics 的 turnover 通常是万元；早期个别快照是元（数值 ≥ 1e6，
 * 单只纳指 ETF 日成交不可能达到 1e6 万元 = 100 亿），据此区分。
 */
export function turnoverYuan(value) {
  const t = num(value);
  if (t == null || t <= 0) return null;
  return t >= 1e6 ? t : t * 1e4;
}

function liquidityFactor(etf, maxDepth) {
  const bps = num(etf?.bidAskSpreadBps);
  const depth = num(etf?.depth5);
  const spreadPart = bps == null ? 0.5 : clip01(1 - (bps - 3) / 10);
  const depthPart = depth == null || !maxDepth ? 0.5 : clip01(depth / maxDepth);
  return 0.5 * spreadPart + 0.5 * depthPart;
}

/**
 * 主入口。
 * @param {object} input
 *  - etfs: { code: { code, name, premium(%), latestNav, turnover(万元), bidAskSpreadBps, depth5 } } 今日快照
 *  - featureHistory: [{ date, etfs: {...} }] 升序，可含今日
 *  - limitHistory: { code: [{ date, limit }] } 升序，最后一条为今日
 *  - spreadHistory: number[] 历史每日最佳价差（%）
 *  - date: 今日
 */
export function scoreRadar({ etfs = {}, featureHistory = [], limitHistory = {}, spreadHistory = [], date = '' } = {}) {
  const codes = Object.keys(etfs).filter((code) => Number.isFinite(num(etfs[code]?.premium)));
  const premiums = Object.fromEntries(codes.map((code) => [code, num(etfs[code].premium)]));
  const peerMean = mean(Object.values(premiums));
  const pastDays = featureHistory.filter((day) => day?.date && day.date !== date);
  const maxDepth = Math.max(0, ...codes.map((code) => num(etfs[code]?.depth5) || 0));

  const perEtf = {};
  for (const code of codes) {
    const etf = etfs[code];
    const p = premiums[code];
    const hist = pastDays.slice(-60).map((day) => num(day?.etfs?.[code]?.premium)).filter(Number.isFinite);
    const turnovers = pastDays.slice(-20).map((day) => turnoverYuan(day?.etfs?.[code]?.turnover)).filter(Number.isFinite);
    const todayTurnover = turnoverYuan(etf.turnover);
    const adtvYuan = mean(turnovers.length ? turnovers : (todayTurnover != null ? [todayTurnover] : []));
    const adtvWan = adtvYuan != null ? adtvYuan / 1e4 : null;
    const quota = classifyQuota(limitHistory[code] || [], { nav: num(etf.latestNav), adtvYuan });
    const qs = quotaSellFactor(quota);
    const relPeer = clip01((p - peerMean) / 3 + 0.5); // 高于同类 1.5pp 即满分
    const ownPct = percentileRank(hist, p);
    const liq = liquidityFactor(etf, maxDepth);

    const W = ETF_WEIGHTS;
    let sell = W.peer * relPeer + W.own * ownPct + W.quota * qs + W.liquidity * liq;
    let sellTag = '';
    if (quota.state === 'relax' && quota.strong) {
      sell = Math.max(sell, 90);
      sellTag = '果断卖出';
    }
    let buy = W.peer * (1 - relPeer) + W.own * (1 - ownPct) + W.quota * (1 - qs) + W.liquidity * liq;
    let buyBlocked = '';
    if ((quota.state === 'relax' || quota.state === 'relaxing') && quota.strong) {
      buyBlocked = '等放开结束';
      buy = Math.min(buy, 20);
    }
    perEtf[code] = {
      code,
      name: etf.name || code,
      premium: round(p, 2),
      premiumVsPeer: round(p - peerMean, 2),
      premiumPercentile60: hist.length >= 3 ? round(ownPct * 100, 0) : null,
      historyDays: hist.length,
      adtvWan: round(adtvWan, 0),
      liquidity: round(liq * 100, 0),
      quota,
      sellScore: Math.round(sell),
      buyScore: Math.round(buy),
      sellTag,
      buyBlocked,
      parts: {
        sell: { peer: round(W.peer * relPeer, 1), own: round(W.own * ownPct, 1), quota: round(W.quota * qs, 1), liquidity: round(W.liquidity * liq, 1) },
        buy: { peer: round(W.peer * (1 - relPeer), 1), own: round(W.own * (1 - ownPct), 1), quota: round(W.quota * (1 - qs), 1), liquidity: round(W.liquidity * liq, 1) },
      },
    };
  }

  const costOf = (code) => {
    const bps = num(etfs[code]?.bidAskSpreadBps);
    return ((bps == null ? DEFAULT_SPREAD_BPS : bps) / 2) / 100 + DEFAULT_COMMISSION_PCT;
  };
  const histSpreads = spreadHistory.filter(Number.isFinite);
  const pairs = [];
  for (const s of codes) {
    for (const b of codes) {
      if (s === b) continue;
      const spread = premiums[s] - premiums[b];
      if (!(spread > 0)) continue;
      const cost = costOf(s) + costOf(b);
      const net = spread - cost;
      const spreadScore = 100 * (0.5 * clip01(net / 4) + 0.5 * (histSpreads.length >= 3 ? percentileRank(histSpreads, net) : clip01(net / 4)));
      const S = perEtf[s]; const B = perEtf[b];
      const blocked = Boolean(B.buyBlocked);
      const score = blocked ? 0 : 0.45 * spreadScore + 0.30 * S.sellScore + 0.25 * B.buyScore;
      const reasons = [];
      if (S.sellTag) reasons.push(`${S.name} ${S.quota.label}，溢价大概率回落`);
      else if (S.quota.state === 'relaxing') reasons.push(`${S.name} 额度放开中`);
      if (B.quota.state === 'tight') reasons.push(`${B.name} 额度刚收紧，溢价易升`);
      if (S.premiumPercentile60 != null && S.premiumPercentile60 >= 80) reasons.push(`${S.name} 溢价处于自身高位`);
      if (B.premiumPercentile60 != null && B.premiumPercentile60 <= 20) reasons.push(`${B.name} 溢价处于自身低位`);
      if (net <= 0) reasons.push('价差不够覆盖交易成本');
      pairs.push({
        sell: { code: s, name: S.name, premium: S.premium },
        buy: { code: b, name: B.name, premium: B.premium },
        spread: round(spread, 2),
        costPct: round(cost, 3),
        netSpread: round(net, 2),
        spreadScore: Math.round(spreadScore),
        sellScore: S.sellScore,
        buyScore: B.buyScore,
        score: Math.round(score),
        blocked: blocked ? B.buyBlocked : '',
        reasons,
      });
    }
  }
  pairs.sort((a, b) => b.score - a.score || b.netSpread - a.netSpread);

  // 平价换基：溢价差不多（|价差| ≤ 0.5pp），但卖出方看跌、买入方看涨，分数差够大也换
  const parity = [];
  for (const s of codes) {
    for (const b of codes) {
      if (s === b) continue;
      const S = perEtf[s]; const B = perEtf[b];
      if (B.buyBlocked) continue;
      const spread = premiums[s] - premiums[b];
      if (Math.abs(spread) > PARITY_MAX_SPREAD) continue;
      // 分数差只看「自身分位 + 份额」两项：流动性两边都是加分，算进来会让平均情形凭空多出 2×15×liq
      // 中性（分位 0.5、份额稳定）时两边合计 = 100 − 15 = 85，所以减 85；与回测口径（流动性取中性）一致
      const core = (side, item) => item.parts[side].own + item.parts[side].quota;
      const edge = Math.round(core('sell', S) + core('buy', B) - (100 - ETF_WEIGHTS.liquidity));
      if (edge < PARITY_MIN_EDGE) continue;
      const cost = costOf(s) + costOf(b);
      const reasons = [];
      if (S.premiumPercentile60 != null) reasons.push(`${S.name} 溢价在自身 60 日 p${S.premiumPercentile60}`);
      if (B.premiumPercentile60 != null) reasons.push(`${B.name} 溢价在自身 60 日 p${B.premiumPercentile60}`);
      if (S.sellTag) reasons.push(`${S.name} ${S.quota.label}`);
      else if (S.quota.state === 'relaxing') reasons.push(`${S.name} 额度放开中`);
      if (B.quota.state === 'tight') reasons.push(`${B.name} 额度刚收紧`);
      parity.push({
        sell: { code: s, name: S.name, premium: S.premium },
        buy: { code: b, name: B.name, premium: B.premium },
        spread: round(spread, 2),
        costPct: round(cost, 3),
        netSpread: round(spread - cost, 2),
        sellScore: S.sellScore,
        buyScore: B.buyScore,
        edge,
        reasons,
      });
    }
  }
  parity.sort((a, b) => b.edge - a.edge || b.spread - a.spread);
  const top = pairs.filter((pair) => !pair.blocked).slice(0, 5);
  return {
    version: SCORING_VERSION,
    mode: 'shadow',
    date,
    peerMeanPremium: round(peerMean, 2),
    weights: {
      switch: { spread: 45, sell: 30, buy: 25 },
      sell: { ...ETF_WEIGHTS },
      buy: { ...ETF_WEIGHTS },
      parity: { maxSpread: PARITY_MAX_SPREAD, minEdge: PARITY_MIN_EDGE },
    },
    etfs: perEtf,
    recommendedPair: top[0] || null,
    pairs: top,
    blockedPairs: pairs.filter((pair) => pair.blocked).slice(0, 3),
    parityPair: parity[0] || null,
    parityPairs: parity.slice(0, 3),
  };
}
