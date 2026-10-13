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

export function collectSwitchConfigCodes(input = {}) {
  const config = normalizeSwitchConfig(input);
  const codes = new Set();
  for (const rule of config.rules || []) {
    for (const code of (rule.benchmarkCodes || [])) codes.add(code);
    for (const code of (rule.enabledCodes || [])) codes.add(code);
  }
  return Array.from(codes);
}


export function getShanghaiHourMinute(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const hourRaw = parts.hour === '24' ? '00' : parts.hour;
  return {
    weekday: String(parts.weekday || ''),
    hour: Number(hourRaw),
    minute: Number(parts.minute || '0')
  };
}

export function isInTradingSession(date = new Date()) {
  const { weekday, hour, minute } = getShanghaiHourMinute(date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const m = hour * 60 + minute;
  // 上午：09:30-11:30；下午：13:00-15:00。
  if (m >= 570 && m <= 690) return true;
  if (m >= 780 && m <= 900) return true;
  return false;
}

export function getShanghaiDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}


const MAX_SWITCH_PUSHES_PER_TRADING_DAY = 3;

// per-pair dedup：同一交易日内同一 rule 最多推 3 次；跨交易日重新计数。
function classifyRule({ benchClass, candClass, gap, sellLower, buyOther }) {
  if (!Number.isFinite(gap)) return 'none';
  if (benchClass !== 'H' && benchClass !== 'L') return 'none';
  if (candClass !== 'H' && candClass !== 'L') return 'none';
  if (benchClass === candClass) return 'none';
  if (benchClass === 'L' && gap <= sellLower) return 'A';
  if (benchClass === 'H' && gap >= buyOther) return 'B';
  return 'none';
}

function readDailyTriggerCount(prev = {}, rule = '', signalDate = '') {
  const prevRule = String(prev.lastTriggeredRule || prev.rule || '').trim();
  const prevDate = String(prev.lastTriggeredDate || '').trim();
  if (prevRule !== rule || prevDate !== signalDate) return 0;
  return Math.max(0, Number.parseInt(String(prev.dailyTriggerCount || '0'), 10) || 0);
}

function buildTriggerCounterState(prev = {}, rule = '', signalDate = '', didTrigger = false) {
  if (rule === 'none') {
    return {
      lastTriggeredDate: String(prev.lastTriggeredDate || '').trim(),
      lastTriggeredRule: String(prev.lastTriggeredRule || '').trim(),
      dailyTriggerCount: Math.max(0, Number.parseInt(String(prev.dailyTriggerCount || '0'), 10) || 0)
    };
  }
  const prevCount = readDailyTriggerCount(prev, rule, signalDate);
  return {
    lastTriggeredDate: signalDate,
    lastTriggeredRule: rule,
    dailyTriggerCount: didTrigger ? prevCount + 1 : prevCount
  };
}

export function evaluateSwitchTriggers(snapshot, prevTriggerStates = {}) {
  const sellLower = Number(snapshot.intraSellLowerPct);
  const buyOther = Number(snapshot.intraBuyOtherPct);
  const premiumClass = (snapshot && typeof snapshot.premiumClass === 'object' && snapshot.premiumClass) ? snapshot.premiumClass : {};
  const signalDate = getShanghaiDateKey(snapshot?.computedAt || Date.now());
  const nextTriggerStates = {};
  const triggers = [];

  function preservePreviousOtcStates() {
    for (const [key, value] of Object.entries(prevTriggerStates || {})) {
      if (String(key).startsWith('otc:')) nextTriggerStates[key] = value;
    }
  }

  const groups = Array.isArray(snapshot.byBenchmark) ? snapshot.byBenchmark : [];
  for (const group of groups) {
    const benchmark = group?.benchmarkCode || '';
    const benchName = group?.benchmarkName || '';
    if (!benchmark) continue;
    const benchClass = premiumClass[benchmark];
    for (const cand of group.candidates || []) {
      const pairKey = `${benchmark}:${cand.code}`;
      const candClass = premiumClass[cand.code];
      // Number(null) 会变成 0，会被误当作「diff = 0%」。仅在原始值为 number 时才计算。
      const rawDiff = cand.spreadVsBenchmarkPct;
      const diff = (typeof rawDiff === 'number' && Number.isFinite(rawDiff)) ? rawDiff : NaN;
      if (!Number.isFinite(diff)) {
        const prev = prevTriggerStates?.[pairKey];
        if (prev) nextTriggerStates[pairKey] = prev;
        continue;
      }
      // diff = benchPremium − candPremium。gap 始终以 H 为被减数：
      //   bench=H → gap = diff；bench=L → gap = -diff。未分类 → gap=NaN。
      let gap = NaN;
      if (benchClass === 'H') gap = diff;
      else if (benchClass === 'L') gap = -diff;
      const rule = classifyRule({ benchClass, candClass, gap, sellLower, buyOther });
      // 方向始终是「卖/观察基准 bench, 买候选 cand」。
      const fromCode = rule === 'none' ? '' : benchmark;
      const toCode = rule === 'none' ? '' : cand.code;
      const fromName = benchName;
      const toName = cand.name || '';
      const threshold = rule === 'A' ? sellLower : (rule === 'B' ? buyOther : NaN);
      const prev = prevTriggerStates?.[pairKey] || { rule: 'none' };
      const dailyTriggerCount = readDailyTriggerCount(prev, rule, signalDate);
      const didTrigger = rule !== 'none' && dailyTriggerCount < MAX_SWITCH_PUSHES_PER_TRADING_DAY;
      if (didTrigger) {
        triggers.push({
          pairKey,
          rule,
          fromCode,
          toCode,
          fromName,
          toName,
          // 保存触发瞬间两侧各自的溢价，通知发送时直接使用该快照，避免重新取行情后发生偏移。
          fromPremiumPct: Number.isFinite(group?.benchmarkPremiumPct) ? group.benchmarkPremiumPct : null,
          toPremiumPct: Number.isFinite(cand?.premiumPct) ? cand.premiumPct : null,
          // diffPct 字段保留为「H−L gap」（UI 渲染以该值为准）。
          diffPct: gap,
          gapPct: gap,
          threshold,
          benchClass,
          candClass
        });
      }
      nextTriggerStates[pairKey] = {
        rule,
        fromCode,
        ...buildTriggerCounterState(prev, rule, signalDate, didTrigger),
        lastDiffPct: diff,
        lastGapPct: Number.isFinite(gap) ? gap : null,
        updatedAt: snapshot.computedAt
      };
    }
  }

  const otc = snapshot?.otcSignal;
  if (otc?.ready && otc.benchCode && otc.lowestCode) {
    const pairKey = `otc:${otc.benchCode}:${otc.lowestCode}`;
    const rule = otc.triggered
      ? (otc.intraLowHard ? 'OTC_STRONG' : 'OTC_WEAK')
      : 'none';
    const prev = prevTriggerStates?.[pairKey] || { rule: 'none' };
    const dailyTriggerCount = readDailyTriggerCount(prev, rule, signalDate);
    const didTrigger = rule !== 'none' && dailyTriggerCount < MAX_SWITCH_PUSHES_PER_TRADING_DAY;
    if (didTrigger) {
      triggers.push({
        kind: 'otc',
        pairKey,
        rule,
        fromCode: otc.benchCode,
        fromName: otc.benchName || '',
        toCode: otc.lowestCode,
        toName: otc.lowestName || '',
        level: otc.level || (rule === 'OTC_STRONG' ? '强信号' : '弱信号'),
        benchPremiumPct: otc.benchPremiumPct,
        lowestPremiumPct: otc.lowestPremiumPct,
        threshold: otc.otcPremiumThresholdPct,
        lowThreshold: otc.otcMinIntraPremiumLow,
        highThreshold: otc.otcMinIntraPremiumHigh
      });
    }
    nextTriggerStates[pairKey] = {
      rule,
      fromCode: otc.benchCode,
      toCode: otc.lowestCode,
      ...buildTriggerCounterState(prev, rule, signalDate, didTrigger),
      level: otc.level || '',
      lastBenchPremiumPct: Number.isFinite(otc.benchPremiumPct) ? otc.benchPremiumPct : null,
      lastLowestPremiumPct: Number.isFinite(otc.lowestPremiumPct) ? otc.lowestPremiumPct : null,
      updatedAt: snapshot.computedAt
    };
  } else {
    preservePreviousOtcStates();
  }

  return { triggers, nextTriggerStates };
}


function stripTaggedPairKey(ruleId = '', pairKey = '') {
  const normalizedRuleId = String(ruleId || '').trim();
  const normalizedPairKey = String(pairKey || '').trim();
  const prefix = `${normalizedRuleId}:`;
  return normalizedRuleId && normalizedPairKey.startsWith(prefix)
    ? normalizedPairKey.slice(prefix.length)
    : normalizedPairKey;
}

export function restoreUndeliveredSwitchTriggerStates(prevStatesByRule = {}, nextStatesByRule = {}, pushedTriggerRecords = []) {
  const deliveredPairs = new Set(
    (Array.isArray(pushedTriggerRecords) ? pushedTriggerRecords : [])
      .map((record) => {
        const ruleId = String(record?.ruleId || record?.trigger?.ruleId || '').trim();
        const pairKey = stripTaggedPairKey(ruleId, record?.pairKey || record?.trigger?.pairKey || '');
        return ruleId && pairKey ? `${ruleId}:${pairKey}` : '';
      })
      .filter(Boolean)
  );

  return Object.entries(nextStatesByRule || {}).reduce((map, [ruleId, nextStates]) => {
    const previousStates = prevStatesByRule?.[ruleId] || {};
    map[ruleId] = Object.entries(nextStates || {}).reduce((stateMap, [pairKey, state]) => {
      const nextState = { ...(state || {}) };
      const rule = String(nextState.rule || 'none');
      const deliveryKey = `${ruleId}:${pairKey}`;
      if (rule !== 'none' && !deliveredPairs.has(deliveryKey)) {
        const prevState = previousStates?.[pairKey] || {};
        nextState.lastTriggeredDate = String(prevState.lastTriggeredDate || '').trim();
        nextState.lastTriggeredRule = String(prevState.lastTriggeredRule || '').trim();
        nextState.dailyTriggerCount = Math.max(0, Number.parseInt(String(prevState.dailyTriggerCount || '0'), 10) || 0);
      }
      stateMap[pairKey] = nextState;
      return stateMap;
    }, {});
    return map;
  }, {});
}


function normalizeDailyTriggerCount(value) {
  return Math.max(0, Number.parseInt(String(value || '0'), 10) || 0);
}

function countDeliveredSwitchTriggersForDate(ruleStates = {}, dateKey = '') {
  const normalizedDate = String(dateKey || '').trim();
  if (!normalizedDate) return 0;
  return Object.values(ruleStates && typeof ruleStates === 'object' ? ruleStates : {}).reduce((total, state) => {
    if (String(state?.lastTriggeredDate || '').trim() !== normalizedDate) return total;
    return total + normalizeDailyTriggerCount(state?.dailyTriggerCount);
  }, 0);
}

export function attachSwitchDailyTriggerCounts(snapshot = null, triggerStatesByRule = {}, dateKey = '') {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const statesByRule = triggerStatesByRule && typeof triggerStatesByRule === 'object' ? triggerStatesByRule : {};
  const decorate = (value, ruleId) => {
    if (!value || typeof value !== 'object') return value;
    const todayTriggerCount = countDeliveredSwitchTriggersForDate(statesByRule?.[ruleId], dateKey);
    return { ...value, hitCount: todayTriggerCount, todayTriggerCount };
  };
  const rules = Array.isArray(snapshot.rules)
    ? snapshot.rules.map((entry) => {
        const ruleId = String(entry?.ruleId || entry?.id || entry?.snapshot?.ruleId || '').trim();
        const decoratedSnapshot = decorate(entry?.snapshot || entry, ruleId);
        return entry?.snapshot
          ? { ...entry, hitCount: decoratedSnapshot.hitCount, todayTriggerCount: decoratedSnapshot.todayTriggerCount, snapshot: decoratedSnapshot }
          : decoratedSnapshot;
      })
    : null;
  const rootRuleId = String(snapshot.ruleId || snapshot.id || '').trim();
  const decoratedRoot = rootRuleId ? decorate(snapshot, rootRuleId) : { ...snapshot };
  return rules ? { ...decoratedRoot, rules } : decoratedRoot;
}
