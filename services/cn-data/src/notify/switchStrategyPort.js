const FUND_CODE_PATTERN = /^\d{6}$/;
export const MAX_CANDIDATES = 20;
export const MAX_SWITCH_RULES = 12;
// 与前端 SwitchStrategyExperience 的 DEFAULT_PREFS 保持一致。
// v4 规则基准 + H/L 双维度：
//   benchmarkCodes = 当前规则基准（默认来自持仓，也允许前端手动设置未持有模拟基准）
//   enabledCodes   = 用户挑选的候选（前端按 H/L 分类做对侧过滤后下发）
//   premiumClass   = 每只 ETF 的「溢价中枢」分类 'H' | 'L'，与持仓/候选解耦
//   触发方向锚定在 benchmark 的分类：
//     bench ∈ L 持有 → 仅看规则 A：gap = H溢价 − L溢价 < X% → 卖 bench(L) 买 cand(H)
//     bench ∈ H 持有 → 仅看规则 B：gap = H溢价 − L溢价 > Y% → 卖 bench(H) 买 cand(L)
//     同类、未分类、cand 未分类 都不触发。
export const DEFAULT_INTRA_SELL_LOWER_PCT = 1;   // 规则 A：溢价差收窄阈值
export const DEFAULT_INTRA_BUY_OTHER_PCT = 3;    // 规则 B：溢价差扩大阈值
export const DEFAULT_OTC_PREMIUM_THRESHOLD_PCT = 8;
export const DEFAULT_OTC_MIN_INTRA_PREMIUM_LOW = 1;
export const DEFAULT_OTC_MIN_INTRA_PREMIUM_HIGH = 2;
export const DEFAULT_ARB_TARGET_PCT = 2;
export const VALID_BACKTEST_TIMEFRAMES = new Set(['5m', '15m', '30m', '60m', '1d']);

function sanitizeCode(value) {
  const code = String(value || '').trim();
  return FUND_CODE_PATTERN.test(code) ? code : '';
}

function pickPercent(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  // 阈值限为 [-50, 50]，防止脱疑配置。
  if (num < -50) return -50;
  if (num > 50) return 50;
  return num;
}

function defaultSwitchRuleName(index = 0) {
  return index === 0 ? '默认规则' : `规则 ${index + 1}`;
}

function sanitizeRuleId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9:_-]{1,64}$/.test(id) ? id : '';
}

function sanitizeRuleText(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength);
}

function sanitizeRuleNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
}

function sanitizeRuleCodeList(values = []) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const code = sanitizeCode(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    result.push(code);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

function normalizeFeeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result = {};
  result.mode = input.mode === 'estimated_total' ? 'estimated_total' : 'detailed';
  for (const field of ['sellCommissionRate', 'buyCommissionRate', 'minimumCommission', 'otherFee', 'estimatedTotalFee']) {
    const value = sanitizeRuleNumber(input[field]);
    if (value != null) result[field] = value;
  }
  return result;
}

function normalizeSwitchRule(input = {}, index = 0, { defaultEnabled = true, readEnabled = true } = {}) {
  const rawBenchmarks = Array.isArray(input?.benchmarkCodes)
    ? input.benchmarkCodes
    : (input?.benchmarkCode ? [input.benchmarkCode] : []);
  const benchmarkCodes = [];
  const seen = new Set();
  for (const raw of rawBenchmarks) {
    const code = sanitizeCode(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    benchmarkCodes.push(code);
    if (benchmarkCodes.length >= MAX_CANDIDATES) break;
  }
  const enabledCodesRaw = Array.isArray(input?.enabledCodes)
    ? input.enabledCodes
    : Array.isArray(input?.candidateCodes) ? input.candidateCodes : [];
  const enabledCodes = [];
  for (const raw of enabledCodesRaw) {
    const code = sanitizeCode(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    enabledCodes.push(code);
    if (enabledCodes.length >= MAX_CANDIDATES) break;
  }
  const premiumClass = {};
  const rawClass = (input && typeof input.premiumClass === 'object' && input.premiumClass) ? input.premiumClass : {};
  const validCodes = new Set([...benchmarkCodes, ...enabledCodes]);
  for (const [code, value] of Object.entries(rawClass)) {
    const c = sanitizeCode(code);
    if (!c || !validCodes.has(c)) continue;
    const v = String(value || '').trim().toUpperCase();
    if (v === 'H' || v === 'L') premiumClass[c] = v;
  }
  // 旧版本允许 H/L 混合作为 benchmark，代表双向监控。现在统一迁移为
  // 单向规则：优先保留原持仓代码所属分组，其余分组降为候选方。
  const benchmarkClasses = new Set(benchmarkCodes.map((code) => premiumClass[code]).filter(Boolean));
  let normalizedBenchmarkCodes = benchmarkCodes;
  let normalizedEnabledCodes = enabledCodes;
  if (benchmarkClasses.size > 1) {
    const requestedHoldingCode = sanitizeCode(input?.holdingFundCode);
    const holdingClass = premiumClass[requestedHoldingCode] === 'L' || premiumClass[requestedHoldingCode] === 'H'
      ? premiumClass[requestedHoldingCode]
      : premiumClass[benchmarkCodes[0]] || 'H';
    normalizedBenchmarkCodes = benchmarkCodes.filter((code) => premiumClass[code] === holdingClass);
    const movedCodes = benchmarkCodes.filter((code) => !normalizedBenchmarkCodes.includes(code));
    normalizedEnabledCodes = Array.from(new Set([...enabledCodes, ...movedCodes]))
      .filter((code) => !normalizedBenchmarkCodes.includes(code))
      .slice(0, MAX_CANDIDATES);
  }
  const rawName = String(input?.name || input?.ruleName || '').trim();
  const rawEnabled = readEnabled ? input?.enabled : undefined;
  const candidateFundCodes = sanitizeRuleCodeList(input?.candidateFundCodes || normalizedEnabledCodes);
  const holdingFundCode = sanitizeCode(input?.holdingFundCode || normalizedBenchmarkCodes[0]);
  const holdingQuantity = sanitizeRuleNumber(input?.holdingQuantity);
  const holdingNotional = sanitizeRuleNumber(input?.holdingNotional);
  const feeConfig = normalizeFeeConfig(input?.feeConfig);
  const backtestTimeframe = VALID_BACKTEST_TIMEFRAMES.has(String(input?.backtestTimeframe || ''))
    ? String(input.backtestTimeframe)
    : '5m';
  return {
    id: sanitizeRuleId(input?.id || input?.ruleId) || `rule-${index + 1}`,
    name: (rawName || defaultSwitchRuleName(index)).slice(0, 40),
    enabled: rawEnabled === undefined ? Boolean(defaultEnabled) : Boolean(rawEnabled),
    benchmarkCodes: normalizedBenchmarkCodes,
    enabledCodes: normalizedEnabledCodes,
    premiumClass,
    arbTargetPct: pickPercent(input?.arbTargetPct, DEFAULT_ARB_TARGET_PCT),
    intraSellLowerPct: pickPercent(input?.intraSellLowerPct, DEFAULT_INTRA_SELL_LOWER_PCT),
    intraBuyOtherPct: pickPercent(input?.intraBuyOtherPct, DEFAULT_INTRA_BUY_OTHER_PCT),
    otcPremiumThresholdPct: pickPercent(input?.otcPremiumThresholdPct, DEFAULT_OTC_PREMIUM_THRESHOLD_PCT),
    otcMinIntraPremiumLow: pickPercent(input?.otcMinIntraPremiumLow, DEFAULT_OTC_MIN_INTRA_PREMIUM_LOW),
    otcMinIntraPremiumHigh: pickPercent(input?.otcMinIntraPremiumHigh, DEFAULT_OTC_MIN_INTRA_PREMIUM_HIGH),
    holdingFundCode,
    holdingFundName: sanitizeRuleText(input?.holdingFundName),
    holdingQuantity,
    holdingNotional,
    candidateFundCodes,
    feeConfig,
    backtestTimeframe
  };
}

// 配置与前端 aiDcaSwitchStrategyPrefs 同名，不重复定义一套参数。
// v4 规则基准 + H/L 单向持仓（benchmarkCodes 决定当前持仓，H/L 决定方向）：
//  - benchmarkCodes: 当前规则基准；通常来自持仓，也可包含未持有模拟基准
//  - enabledCodes:   候选（前端按 premiumClass 过滤后只剩对侧）
//  - premiumClass:   { [code]: 'H' | 'L' }，每只 ETF 的溢价中枢标签
//  - intraSellLowerPct / intraBuyOtherPct: 场内阈值，与页面同名同义。
//  - otcPremiumThresholdPct / otcMinIntraPremiumLow / otcMinIntraPremiumHigh: 场外切换阈值。
//  - 触发逻辑：每对 (bench, cand) 仅当 cand.class !== bench.class 且都已分类时考虑：
//      bench=L → 看 gap = H溢价 − L溢价 < sellLower → 规则 A：卖 bench(L) 买 cand(H)
//      bench=H → 看 gap > buyOther                  → 规则 B：卖 bench(H) 买 cand(L)
//  - 未分类的 bench 或 cand：不触发，前端会有提示。
export function normalizeSwitchConfig(input = {}) {
  const rawRules = Array.isArray(input?.rules) ? input.rules : [];
  const rules = [];
  const usedIds = new Set();
  if (rawRules.length) {
    for (const rawRule of rawRules.slice(0, MAX_SWITCH_RULES)) {
      const normalizedRule = normalizeSwitchRule(rawRule, rules.length);
      let id = normalizedRule.id;
      if (usedIds.has(id)) id = `${id}-${rules.length + 1}`;
      usedIds.add(id);
      rules.push({ ...normalizedRule, id });
    }
  } else {
    const legacyRule = normalizeSwitchRule({
      ...input,
      id: input?.ruleId || 'rule-1',
      name: input?.ruleName || input?.name || '默认规则'
    }, 0, { defaultEnabled: true, readEnabled: false });
    rules.push(legacyRule);
    usedIds.add(legacyRule.id);
  }
  if (!rules.length) rules.push(normalizeSwitchRule({ id: 'rule-1', name: '默认规则' }, 0));
  const requestedActiveId = sanitizeRuleId(input?.activeRuleId);
  const activeRule = rules.find((rule) => rule.id === requestedActiveId) || rules[0];
  return {
    enabled: Boolean(input?.enabled),
    activeRuleId: activeRule.id,
    rules,
    ruleEnabled: activeRule.enabled,
    ruleName: activeRule.name,
    benchmarkCodes: activeRule.benchmarkCodes,
    enabledCodes: activeRule.enabledCodes,
    premiumClass: activeRule.premiumClass,
    arbTargetPct: activeRule.arbTargetPct,
    intraSellLowerPct: activeRule.intraSellLowerPct,
    intraBuyOtherPct: activeRule.intraBuyOtherPct,
    otcPremiumThresholdPct: activeRule.otcPremiumThresholdPct,
    otcMinIntraPremiumLow: activeRule.otcMinIntraPremiumLow,
    otcMinIntraPremiumHigh: activeRule.otcMinIntraPremiumHigh,
    clientLabel: String(input?.clientLabel || '').trim().slice(0, 120),
    updatedAt: String(input?.updatedAt || '').trim() || new Date().toISOString()
  };
}

function isSwitchRuleRunnable(rule) {
  if (!rule || !rule.enabled) return false;
  if (!Number.isFinite(rule.intraSellLowerPct) || !Number.isFinite(rule.intraBuyOtherPct)) return false;
  if (rule.intraBuyOtherPct <= rule.intraSellLowerPct) return false;
  const benches = Array.isArray(rule.benchmarkCodes) ? rule.benchmarkCodes : [];
  if (!benches.length) return false;
  const enabled = Array.isArray(rule.enabledCodes) ? rule.enabledCodes : [];
  const benchSet = new Set(benches);
  const hasOtcCandidates = enabled.some((c) => c && !benchSet.has(c));
  const cls = (rule && typeof rule.premiumClass === 'object' && rule.premiumClass) ? rule.premiumClass : {};
  const pool = Array.from(new Set([...benches, ...enabled])).filter((c) => cls[c] === 'H' || cls[c] === 'L');
  for (const b of benches) {
    const bc = cls[b];
    if (bc !== 'H' && bc !== 'L') continue;
    const opp = bc === 'H' ? 'L' : 'H';
    if (pool.some((c) => c !== b && cls[c] === opp)) return true;
  }
  return hasOtcCandidates;
}

export function getRunnableSwitchRules(input = {}, { forceEnabled = false } = {}) {
  const config = normalizeSwitchConfig(input);
  if (!forceEnabled && !config.enabled) return [];
  return (config.rules || []).filter((rule) => isSwitchRuleRunnable(rule));
}
