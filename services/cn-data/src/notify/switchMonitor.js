import { normalizeSwitchConfig, getRunnableSwitchRules, collectSwitchConfigCodes, evaluateSwitchTriggers, restoreUndeliveredSwitchTriggerStates, attachSwitchDailyTriggerCounts, getShanghaiDateKey, isInTradingSession, DEFAULT_OTC_PREMIUM_THRESHOLD_PCT, DEFAULT_OTC_MIN_INTRA_PREMIUM_LOW, DEFAULT_OTC_MIN_INTRA_PREMIUM_HIGH } from './switchStrategyPort.js';
import { fetchSwitchCollectorSnapshot } from './switchDryRun.js';
import { deliverNotification } from './testDelivery.js';

function buildSwitchAction(trigger, params) {
  const detailUrl = `https://fast.freebacktrack.tech/markets?code=${trigger.fromCode}&source=switch-strategy`;
  return { detailUrl, url: detailUrl, links: { web: detailUrl, app: '', miniProgram: '' }, target: 'fundSwitch', params };
}

function formatSignedPercentText(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function buildOtcSwitchTriggerNotification(snapshot, trigger) {
  const fromLabel = trigger.fromName ? `${trigger.fromCode} ${trigger.fromName}` : trigger.fromCode;
  const refLabel = trigger.toName ? `${trigger.toCode} ${trigger.toName}` : trigger.toCode;
  const benchPremium = formatSignedPercentText(trigger.benchPremiumPct);
  const lowestPremium = formatSignedPercentText(trigger.lowestPremiumPct);
  const threshold = Number(trigger.threshold);
  const lowThreshold = Number(trigger.lowThreshold);
  const highThreshold = Number(trigger.highThreshold);
  const signalThreshold = trigger.rule === 'OTC_STRONG' ? lowThreshold : highThreshold;
  const level = trigger.level || (trigger.rule === 'OTC_STRONG' ? '强信号' : '弱信号');
  const action = buildSwitchAction(trigger, {
    code: trigger.fromCode,
    targetCode: trigger.toCode,
    trigger: 'switch-otc',
    rule: trigger.rule || ''
  });
  const minuteKey = String(snapshot?.computedAt || '').slice(0, 16);
  const eventId = `switch:${trigger.pairKey}:R${trigger.rule}:${minuteKey}`;
  const title = `场外切换 ${level} | ${trigger.fromCode}→场外QDII`;
  const ruleLabel = trigger.rule === 'OTC_STRONG'
    ? `场外强信号：基准溢价 > ${threshold}% 且场内最低溢价 < ${lowThreshold}%`
    : `场外弱信号：基准溢价 > ${threshold}% 且场内最低溢价 < ${highThreshold}%`;
  const body = `基准溢价 ${benchPremium} > ${threshold}% · 场内最低 ${lowestPremium} < ${signalThreshold}%\n卖 ${fromLabel} → 申购场外 QDII 联接基金\n参考低溢价 ${refLabel}\n点此查看策略详情，下单前请以基金软件实时溢价和申购限额为准。`;
  const summary = `场外切换 ${level} ${trigger.fromCode}→场外QDII ${benchPremium}/${lowestPremium}`;
  const body_md = [
    `**基准溢价 ${benchPremium}** > ${threshold}%`,
    `**场内最低 ${lowestPremium}** < ${signalThreshold}%（参考 ${refLabel}）`,
    `卖 **${fromLabel}** → 申购 **场外 QDII 联接基金**`,
    `*下单前请以基金软件实时溢价和申购限额为准。*`
  ].join('\n');
  return {
    eventId,
    eventType: 'switch-strategy-trigger',
    ruleId: trigger.ruleId ? `switch-otc:${trigger.ruleId}:${trigger.fromCode}` : `switch-otc:${trigger.fromCode}`,
    symbol: trigger.fromCode,
    strategyName: trigger.ruleName ? `场外切换 · ${trigger.ruleName}` : '场外切换',
    triggerCondition: ruleLabel,
    purchaseAmount: '',
    detailUrl: action.detailUrl,
    url: action.url,
    links: action.links,
    target: action.target,
    params: action.params,
    title,
    body,
    summary,
    body_md
  };
}

export function buildSwitchTriggerNotification(snapshot, trigger) {
  if (trigger?.kind === 'otc' || String(trigger?.rule || '').startsWith('OTC_')) {
    return buildOtcSwitchTriggerNotification(snapshot, trigger);
  }
  // v4 通知格式（规则基准 bench + H/L 双维度）：
  //   title:   切换 A 低→高 | 159632→513100
  //   body:    H−L +0.85% < 1%  · NAV 2026-04-28
  //            卖 159632 纳指ETF → 买 513100 纳指ETF
  //            下单前请以基金软件实时溢价为准。
  const fromLabel = trigger.fromName ? `${trigger.fromCode} ${trigger.fromName}` : trigger.fromCode;
  const toLabel = trigger.toName ? `${trigger.toCode} ${trigger.toName}` : trigger.toCode;
  const gap = Number(trigger.gapPct ?? trigger.diffPct);
  const gapStr = (gap >= 0 ? '+' : '') + gap.toFixed(2);
  const threshold = Number(trigger.threshold);
  const cmp = trigger.rule === 'A' ? '<' : '>';
  // v4：fromCode 始终 = benchmark（规则基准）。H 组只：
  //   bench.class === 'H' → H = fromCode；bench.class === 'L' → H = toCode。
  const benchHCode = trigger.benchClass === 'H' ? trigger.fromCode : trigger.toCode;
  const benchmarkEntry = (Array.isArray(snapshot?.byBenchmark) ? snapshot.byBenchmark : [])
    .find((b) => b?.benchmarkCode === benchHCode) || null;
  const navDate = String(benchmarkEntry?.benchmarkNavDate || '').trim();
  const navHint = navDate ? ` · NAV ${navDate}` : '';
  const arrow = trigger.rule === 'A' ? '低→高' : '高→低';
  const title = `切换 ${trigger.rule} ${arrow} | ${trigger.fromCode}→${trigger.toCode}`;
  const body = `H−L ${gapStr}% ${cmp} ${threshold}%${navHint}\n卖 ${fromLabel} → 买 ${toLabel}\n下单前请以基金软件实时溢价为准。`;
  const summary = `切换 ${trigger.rule} ${trigger.fromCode}→${trigger.toCode} ${gapStr}%`;
  const ruleLabel = trigger.rule === 'A'
    ? `规则 A 低→高：H溢价 − L溢价 < ${threshold}%（溢价差收窄，从持仓 L 换到 H）`
    : `规则 B 高→低：H溢价 − L溢价 > ${threshold}%（溢价差扩大，从持仓 H 换到 L）`;
  const action = buildSwitchAction(trigger, {
    code: trigger.fromCode,
    targetCode: trigger.toCode,
    trigger: 'switch-threshold',
    rule: trigger.rule || ''
  });
  // 同一对 + 同一规则 + 同一分钟，只发一次。
  const minuteKey = String(snapshot?.computedAt || '').slice(0, 16);
  // pairKey 已含 benchmark:cand，多基准下仍唯一。
  const eventId = `switch:${trigger.pairKey}:R${trigger.rule}:${minuteKey}`;
  const body_md = [
    `**H−L ${gapStr}%** ${cmp} ${threshold}%${navHint}`,
    `卖 **${fromLabel}** → 买 **${toLabel}**`,
    `*点此查看策略详情，下单前请以基金软件实时溢价为准。*`
  ].join('\n');
  return {
    eventId,
    eventType: 'switch-strategy-trigger',
    ruleId: trigger.ruleId ? `switch:${trigger.ruleId}:${trigger.fromCode}` : `switch:${trigger.fromCode}`,
    symbol: trigger.fromCode,
    strategyName: trigger.ruleName ? `场内切换 · ${trigger.ruleName}` : '场内切换',
    triggerCondition: ruleLabel,
    purchaseAmount: '',
    detailUrl: action.detailUrl,
    url: action.url,
    links: action.links,
    target: action.target,
    params: action.params,
    title,
    body: `${body}\n点此查看策略详情。`,
    summary,
    body_md,
    fromPremiumPct: typeof trigger.fromPremiumPct === 'number' && Number.isFinite(trigger.fromPremiumPct) ? trigger.fromPremiumPct : null,
    toPremiumPct: typeof trigger.toPremiumPct === 'number' && Number.isFinite(trigger.toPremiumPct) ? trigger.toPremiumPct : null
  };
}


export function hasConfirmedPushDelivery(runResult = {}) {
  const channels = Array.isArray(runResult?.summary?.events?.[0]?.channels)
    ? runResult.summary.events[0].channels
    : [];
  return channels.some((channel) => {
    const channelName = String(channel?.channel || '').trim();
    const status = String(channel?.status || '').trim();
    return (status === 'delivered' && ['bark', 'serverchan3', 'ws', 'email'].includes(channelName))
      || (channelName === 'pc' && status === 'queued');
  });
}

// 与 services/cn-data/src/routes/data.js 的 switchKeyOwner 保持一致。
export function switchKeyOwner(clientId) {
  return clientId.startsWith('account:') ? clientId.slice(8) : `legacy:${clientId}`;
}

export function listMonitorClients(db) {
  const clients = [];
  for (const row of db.prepare(`SELECT owner_user_id, record_id, payload FROM notify_user_records
    WHERE record_type='user-kv' AND record_id LIKE 'switch:config:%'`).all()) {
    try {
      const config = normalizeSwitchConfig(JSON.parse(row.payload));
      if (config.enabled && getRunnableSwitchRules(config).length) {
        clients.push({ ownerUserId: row.owner_user_id, clientId: row.record_id.slice('switch:config:'.length), config });
      }
    } catch { /* 跳过损坏配置。 */ }
  }
  return clients;
}

export async function fetchMarketFunds(codes) {
  const requested = [...new Set(codes.map(String).filter((code) => /^\d{6}$/.test(code)))];
  const funds = {};
  let generatedAt = '';
  for (let offset = 0; offset < requested.length; offset += 30) {
    const batch = await fetchSwitchCollectorSnapshot(requested.slice(offset, offset + 30));
    Object.assign(funds, batch.funds);
    generatedAt = batch.generatedAt;
  }
  return { funds, generatedAt };
}

export function buildRuleSnapshot(rule, funds, computedAt = new Date().toISOString()) {
  const premiumClass = rule.premiumClass || {};
  const premium = (code) => Number.isFinite(funds[code]?.premiumPct) ? funds[code].premiumPct : null;
  const name = (code) => funds[code]?.name || code;
  const pool = [...new Set([...rule.benchmarkCodes, ...rule.enabledCodes])]
    .filter((code) => premiumClass[code] === 'H' || premiumClass[code] === 'L');
  const byBenchmark = rule.benchmarkCodes.map((benchmarkCode) => {
    const benchmarkPremiumPct = premium(benchmarkCode);
    const benchmarkClass = premiumClass[benchmarkCode] || null;
    const candidates = (benchmarkClass ? pool : rule.enabledCodes).filter((code) => code !== benchmarkCode).map((code) => {
      const premiumPct = premium(code);
      return { code, name: name(code), premiumPct, candClass: premiumClass[code] || null,
        valid: Boolean(funds[code]?.valid), spreadVsBenchmarkPct: Number.isFinite(benchmarkPremiumPct) && Number.isFinite(premiumPct) ? benchmarkPremiumPct - premiumPct : null };
    });
    return { benchmarkCode, benchmarkName: name(benchmarkCode), benchmarkClass, benchmarkPremiumPct, candidates };
  });
  const threshold = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const otcPremiumThresholdPct = threshold(rule.otcPremiumThresholdPct, DEFAULT_OTC_PREMIUM_THRESHOLD_PCT);
  const otcMinIntraPremiumLow = threshold(rule.otcMinIntraPremiumLow, DEFAULT_OTC_MIN_INTRA_PREMIUM_LOW);
  const otcMinIntraPremiumHigh = threshold(rule.otcMinIntraPremiumHigh, DEFAULT_OTC_MIN_INTRA_PREMIUM_HIGH);
  const benches = rule.benchmarkCodes.filter((code) => Number.isFinite(premium(code))).sort((a, b) => premium(b) - premium(a));
  const candidates = rule.enabledCodes.filter((code) => Number.isFinite(premium(code))).sort((a, b) => premium(a) - premium(b));
  let otcSignal = { ready: false };
  if (benches.length && candidates.length) {
    const benchCode = benches[0], lowestCode = candidates[0];
    const benchPremiumPct = premium(benchCode), lowestPremiumPct = premium(lowestCode);
    const benchHigh = benchPremiumPct > otcPremiumThresholdPct;
    const intraLowSoft = lowestPremiumPct < otcMinIntraPremiumHigh;
    const intraLowHard = lowestPremiumPct < otcMinIntraPremiumLow;
    const triggered = benchHigh && (intraLowSoft || intraLowHard);
    otcSignal = { ready: true, benchCode, benchName: name(benchCode), benchPremiumPct, lowestCode, lowestName: name(lowestCode), lowestPremiumPct,
      benchHigh, intraLowSoft, intraLowHard, triggered, rule: triggered ? (intraLowHard ? 'OTC_STRONG' : 'OTC_WEAK') : 'none',
      level: triggered ? (intraLowHard ? '强信号' : '弱信号') : '未触发', otcPremiumThresholdPct, otcMinIntraPremiumLow, otcMinIntraPremiumHigh };
  }
  return { computedAt, ruleId: rule.id, ruleName: rule.name, ruleEnabled: true,
    intraSellLowerPct: Number(rule.intraSellLowerPct), intraBuyOtherPct: Number(rule.intraBuyOtherPct), premiumClass, byBenchmark, otcSignal,
    ready: byBenchmark.some((group) => Number.isFinite(group.benchmarkPremiumPct) && group.candidates.some((candidate) => Number.isFinite(candidate.spreadVsBenchmarkPct))) || otcSignal.ready, triggers: [] };
}

export function readMonitorState(db, ownerUserId, clientId) {
  const row = db.prepare(`SELECT payload FROM notify_user_records WHERE owner_user_id=? AND record_type='switch-monitor-state' AND record_id=?`).get(ownerUserId, `switch:state:${clientId}`);
  try {
    const state = JSON.parse(row?.payload || '{}');
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch { return {}; }
}

function writeRecord(db, ownerUserId, recordType, recordId, payload) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO notify_user_records (owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(owner_user_id, record_type, record_id) DO UPDATE SET payload=excluded.payload, revision=notify_user_records.revision+1, updated_at=excluded.updated_at`)
    .run(ownerUserId, recordType, recordId, JSON.stringify(payload), now, now);
}
export function writeMonitorState(db, ownerUserId, clientId, state) {
  writeRecord(db, ownerUserId, 'switch-monitor-state', `switch:state:${clientId}`, state);
}
export function writeMonitorSnapshot(db, ownerUserId, clientId, snapshot) {
  writeRecord(db, ownerUserId, 'user-kv', `switch:snapshot:${clientId}`, snapshot);
}

export async function deliverSwitchNotification(db, account, notification) {
  const result = await deliverNotification(db, account, notification, { targetChannels: null, reason: 'switch-strategy-trigger' });
  // 通用投递返回 summary 内容本身；补齐 worker 确认函数需要的包装。
  return { delivered: hasConfirmedPushDelivery({ summary: result }), result };
}

export async function processClient(db, ownerUserId, clientId, config, funds, { computedAt = new Date().toISOString(), deliver = deliverSwitchNotification } = {}) {
  const normalizedConfig = normalizeSwitchConfig(config);
  const runnableRules = getRunnableSwitchRules(normalizedConfig);
  const prevStatesByRule = readMonitorState(db, ownerUserId, clientId).triggerStatesByRule || {};
  const nextStatesByRule = {}, snapshots = [], jobs = [], pushedTriggerRecords = [];
  for (const rule of runnableRules) {
    const snapshot = buildRuleSnapshot({ ...rule, ruleId: rule.id, ruleName: rule.name }, funds, computedAt);
    const { triggers, nextTriggerStates } = evaluateSwitchTriggers(snapshot, prevStatesByRule[rule.id] || {});
    snapshot.triggers = triggers.map((trigger) => ({ ...trigger, ruleId: rule.id, ruleName: rule.name, pairKey: `${rule.id}:${trigger.pairKey}` }));
    snapshots.push(snapshot);
    nextStatesByRule[rule.id] = nextTriggerStates;
    for (const trigger of snapshot.triggers) jobs.push({ snapshot, trigger });
  }
  let pushedCount = 0, deliveryAttemptCount = 0;
  for (const { snapshot, trigger } of jobs) {
    const payload = buildSwitchTriggerNotification(snapshot, trigger);
    deliveryAttemptCount++;
    try {
      const { delivered } = await deliver(db, { userId: ownerUserId, clientId }, payload);
      if (delivered) {
        pushedCount++;
        pushedTriggerRecords.push({ ruleId: trigger.ruleId, pairKey: trigger.pairKey, trigger });
      }
    } catch (error) { console.error('[switch-monitor] delivery failed', clientId, trigger.pairKey, error.message); }
  }
  const committed = restoreUndeliveredSwitchTriggerStates(prevStatesByRule, nextStatesByRule, pushedTriggerRecords);
  writeMonitorState(db, ownerUserId, clientId, { triggerStatesByRule: committed, updatedAt: computedAt });
  const activeSnapshot = snapshots.find((snapshot) => snapshot.ruleId === normalizedConfig.activeRuleId) || snapshots[0] || { computedAt, ready: false, triggers: [] };
  const allTriggers = jobs.map((job) => job.trigger);
  const ready = snapshots.some((snapshot) => snapshot.ready);
  const snapshotToStore = normalizedConfig.rules.length > 1 ? {
    ...activeSnapshot, computedAt, activeRuleId: normalizedConfig.activeRuleId,
    rules: snapshots.map((snapshot) => ({ ruleId: snapshot.ruleId, ruleName: snapshot.ruleName, ready: Boolean(snapshot.ready), signalCount: 0, triggerCount: snapshot.triggers.length, snapshot })),
    signals: [], triggers: allTriggers, ready
  } : activeSnapshot;
  writeMonitorSnapshot(db, ownerUserId, clientId, attachSwitchDailyTriggerCounts(snapshotToStore, committed, getShanghaiDateKey(computedAt)));
  return { clientId, ruleCount: runnableRules.length, triggered: allTriggers.length, pushed: pushedCount, deliveryAttempts: deliveryAttemptCount, ready };
}

export async function runMonitorTick(db, { now = new Date(), fetchMarket = fetchMarketFunds, deliver = deliverSwitchNotification } = {}) {
  if (!isInTradingSession(now)) return { skipped: 'outside-trading-session', at: now.toISOString() };
  const clients = listMonitorClients(db);
  if (!clients.length) return { skipped: 'no-switch-clients' };
  const codes = [...new Set(clients.flatMap(({ config }) => collectSwitchConfigCodes(config)).filter((code) => /^\d{6}$/.test(code)))];
  if (!codes.length) return { skipped: 'no-codes' };
  let funds;
  try { ({ funds } = await fetchMarket(codes)); }
  catch (error) { return { skipped: 'market-fetch-failed', message: error.message }; }
  const computedAt = now.toISOString(), results = [];
  for (const { ownerUserId, clientId, config } of clients) {
    try { results.push(await processClient(db, ownerUserId, clientId, config, funds, { computedAt, deliver })); }
    catch (error) {
      console.error('[switch-monitor] client failed', clientId, error.message);
      results.push({ clientId, error: error.message });
    }
  }
  return { at: computedAt, clientCount: clients.length, results,
    triggered: results.reduce((sum, result) => sum + (result.triggered || 0), 0), pushed: results.reduce((sum, result) => sum + (result.pushed || 0), 0) };
}
