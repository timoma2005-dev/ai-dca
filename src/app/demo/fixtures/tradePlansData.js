// 交易计划演示数据（纯数据，无路由）：交易计划页与通知演示共用，避免两边各造一份、也避免 fixtures 之间循环引用。
// 格式按真实 store 造：plan.js serializePlanState（react-plan v2）/ dca.js serializeDcaState（react-dca v6），
// 外层 store 为 react-plan-store / react-dca-store v1（activePlanId / activeDcaId 指向最新创建的计划）。
// 标的与持仓演示一致：513100 / 159941 / 159513 场内 + 270042 场外联接；参考价对齐 2026-10-23 收盘（持仓演示 QUOTES）：
//   513100 回撤三档：阶段高点 2.38，第 1 档 -5%（2.261）已触发（现价 2.243），第 2 / 3 档未触发；
//   159513 回撤加仓：阶段高点 1.86，第 1 档 -5%（1.767）未触发，距现价 1.774 仅 0.4%；
//   159941 120 日线分层：120 日线 1.62，现价 1.668 在线上，三档均未触发；周四智能定投挂在这条策略上（高位只投 10%、余额进资金池）；
//   270042 联接月定投：每月 26 日 2,000 元（与持仓里 9 月那笔 2,000 元场外定投同额）。
// 真实 store 没有「档位已执行」字段：已触发 / 未触发由每档参考价与现价的关系体现（与真实计划一致）。
import { round } from '../../accumulation.js';
import { getStrategyParams } from '../../assetType.js';
import { buildDcaProjection } from '../../dca.js';
import { buildPlan } from '../../plan.js';

export const PLAN_STORE_KEY = 'aiDcaPlanStore';
export const PLAN_STATE_KEY = 'aiDcaPlanState';
export const DCA_STORE_KEY = 'aiDcaDcaStore';
export const DCA_STATE_KEY = 'aiDcaDcaState';
export const SELL_PLAN_STORE_KEY = 'aiDcaSellPlanStore';
export const SELL_PLAN_DRAFT_KEY = 'aiDcaSellPlanDraft';

/** 2026-10-23 收盘价（与持仓演示 QUOTES、270042 净值一致）。 */
export const TRADE_PLANS_DEMO_PRICES = Object.freeze({ 513100: 2.243, 159941: 1.668, 159513: 1.774, 270042: 7.9221 });

const PLAN_DEFS = [
  {
    id: 'demo-plan-159941-ma120', name: '纳指ETF广发 · 120 日线分层', symbol: '159941', selectedStrategy: 'ma120-risk',
    totalBudget: 20000, cashReservePct: 30, basePrice: 1.62, layerWeights: [40, 35, 25], triggerDrops: [0, 6, 12], createdAt: '2026-10-14T12:10:00.000Z',
  },
  {
    id: 'demo-plan-159513-drawdown', name: '纳斯达克100ETF大成 · 回撤加仓', symbol: '159513', selectedStrategy: 'peak-drawdown',
    totalBudget: 15000, cashReservePct: 20, basePrice: 1.86, layerWeights: [30, 30, 40], triggerDrops: [5, 10, 15], createdAt: '2026-10-12T13:05:00.000Z',
  },
  {
    id: 'demo-plan-513100-drawdown', name: '纳指ETF国泰 · 回撤三档加仓', symbol: '513100', selectedStrategy: 'peak-drawdown',
    totalBudget: 30000, cashReservePct: 20, basePrice: 2.38, layerWeights: [30, 30, 40], triggerDrops: [5, 10, 15], createdAt: '2026-10-09T12:30:00.000Z',
  },
];

const DCA_DEFS = [
  {
    id: 'demo-dca-270042-monthly', name: '广发纳指100联接A · 月定投', symbol: '270042', initialInvestment: 0, recurringInvestment: 2000,
    frequency: '每月', executionDay: 26, termMonths: 24, targetReturn: 20, linkedPlanId: '', currentPrice: TRADE_PLANS_DEMO_PRICES[270042],
    rollingHigh: 8.159, capitalPool: 0, currentLevel: -1, createdAt: '2026-10-16T12:20:00.000Z',
  },
  {
    // 10-15 首期：高位只投 10%（150 元不足 1 手，未成交），1,350 元进资金池；序列化后资金池按下一期预估累加（同 serializeDcaState）。
    id: 'demo-dca-159941-weekly', name: '纳指ETF广发 · 周四智能定投', symbol: '159941', initialInvestment: 0, recurringInvestment: 1500,
    frequency: '每周', executionDay: 4, termMonths: 12, targetReturn: 25, linkedPlanId: 'demo-plan-159941-ma120', currentPrice: TRADE_PLANS_DEMO_PRICES[159941],
    rollingHigh: 1.75, capitalPool: 1350, currentLevel: -1, createdAt: '2026-10-14T12:15:00.000Z',
  },
];

export const TRADE_PLANS_DEMO_IDS = Object.freeze(new Set([...PLAN_DEFS, ...DCA_DEFS].map((item) => item.id)));

/** 同 plan.js serializePlanState 的字段与取整；notify 为通知预设一键开启后写入的开关。 */
function serializeDemoPlan(def) {
  const computed = buildPlan(def);
  return {
    source: 'react-plan', version: 2, id: def.id, name: def.name, symbol: def.symbol,
    totalBudget: round(def.totalBudget, 2), cashReservePct: round(def.cashReservePct, 2), basePrice: round(def.basePrice, 2),
    riskControlPrice: round(def.basePrice * 0.85, 2), selectedStrategy: def.selectedStrategy, isConfigured: true, frequency: '每周',
    layerWeights: computed.layerWeights.map((value) => round(value, 4)), triggerDrops: computed.triggerDrops.map((value) => round(value, 4)),
    assetType: 'fund', strategyParams: getStrategyParams(def.symbol), screeningAnswers: {}, screeningResult: null,
    investableCapital: round(computed.investableCapital, 2), reserveCapital: round(computed.reserveCapital, 2), averageCost: round(computed.averageCost, 2),
    createdAt: def.createdAt, updatedAt: def.createdAt, notify: { enabled: true },
  };
}

/** 同 dca.js serializeDcaState 的字段与取整。 */
function serializeDemoDca(def, planList) {
  const computed = buildDcaProjection(def, { planList });
  return {
    source: 'react-dca', version: 6, id: def.id, name: def.name, symbol: computed.effectiveSymbol,
    initialInvestment: round(def.initialInvestment, 2), recurringInvestment: round(def.recurringInvestment, 2), frequency: def.frequency,
    executionDay: def.executionDay, termMonths: def.termMonths, targetReturn: round(def.targetReturn, 2),
    currentPrice: round(def.currentPrice, 4), rollingHigh: round(def.rollingHigh, 4), capitalPool: round(computed.poolBalance, 2),
    currentLevel: Math.max(Number(def.currentLevel) || computed.smartLevel || -1, -1), linkedPlanId: def.linkedPlanId,
    executionCount: computed.executionCount, totalInvestment: round(computed.totalInvestment, 2), cadenceLabel: computed.cadenceLabel,
    nextExecutionAmount: round(computed.nextExecutionAmount, 2), linkedPlanFirstInvestment: round(computed.linkedPlanFirstInvestment, 2),
    smartDcaMode: computed.smartDcaMode, poolBalance: round(computed.poolBalance, 2), dropPct: round(computed.dropPct, 2),
    isConfigured: true, createdAt: def.createdAt, updatedAt: def.createdAt, notify: { enabled: true },
  };
}

export function buildTradePlansDemoStores() {
  const plans = PLAN_DEFS.map(serializeDemoPlan);
  const dcaPlans = DCA_DEFS.map((def) => serializeDemoDca(def, plans));
  return {
    planStore: { source: 'react-plan-store', version: 1, activePlanId: plans[0].id, plans },
    dcaStore: { source: 'react-dca-store', version: 1, activeDcaId: dcaPlans[0].id, plans: dcaPlans },
    sellPlans: [],
  };
}

/** 演示存储覆盖层：交易 / 定投计划（含当前激活计划副本）、清空卖出计划与草稿（演示中视为不存在）。 */
export function tradePlansDemoSeed() {
  const { planStore, dcaStore, sellPlans } = buildTradePlansDemoStores();
  return [
    [PLAN_STORE_KEY, JSON.stringify(planStore)],
    [PLAN_STATE_KEY, JSON.stringify(planStore.plans[0])],
    [DCA_STORE_KEY, JSON.stringify(dcaStore)],
    [DCA_STATE_KEY, JSON.stringify(dcaStore.plans[0])],
    [SELL_PLAN_STORE_KEY, JSON.stringify(sellPlans)],
    [SELL_PLAN_DRAFT_KEY, null],
  ];
}
