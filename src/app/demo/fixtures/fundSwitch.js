// 基金切换（fundSwitch）演示 mock：纳指 QDII ETF 高 / 低溢价轮动。
// 换基页演示期间发出的 GET（均带账号令牌 / 演示占位令牌，经 switchStrategySync.requestSwitch，主域名与 CF 备用域名同 pathname）：
//   GET /api/notify/switch/config    方案配置（结构同 Worker handleFastSwitchConfig：{ ok, clientId, config }）
//   GET /api/notify/switch/snapshot  方案快照（结构同 switchDecoupledPipeline 的 accountSnapshot + 今日命中次数）
// 快照里每条启用方案都带溢价，看板首屏不会再补发 POST /api/notify/switch/test。
// 写入（保存 / 启停 / 删除方案、测试、自动填充）不提供 mock，由演示框架按写入拦截（403）。
// 本地持久：从回测「一键生成方案」写入的换基偏好（aiDcaSwitchStrategyPrefs）保留 15 分钟，注册 / 升级后带入账号。
import { RADAR_DEMO_ETFS } from './adminRadar.js';
import { getPreviousTradingDayShanghai, isTradingDayShanghai } from '../../holidaysCN.js';

export const SWITCH_CONFIG_PATH = '/api/notify/switch/config';
export const SWITCH_SNAPSHOT_PATH = '/api/notify/switch/snapshot';
export const SWITCH_CONFIG_CACHE_KEY = 'aiDcaSwitchStrategyWorkerConfig';
export const SWITCH_PREFS_KEY = 'aiDcaSwitchStrategyPrefs';
export const SWITCH_RULE_CHANNELS_KEY = 'aiDcaSwitchRuleChannels';
export const SWITCH_DEMO_CLIENT_ID = 'demo-client';

// 示例单位净值（IOPV 中枢），按日小幅浮动；溢价中枢沿用雷达演示，两个演示的数值口径一致。
const NAV_BASE = {
  513100: 1.652, 159501: 1.488, 159941: 1.214, 159696: 1.535, 159659: 1.802, 159632: 1.731,
  513300: 1.946, 513870: 1.402, 513110: 1.873, 159660: 1.596, 513390: 1.517, 159513: 1.468,
};
const ETF_BY_CODE = new Map(RADAR_DEMO_ETFS.map((item) => [item.code, item]));

// 三条示例方案：持有高溢价等切出 / 持有低溢价等切回 / 一条已暂停。
export const SWITCH_DEMO_RULES = Object.freeze([
  {
    id: 'demo-ndx-h2l',
    name: '国泰纳指 高溢价切出',
    enabled: true,
    high: ['513100'],
    low: ['159513', '513110'],
    holding: 'H',
    lowerPct: 2,
    upperPct: 4,
    holdingQuantity: 20000,
  },
  {
    id: 'demo-ndx-l2h',
    name: '华安纳指 低溢价等切回',
    enabled: true,
    high: ['159501', '159941'],
    low: ['159632'],
    holding: 'L',
    lowerPct: 2.5,
    upperPct: 5,
    holdingQuantity: 15000,
  },
  {
    id: 'demo-ndx-gf-bs',
    name: '广发 / 博时 轮动（观察）',
    enabled: false,
    high: ['159941'],
    low: ['513390'],
    holding: 'H',
    lowerPct: 1.5,
    upperPct: 5.5,
    holdingQuantity: 0,
  },
]);

// 确定性抖动（-1, 1）：同一时刻数值稳定，刷新不跳。
function fnv(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function jitter(seed) {
  return (fnv(seed) % 20001) / 10000 - 1;
}

function shanghaiParts(ms) {
  const iso = new Date(Number(ms) + 8 * 3600 * 1000).toISOString();
  return { day: iso.slice(0, 10), minutes: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) };
}

function shanghaiIso(day, minutes) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, minutes) - 8 * 3600 * 1000).toISOString();
}

/** 最近一次行情采集时刻：交易时段内取当前分钟；午休取 11:30；收盘后 / 非交易日取最近交易日 15:00。 */
export function switchDemoComputedAt(now = Date.now()) {
  const { day, minutes } = shanghaiParts(now);
  if (isTradingDayShanghai(day)) {
    if (minutes >= 15 * 60) return shanghaiIso(day, 15 * 60);
    if (minutes >= 13 * 60) return shanghaiIso(day, minutes);
    if (minutes >= 11 * 60 + 30) return shanghaiIso(day, 11 * 60 + 30);
    if (minutes >= 9 * 60 + 30) return shanghaiIso(day, minutes);
  }
  return shanghaiIso(getPreviousTradingDayShanghai(day), 15 * 60);
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function fundAt(code, computedAt) {
  const { day } = shanghaiParts(Date.parse(computedAt));
  const minuteKey = computedAt.slice(0, 16);
  const etf = ETF_BY_CODE.get(code);
  const iopv = round(NAV_BASE[code] * (1 + jitter(`nav:${day}:${code}`) * 0.012), 4);
  const premiumTarget = etf.base + jitter(`day:${day}`) * 0.6 + jitter(`${day}:${code}`) * 0.4 + jitter(`${minuteKey}:${code}`) * 0.05;
  const price = round(iopv * (1 + premiumTarget / 100), 3);
  return { code, name: etf.name, price, iopv, premiumPct: round(((price - iopv) / iopv) * 100, 4), asOf: computedAt };
}

function premiumClassOf(rule) {
  return Object.fromEntries([...rule.high.map((code) => [code, 'H']), ...rule.low.map((code) => [code, 'L'])]);
}

/** 演示方案配置（与前端 normalizeSwitchConfigShape 输入兼容的 Worker 结构）。 */
export function buildSwitchDemoConfig(now = Date.now()) {
  const computedAt = switchDemoComputedAt(now);
  const snapDay = shanghaiParts(Date.parse(computedAt)).day;
  const rules = SWITCH_DEMO_RULES.map((rule) => {
    const benchmarkCodes = rule.holding === 'L' ? rule.low : rule.high;
    const enabledCodes = rule.holding === 'L' ? rule.high : rule.low;
    const holdingFundCode = benchmarkCodes[0];
    const holding = fundAt(holdingFundCode, computedAt);
    return {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      benchmarkCodes: [...benchmarkCodes],
      enabledCodes: [...enabledCodes],
      premiumClass: premiumClassOf(rule),
      arbTargetPct: 2,
      intraSellLowerPct: rule.lowerPct,
      intraBuyOtherPct: rule.upperPct,
      otcPremiumThresholdPct: 8,
      otcMinIntraPremiumLow: 1,
      otcMinIntraPremiumHigh: 2,
      holdingFundCode,
      holdingFundName: holding.name,
      holdingQuantity: rule.holdingQuantity || null,
      holdingNotional: rule.holdingQuantity ? round(rule.holdingQuantity * holding.price, 2) : null,
      candidateFundCodes: [...enabledCodes],
      feeConfig: {},
      backtestTimeframe: '5m',
    };
  });
  const active = rules[0];
  return {
    enabled: true,
    activeRuleId: active.id,
    rules,
    ruleEnabled: active.enabled,
    ruleName: active.name,
    benchmarkCodes: active.benchmarkCodes,
    enabledCodes: active.enabledCodes,
    premiumClass: active.premiumClass,
    arbTargetPct: active.arbTargetPct,
    intraSellLowerPct: active.intraSellLowerPct,
    intraBuyOtherPct: active.intraBuyOtherPct,
    otcPremiumThresholdPct: active.otcPremiumThresholdPct,
    otcMinIntraPremiumLow: active.otcMinIntraPremiumLow,
    otcMinIntraPremiumHigh: active.otcMinIntraPremiumHigh,
    clientLabel: '账号通知 · 演示账号',
    updatedAt: shanghaiIso(getPreviousTradingDayShanghai(snapDay), 20 * 60 + 12),
  };
}

function classify(benchClass, candClass, gap, sellLower, buyOther) {
  if (!Number.isFinite(gap) || benchClass === candClass) return 'none';
  if (benchClass === 'L' && candClass === 'H' && gap <= sellLower) return 'A';
  if (benchClass === 'H' && candClass === 'L' && gap >= buyOther) return 'B';
  return 'none';
}

function snapshotIdFor(computedAt) {
  const digits = computedAt.replace(/[^0-9]/g, '').slice(0, 14);
  return `switch-${digits}-${fnv(`snapshot:${computedAt}`).toString(16).padStart(8, '0')}`;
}

/** 演示快照（结构同 switchDecoupledPipeline 写入的账号快照，并附 handleFastSwitchSnapshot 的今日命中次数）。 */
export function buildSwitchDemoSnapshot(now = Date.now()) {
  const computedAt = switchDemoComputedAt(now);
  const snapshotId = snapshotIdFor(computedAt);
  const source = 'market-collector';
  const today = shanghaiParts(now).day;
  const snapIsToday = shanghaiParts(Date.parse(computedAt)).day === today;
  const config = buildSwitchDemoConfig(now);
  const rules = config.rules.map((rule) => {
    const pool = [...rule.benchmarkCodes, ...rule.enabledCodes];
    const funds = Object.fromEntries(pool.map((code) => [code, fundAt(code, computedAt)]));
    let fired = 0;
    const byBenchmark = rule.benchmarkCodes.map((benchmarkCode) => {
      const bench = funds[benchmarkCode];
      const benchmarkClass = rule.premiumClass[benchmarkCode] || null;
      const candidates = pool.filter((code) => code !== benchmarkCode).map((code) => {
        const item = funds[code];
        const spreadVsBenchmarkPct = round(bench.premiumPct - item.premiumPct, 4);
        const candClass = rule.premiumClass[code] || null;
        const gap = benchmarkClass === 'H' ? spreadVsBenchmarkPct : -spreadVsBenchmarkPct;
        if (classify(benchmarkClass, candClass, gap, rule.intraSellLowerPct, rule.intraBuyOtherPct) !== 'none') fired += 1;
        return {
          code,
          name: item.name,
          price: item.price,
          nav: item.iopv,
          navDate: item.asOf,
          premiumPct: item.premiumPct,
          orderBook: null,
          spreadVsBenchmarkPct,
          candClass,
          valid: true,
        };
      });
      return {
        benchmarkCode,
        benchmarkName: bench.name,
        benchmarkClass,
        benchmarkPrice: bench.price,
        benchmarkNav: bench.iopv,
        benchmarkNavDate: bench.asOf,
        benchmarkPremiumPct: bench.premiumPct,
        benchmarkOrderBook: null,
        valid: true,
        candidates,
      };
    });
    // 今日命中：只统计今天已推送的触发（同一交易日每对最多 3 次）；非交易日 / 盘前为 0，暂停的方案不推送。
    const todayTriggerCount = rule.enabled && snapIsToday && fired > 0 ? Math.min(3, fired) : 0;
    const ruleSnapshot = {
      snapshotId,
      computedAt,
      source,
      ruleId: rule.id,
      ruleName: rule.name,
      premiumClass: rule.premiumClass,
      intraSellLowerPct: Number(rule.intraSellLowerPct),
      intraBuyOtherPct: Number(rule.intraBuyOtherPct),
      byBenchmark,
      signals: [],
      triggers: [],
      ready: true,
      hitCount: todayTriggerCount,
      todayTriggerCount,
    };
    return { ruleId: rule.id, ruleName: rule.name, ready: true, triggerCount: 0, hitCount: todayTriggerCount, todayTriggerCount, snapshot: ruleSnapshot };
  });
  return {
    snapshotId,
    computedAt,
    source,
    activeRuleId: config.activeRuleId,
    ready: true,
    rules,
    triggers: [],
    demo: true,
  };
}

export default {
  keepKeys: [SWITCH_PREFS_KEY],
  // 首屏读本地缓存时就显示演示方案（不闪出账号里原有的缓存）；通知渠道给示例方案配上已连接渠道。
  seed() {
    return [
      [SWITCH_CONFIG_CACHE_KEY, JSON.stringify(buildSwitchDemoConfig())],
      [SWITCH_RULE_CHANNELS_KEY, JSON.stringify({ 'demo-ndx-h2l': ['ios', 'email'], 'demo-ndx-l2h': ['serverchan3', 'pc'] })],
    ];
  },
  createFixtures() {
    return {
      routes: {
        [`GET ${SWITCH_CONFIG_PATH}`]: () => ({ ok: true, clientId: SWITCH_DEMO_CLIENT_ID, config: buildSwitchDemoConfig() }),
        [`GET ${SWITCH_SNAPSHOT_PATH}`]: () => ({ ok: true, snapshot: buildSwitchDemoSnapshot(), config: buildSwitchDemoConfig() }),
      },
    };
  },
};
