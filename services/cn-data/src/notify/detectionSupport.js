import { mapReferencePrice } from '../../../../src/app/strategyEngine.js';
import { isKnownQdiiFundCode } from '../../../../src/app/qdiiFundCodes.js';
import { webcrypto as crypto } from 'node:crypto';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const HOLDINGS_RULE_KEY_PREFIX = 'holdings-rule:';
const HOLDINGS_DEDUP_KEY_PREFIX = 'holdings-dedup:';
export const HOLDINGS_DEDUP_TTL_SECONDS = 36 * 3600;
export const FUND_CODE_PATTERN = /^\d{6}$/;
const UNAMBIGUOUS_EXCHANGE_PREFIXES = new Set(['15', '50', '51', '52', '54', '56', '58']);

export function holdingsRuleKey(clientId) {
  return `${HOLDINGS_RULE_KEY_PREFIX}${clientId}`;
}

export function holdingsDedupKey(clientId, kind, dateKey) {
  return `${HOLDINGS_DEDUP_KEY_PREFIX}${clientId}:${kind}:${dateKey}`;
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

export async function resolveHoldingKindAsync(code, bucketKind, env) {
  const kind = String(bucketKind || '').trim().toLowerCase();
  const normalizedCode = String(code || '').trim();
  const prefix = normalizedCode.slice(0, 2);
  const isAmbiguousLof = prefix === '16';
  if (
    kind === 'exchange'
    && isKnownQdiiFundCode(normalizedCode)
    && !UNAMBIGUOUS_EXCHANGE_PREFIXES.has(prefix)
    && !isAmbiguousLof
  ) {
    return 'qdii';
  }
  if (kind === 'exchange' || kind === 'qdii' || kind === 'otc') return kind;
  return 'otc';
}

export function isChinaMarketHoliday(dateStr) {
  // A 股休市（除周末外）——与前端 holidaysCN.js 保持一致。
  const d = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const y = d.slice(0, 4);
  const rangesByYear = {
    '2025': [
      ['2025-01-01', '2025-01-01'],
      ['2025-01-28', '2025-02-04'],
      ['2025-04-04', '2025-04-06'],
      ['2025-05-01', '2025-05-05'],
      ['2025-05-31', '2025-06-02'],
      ['2025-10-01', '2025-10-08']
    ],
    '2026': [
      ['2026-01-01', '2026-01-03'],
      ['2026-02-15', '2026-02-23'],
      ['2026-04-04', '2026-04-06'],
      ['2026-05-01', '2026-05-05'],
      ['2026-06-19', '2026-06-21'],
      ['2026-09-25', '2026-09-27'],
      ['2026-10-01', '2026-10-07']
    ]
  };
  const ranges = rangesByYear[y] || [];

  for (const [start, end] of ranges) {
    if (d >= start && d <= end) return true;
  }
  return false;
}

function isWeekendShanghai(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map((s) => Number(s));
  if (!y || !m || !d) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  return dow === 0 || dow === 6;
}

function shiftShanghaiDate(dateStr, daysBack = 1) {
  const [y, m, d] = String(dateStr).split('-').map((s) => Number(s));
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - daysBack);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function getPreviousTradingDayShanghai(dateStr) {
  let cur = shiftShanghaiDate(dateStr, 1);
  // 最多回退 30 天，避免死循环。
  for (let i = 0; i < 30; i++) {
    if (!isWeekendShanghai(cur) && !isChinaMarketHoliday(cur)) return cur;
    cur = shiftShanghaiDate(cur, 1);
  }
  return cur;
}

export function isTradingDayShanghai(dateStr) {
  return !isWeekendShanghai(dateStr) && !isChinaMarketHoliday(dateStr);
}

export function getExpectedLatestNavDate(kind, todayShanghai) {
  const today = String(todayShanghai || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return todayShanghai;

  // 这里的 T 定义为“最近一个交易日”（如果今天不是交易日，就回退到最近交易日）。
  // 规则：
  //   - exchange / otc：预期 = T
  //   - qdii：预期 = T-1（即上一个交易日；若 T 为周一，则会自然回退到上周五，即 T-3）
  const T = isTradingDayShanghai(today) ? today : getPreviousTradingDayShanghai(today);

  // 场内 ETF + 境内场外：预期都是“今日（非交易日回退到上一个交易日）”。
  if (kind === 'exchange' || kind === 'otc') {
    return T;
  }

  // qdii：T+1 发布，预期 = T-1
  return getPreviousTradingDayShanghai(T);
}

export function getShanghaiDateParts(date = new Date()) {
  // 使用 Intl 拿到 Asia/Shanghai 的年月日/小时/分钟（包依轻量，Worker 运行时可用）。
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${hour}:${parts.minute}`
  };
}

export function getTodayShanghaiDate() {
  try {
    return getShanghaiDateParts(new Date()).date;
  } catch (_error) {
    const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
  }
}

export function normalizeHoldingsDigest(digest) {
  const result = {
    version: 1,
    generatedAt: '',
    exchange: [],
    otc: []
  };
  if (!digest || typeof digest !== 'object') return result;
  if (digest.generatedAt) result.generatedAt = String(digest.generatedAt);

  let totalWeight = 0;
  for (const bucket of ['exchange', 'otc']) {
    const list = Array.isArray(digest[bucket]) ? digest[bucket] : [];
    for (const entry of list) {
      const code = String(entry?.code || '').trim();
      const weight = Number(entry?.weight);
      const rawKind = String(entry?.kind || bucket).trim().toLowerCase();
      const kind = rawKind === 'exchange' || rawKind === 'otc' || rawKind === 'qdii' ? rawKind : bucket;
      if (!FUND_CODE_PATTERN.test(code)) continue;
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1) continue;
      result[bucket].push({ code, weight, kind });
      totalWeight += weight;
    }
  }

  // 软限制：总权重 ≤ 1.5（两个 bucket 各自合计 ≤ 1，上限考虑取整冗余）
  if (totalWeight > 1.5) {
    return result;
  }

  // 旧版 digest 可能携带 totals（marketValue / todayProfit / totalProfit / …）。
  // 出于隐私考虑现在统一丢弃：不透传到 KV，也不在推送里展示金额；worker 仅根据 code/weight 计算加权收益率百分比。

  return result;
}
export function roundPrice(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(3)) : 0;
}

export function formatPrice(value, currency = '¥') {
  const numericValue = Number(value);
  if (!(numericValue > 0)) {
    return '--';
  }

  const prefix = currency === '$' ? '$' : '¥';
  return `${prefix}${numericValue.toFixed(3)}`;
}

export function formatAmount(value, currency = '¥') {
  const numericValue = Number(value);
  if (!(numericValue > 0)) {
    return '';
  }

  const prefix = currency === '$' ? '$' : '¥';
  return `${prefix}${numericValue.toFixed(2)}`;
}

export function formatPercent(value, digits = 1) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return '--';
  }

  return `${numericValue.toFixed(digits)}%`;
}

export function buildNotificationEventId(ruleId = '', context = '', now = new Date()) {
  const normalizedRuleId = String(ruleId || 'notify').trim() || 'notify';
  const normalizedContext = String(context || 'event').trim().replace(/[^a-zA-Z0-9:_-]+/g, '-');
  return `${normalizedRuleId}:${normalizedContext}:${now.getTime()}`;
}

export function buildStageHighPrice(bars = []) {
  const values = bars
    .flatMap((bar) => [Number(bar?.high) || 0, Number(bar?.close) || 0])
    .filter((value) => Number.isFinite(value) && value > 0);

  return values.length ? Math.max(...values) : 0;
}

export function getLatestBarClose(bars = []) {
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const close = Number(bars[index]?.close);
    if (Number.isFinite(close) && close > 0) {
      return close;
    }
  }
  return 0;
}

export function getCurrency(entry = null) {
  return String(entry?.currency || '').trim() || '¥';
}

export function toDisplayLayers(strategyPlan, ratio = 1) {
  return strategyPlan.layers.map((layer) => {
    const mappedPrice = mapReferencePrice(layer.price, ratio);
    return {
      ...layer,
      price: mappedPrice,
      shares: mappedPrice > 0 ? layer.amount / mappedPrice : 0
    };
  });
}

export function resolveDeepestTriggeredLayer(layers = [], currentPrice = 0) {
  const completed = layers.filter((layer) => currentPrice > 0 && currentPrice <= layer.price);
  return completed.length ? completed[completed.length - 1] : null;
}

export function buildPlanNotification(rule, evaluation, options = {}) {
  const layer = evaluation.deepestTriggeredLayer;
  const displayName = rule.planName || `${rule.symbol} 建仓计划`;
  const currency = String(evaluation.currency || '¥').trim() || '¥';
  const stageHighPrice = Number(evaluation.stageHighPrice) || 0;
  const currentPrice = Number(evaluation.currentPrice) || 0;
  const fallbackDrawdown = Math.max(Number(layer?.drawdown) || 0, 0);
  const actualDrawdown = stageHighPrice > 0 && currentPrice > 0 && currentPrice < stageHighPrice
    ? (1 - currentPrice / stageHighPrice) * 100
    : fallbackDrawdown;
  const drawdownLabel = formatPercent(actualDrawdown || fallbackDrawdown, 1);
  const stageOrder = Math.max(Number(layer?.order) || 0, 1);
  const purchaseAmount = formatAmount(layer?.amount, currency);
  const currentPriceLabel = formatPrice(currentPrice, currency);
  const triggerPriceLabel = formatPrice(layer?.price, currency);
  const triggerCondition = `${rule.symbol} 已下跌 ${drawdownLabel}，当前价 ${currentPriceLabel}，触发第 ${stageOrder} 档买入（触发价 ${triggerPriceLabel}）`;
  const action = buildNotificationDetailAction('tradePlans', rule.ruleId, {
    code: rule.symbol,
    trigger: 'plan-threshold'
  });

  return {
    eventId: String(options.eventId || '').trim() || buildNotificationEventId(rule.ruleId, `stage-${stageOrder}`),
    eventType: 'plan-trigger',
    ruleId: rule.ruleId,
    symbol: rule.symbol,
    strategyName: displayName,
    triggerCondition,
    purchaseAmount,
    detailUrl: action.detailUrl,
    url: action.url,
    links: action.links,
    target: action.target,
    params: action.params,
    title: `${rule.symbol} 触及买入阈值`,
    body: `已触发「${displayName}」第 ${stageOrder} 档${purchaseAmount ? `，建议买入 ${purchaseAmount}` : ''} → 点此查看策略详情。`,
    summary: `${displayName} 触发第 ${stageOrder} 档买入`
  };
}

export function buildDcaNotification(rule, localDateLabel, options = {}) {
  const isFirstExecution = Boolean(options.isFirstExecution);
  const strategyName = rule.linkedPlanName || `${rule.symbol} 定投计划`;
  const purchaseAmount = formatAmount(
    isFirstExecution ? rule.firstExecutionAmount : rule.recurringInvestment,
    '¥'
  );
  const triggerCondition = isFirstExecution
    ? `已到达您设定的${rule.frequency}定投日（${localDateLabel}），首次执行将按「${strategyName}」的首档金额提醒`
    : `已到达您设定的${rule.frequency}定投日（${localDateLabel}）`;
  const action = buildNotificationDetailAction('dca', rule.ruleId, {
    code: rule.symbol,
    trigger: 'dca-window'
  });

  return {
    eventId: String(options.eventId || '').trim() || buildNotificationEventId(rule.ruleId, localDateLabel),
    eventType: 'dca-schedule',
    ruleId: rule.ruleId,
    symbol: rule.symbol,
    strategyName,
    triggerCondition,
    purchaseAmount,
    detailUrl: action.detailUrl,
    url: action.url,
    links: action.links,
    target: action.target,
    params: action.params,
    title: '定投计划提醒',
    body: `${strategyName} 已进入本期执行窗口${purchaseAmount ? `，建议投入 ${purchaseAmount}` : ''} → 点此查看定投详情。`,
    summary: `${strategyName} 定投执行日`
  };
}

export function getLocalDateParts(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  });
  const parts = formatter.formatToParts(date).reduce((map, part) => {
    map[part.type] = part.value;
    return map;
  }, {});

  return {
    year: Number(parts.year) || 0,
    month: Number(parts.month) || 0,
    day: Number(parts.day) || 0,
    weekday: String(parts.weekday || '')
  };
}

function resolveWeekdayNumber(weekday = '') {
  switch (weekday) {
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    case 'Sun':
      return 7;
    default:
      return 0;
  }
}

export function resolveDcaWindow(rule, now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = getLocalDateParts(now, timeZone);
  const localDateLabel = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const executionDay = Math.max(Number(rule.executionDay) || 1, 1);

  switch (rule.frequency) {
    case '每日':
      return {
        due: true,
        windowKey: localDateLabel,
        localDateLabel
      };
    case '每周': {
      const due = resolveWeekdayNumber(parts.weekday) === Math.min(executionDay, 7);
      return {
        due,
        windowKey: localDateLabel,
        localDateLabel
      };
    }
    case '每季': {
      const quarter = Math.floor((Math.max(parts.month, 1) - 1) / 3) + 1;
      // cron 只在工作日执行；若执行日落在周末，使用 day >= executionDay 让随后的工作日补上。
      // 季度内重复触发已由调用方 lastHandledWindowKey === windowKey 阻止。
      const daysInMonth = new Date(Date.UTC(parts.year, Math.max(parts.month, 1), 0)).getUTCDate();
      const targetDay = Math.min(Math.max(executionDay, 1), daysInMonth);
      const due = [1, 4, 7, 10].includes(parts.month) && parts.day >= targetDay;
      return {
        due,
        windowKey: `${parts.year}-Q${quarter}`,
        localDateLabel
      };
    }
    case '每月':
    default: {
      // cron 只在工作日执行；若执行日落在周末，使用 day >= executionDay 让随后的工作日补上。
      // 同月重复触发已由调用方 lastHandledWindowKey === windowKey 阻止；
      // 同时 clamp 到当月最大天数，避免 2 月 30/31 日永远不到。
      const daysInMonth = new Date(Date.UTC(parts.year, Math.max(parts.month, 1), 0)).getUTCDate();
      const targetDay = Math.min(Math.max(executionDay, 1), daysInMonth);
      return {
        due: parts.day >= targetDay,
        windowKey: `${parts.year}-${String(parts.month).padStart(2, '0')}`,
        localDateLabel
      };
    }
  }
}

function isOtcSnapshotReady(latestNavDate, todayShanghai, expectedLatestNavDate) {
  // 收紧：场外/QDII 必须 latestNavDate >= 期望最新净值日期（且不超过今天）才算 ready。
  // 不再因 sourceUpdatedAt===今天 就提前判 ready，避免用 T-1 净值误报当日收益、
  // 并写入 dedup 抑制掉当晚真正的 T 日净值通知。
  if (!latestNavDate || latestNavDate > todayShanghai) return false;
  return latestNavDate >= expectedLatestNavDate;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function snapshotValueFields(snapshot = null, effectiveKind = 'otc') {
  const exchange = effectiveKind === 'exchange';
  const currentValue = exchange
    ? numberOrNull(snapshot?.price ?? snapshot?.currentPrice ?? snapshot?.close ?? snapshot?.latestNav)
    : numberOrNull(snapshot?.latestNav ?? snapshot?.currentPrice ?? snapshot?.price);
  const previousValue = exchange
    ? numberOrNull(snapshot?.previousClose ?? snapshot?.previousNav)
    : numberOrNull(snapshot?.previousNav);
  const valueDate = String(exchange
    ? (snapshot?.quoteDate || snapshot?.latestNavDate || '')
    : (snapshot?.latestNavDate || '')
  ).slice(0, 10);
  return { currentValue, previousValue, valueDate };
}

function normalizeDigestKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  return value === 'exchange' || value === 'otc' || value === 'qdii' ? value : '';
}

export async function computeWeightedReturn(bucket, snapshotsByCode, todayShanghai, kind = 'exchange', env = null) {
  // 返回 { ready, returnRate, contributors[] }。
  // ready=false 表示还有代码的 valueDate 未达预期最新日期，在调用方侧跳过。
  // 期望最新日期按「单只」实际 kind 计算：
  //   exchange = 当日行情价；otc（境内场外）= 当日净值（晚 21 点后才会刷）；
  //   qdii = 上一交易日净值（周一 T-3）。
  // bucket 仍是 exchange/otc 两档，但 otc bucket 里可能夹杂了 QDII，需要逐代码区分。
  let ready = true;
  const eligible = [];
  for (const entry of bucket) {
    const snap = snapshotsByCode[entry.code];
    const digestKind = normalizeDigestKind(entry.kind);
    const effectiveKind = digestKind || await resolveHoldingKindAsync(entry.code, kind, env);
    const expectedLatestNavDate = getExpectedLatestNavDate(effectiveKind, todayShanghai);
    const { currentValue, previousValue, valueDate } = snapshotValueFields(snap, effectiveKind);
    const dateReady = effectiveKind === 'exchange'
      ? valueDate >= expectedLatestNavDate && valueDate <= todayShanghai
      : isOtcSnapshotReady(valueDate, todayShanghai, expectedLatestNavDate);
    if (currentValue == null || previousValue == null) {
      // 缺少价格/净值或前值 → 在加权中跳过，但如果是日期不达预期造成的，则整套跳过。
      if (!dateReady) ready = false;
      continue;
    }
    if (!dateReady) {
      ready = false;
      continue;
    }
    eligible.push({
      code: entry.code,
      weight: entry.weight,
      kind: effectiveKind,
      valueType: effectiveKind === 'exchange' ? 'price' : 'nav',
      currentValue,
      previousValue,
      valueDate,
      ratio: currentValue / previousValue - 1
    });
  }

  if (!ready || !eligible.length) {
    return { ready: false, returnRate: 0, contributors: eligible };
  }

  // 在 bucket 内 re-normalize（仅限于 eligible）。
  const totalWeight = eligible.reduce((sum, item) => sum + item.weight, 0);
  if (!(totalWeight > 0)) {
    return { ready: false, returnRate: 0, contributors: eligible };
  }
  const weightedReturn = eligible.reduce((sum, item) => sum + (item.weight / totalWeight) * item.ratio, 0);

  return {
    ready: true,
    returnRate: weightedReturn,
    contributors: eligible
      .map((item) => ({ ...item, contribution: (item.weight / totalWeight) * item.ratio }))
      .sort((a, b) => Math.abs(b.ratio) - Math.abs(a.ratio))
  };
}

function formatReturnPercent(value) {
  const sign = value >= 0 ? '+' : '−';
  return `${sign}${Math.abs(value * 100).toFixed(2)}%`;
}

function formatShortDateLabel(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!match) return '';
  return `${match[1].slice(-2)}-${match[2]}-${match[3]}`;
}

export function buildHoldingsNotificationContent(kind, returnRate, contributors, dateKey = '') {
  const kindLabel = kind === 'exchange' ? '场内' : '场外';
  const dateLabel = formatShortDateLabel(dateKey);
  const title = `[${kindLabel}] ${dateLabel ? `${dateLabel} ` : ''}当日收益 ${formatReturnPercent(returnRate)}`;
  const top = contributors.slice(0, 3).map((item) => `${item.code} ${formatReturnPercent(item.ratio)}`);
  // 出于隐私考虑：推送仅展示加权收益率，不再携带 ¥ 金额；具体金额请回网页查看。
  const body = top.length
    ? `今日${kindLabel}加权收益率 ${formatReturnPercent(returnRate)}；贡献 Top：${top.join('、')} → 点击查看明细。`
    : `今日${kindLabel}加权收益率 ${formatReturnPercent(returnRate)} → 点击查看明细。`;
  // 富文本通道支持 **bold** / 列表 / 空行；这里给出更清晰的视觉层次。
  const topMdItems = contributors.slice(0, 3).map((item) => `- ${item.code} **${formatReturnPercent(item.ratio)}**`);
  const bodyMdLines = [`**${kindLabel}加权收益率 ${formatReturnPercent(returnRate)}**`];
  if (topMdItems.length) {
    bodyMdLines.push('', '贡献 Top：', ...topMdItems);
  }
  bodyMdLines.push('', '点击查看明细。');
  const body_md = bodyMdLines.join('\n');
  return { title, body, summary: `${kindLabel}当日收益 ${formatReturnPercent(returnRate)}`, body_md };
}

// 全仓总览（场内 + 场外合并）推送内容构造。
// 出于隐私考虑：不再展示任何 ¥ 金额（不论旧版 digest 是否携带 totals），
// 仅显示加权收益率百分比 + 贡献 Top；具体金额引导用户去网页查看。
// 第三个参数保留签名以兼容旧调用方，内部不再读取。
export function buildHoldingsNotificationContentAll(returnRate, contributors, dateKey = '', _totalsLegacy = null) {
  void _totalsLegacy;
  const dailyPct = formatReturnPercent(returnRate);
  const dateLabel = formatShortDateLabel(dateKey);
  const top = (contributors || []).slice(0, 3).map((item) => `${item.code} ${formatReturnPercent(item.ratio)}`);
  const title = `[持仓总览] ${dateLabel ? `${dateLabel} ` : ''}当日收益 ${dailyPct}`;
  const summary = `当日加权收益率 ${dailyPct}`;
  const body = top.length
    ? `今日加权收益率 ${dailyPct}；贡献 Top：${top.join('、')} → 点击查看明细。`
    : `今日加权收益率 ${dailyPct} → 点击查看明细。`;

  // 富文本通道支持 **bold** / 列表 / 空行；这里给出更清晰的视觉层次。
  const topMdItems = (contributors || []).slice(0, 3).map((item) => `- ${item.code} **${formatReturnPercent(item.ratio)}**`);
  const bodyMdLines = [`**当日加权收益率 ${dailyPct}**`];
  if (topMdItems.length) {
    bodyMdLines.push('', '贡献 Top：', ...topMdItems);
  }
  bodyMdLines.push('', '点击查看明细。');
  const body_md = bodyMdLines.join('\n');

  return { title, body, summary, body_md };
}
// 持仓预警合并通知的纯内容构造模块：只做排序、去重和文案拼装，不发请求、不投递。
// 网络发送与状态推进保留在 alertRuleEvaluation.js 的 evaluateHoldingAlertRules。

export const HOLDING_ALERT_GROUP_ORDER = ['gain', 'loss'];

const GAIN_TYPE_LABEL = '持仓涨幅预警';
const LOSS_TYPE_LABEL = '持仓跌幅预警';
const BODY_SUFFIX = ' → 点此查看持仓。';

export function holdingAlertTypeLabel(alertType = '') {
  return alertType === 'loss' ? LOSS_TYPE_LABEL : GAIN_TYPE_LABEL;
}

/** 带符号两位小数百分比：盈利显式 `+`，亏损保留 `-`。 */
export function formatSignedPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  const label = numeric.toFixed(2);
  return `${label.startsWith('-') ? '' : '+'}${label}%`;
}

/** Markdown 表格单元格：换行归一为空格，`|` 转义避免破坏表格。 */
function normalizeMarkdownCell(value = '') {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim().replace(/\|/g, '\\|');
}

/**
 * 按 ruleId 去重后排序：盈利按收益降序、亏损按亏损幅度升序（更差在前），
 * 再按 symbol、ruleId 稳定排序。正文、Markdown 与快照使用同一顺序。
 */
export function collectHoldingAlertSnapshots(alerts = []) {
  const seenRuleIds = new Set();
  const unique = [];
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const ruleId = String(alert?.ruleId || '').trim();
    if (!ruleId || seenRuleIds.has(ruleId)) continue;
    seenRuleIds.add(ruleId);
    unique.push({
      ruleId,
      symbol: String(alert?.symbol || '').trim(),
      name: String(alert?.name || '').trim(),
      fundKind: String(alert?.fundKind || '').trim(),
      alertType: String(alert?.alertType || '').trim(),
      threshold: Number(alert?.threshold) || 0,
      actualValue: Number(alert?.actualValue) || 0,
      currentPrice: Number(alert?.currentPrice) || 0,
      holdingCost: Number(alert?.holdingCost) || 0,
      cooldownHours: Number(alert?.cooldownHours) || 24
    });
  }

  return unique.sort((a, b) => {
    const valueDiff = a.alertType === 'loss' ? a.actualValue - b.actualValue : b.actualValue - a.actualValue;
    if (valueDiff !== 0) return valueDiff;
    const symbolDiff = a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    if (symbolDiff !== 0) return symbolDiff;
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });
}

/**
 * 正文按「标的 + 收益 + 成本」归并展示：同标的同成本同收益只显示一行；
 * 同标的存在多组评估时附上成本，避免出现无法分辨的重复行。所有规则快照仍完整保留。
 */
function buildBodyItems(sortedAlerts) {
  const bySymbol = new Map();
  for (const alert of sortedAlerts) {
    const evaluations = bySymbol.get(alert.symbol) || [];
    const evaluationKey = `${alert.actualValue}|${alert.holdingCost}`;
    if (!evaluations.some((item) => item.key === evaluationKey)) {
      evaluations.push({ key: evaluationKey, actualValue: alert.actualValue, holdingCost: alert.holdingCost });
    }
    bySymbol.set(alert.symbol, evaluations);
  }

  const items = [];
  for (const [symbol, evaluations] of bySymbol) {
    for (const evaluation of evaluations) {
      const percentLabel = formatSignedPercent(evaluation.actualValue);
      items.push(evaluations.length > 1
        ? `${symbol} ${percentLabel}（成本 ¥${evaluation.holdingCost.toFixed(3)}）`
        : `${symbol} ${percentLabel}`);
    }
  }
  return items;
}

function buildMarkdown(sortedAlerts, title) {
  return [
    `**${title}**`,
    '',
    '| 标的 | 名称 | 持仓收益 | 触发阈值 | 当前价 | 持仓成本 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...sortedAlerts.map((alert) => `| ${normalizeMarkdownCell(alert.symbol)} | ${normalizeMarkdownCell(alert.name || alert.symbol)} | ${formatSignedPercent(alert.actualValue)} | ${alert.threshold.toFixed(1)}% | ¥${alert.currentPrice.toFixed(3)} | ¥${alert.holdingCost.toFixed(3)} |`),
    '',
    '点此查看持仓。'
  ].join('\n');
}

/** clientId 的短稳定哈希前缀，防止同一毫秒不同客户端的合并事件 ID 相互碰撞。 */
async function buildClientScopeToken(clientId = '') {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(clientId || '')));
  return Array.from(new Uint8Array(digest)).slice(0, 6).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 构造一条合并持仓预警通知（同一 alertType 一组）。返回值即传给 deliverNotification
 * 的完整 payload；eventId 规则：holding-alert:merged:<alertType>:<nowMs>:<clientScopeToken>。
 */
export async function buildMergedHoldingAlertNotification({ alertType, alerts = [], clientId = '', nowMs = Date.now() } = {}) {
  const sorted = collectHoldingAlertSnapshots(alerts);
  if (!sorted.length) {
    throw new Error('合并持仓预警至少需要一条命中规则');
  }

  const symbols = [...new Set(sorted.map((alert) => alert.symbol))];
  const title = `${holdingAlertTypeLabel(alertType)}（${symbols.length}只）`;
  const action = buildNotificationDetailAction('holdings', '', {
    trigger: 'holding-alert',
    alertType
  });
  const clientScopeToken = await buildClientScopeToken(clientId);

  return {
    eventId: `holding-alert:merged:${alertType}:${nowMs}:${clientScopeToken}`,
    eventType: 'holding-alert',
    ruleId: `holding-alert:merged:${alertType}`,
    title,
    body: `${buildBodyItems(sorted).join(', ')}${BODY_SUFFIX}`,
    body_md: buildMarkdown(sorted, title),
    summary: title,
    symbol: '',
    merged: true,
    alertType,
    holdingCount: symbols.length,
    alertCount: sorted.length,
    ruleIds: sorted.map((alert) => alert.ruleId),
    symbols,
    alerts: sorted,
    detailUrl: action.detailUrl,
    url: action.url,
    links: action.links,
    target: action.target,
    params: action.params
  };
}

export const MAX_CHANNEL_FAILURES = 10;
function text(value = "", max = 5000) { return String(value ?? "").trim().slice(0, max); }
export function updateDeliveryFailures(previousFailures, results = [], nowIso) {
  const nextFailures = { ...(previousFailures || {}) }; const removals = [];
  for (const result of results) { const key = text(result?.configKey, 240); if (!key || result.status === 'skipped' || result.channel === 'queue') continue; if (result.status === 'delivered' || result.status === 'queued') { delete nextFailures[key]; continue; } const previous = nextFailures[key] || {}; const count = (Number(previous.count) || 0) + 1; const value = { configKey: key, configType: text(result.configType), configId: text(result.configId), configLabel: text(result.configLabel), channel: text(result.channel), count, lastFailureAt: nowIso, detail: text(result.detail, 500) }; if (count >= MAX_CHANNEL_FAILURES) { removals.push({ ...value, failures: count }); delete nextFailures[key]; } else nextFailures[key] = value; }
  return { nextFailures, removals };
}

export function getShanghaiHHMM(date = new Date()) { return getShanghaiDateParts(date).hhmm; }
export function buildNotificationDetailAction(target = 'tradePlans', ruleId = '', params = {}) {
  target = String(target || '').trim() || 'tradePlans';
  params = { ...(String(ruleId || '').trim() ? {ruleId: String(ruleId).trim()} : {}), ...params };
  const url = new URL('/index.html', process.env.NOTIFICATION_WEB_BASE_URL || 'https://freebacktrack.tech');
  url.searchParams.set('tab', target); url.searchParams.set('source', 'notification');
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  const web = url.toString();
  return {target, params, web, app:'', miniProgram:'', links:{web, app:'', miniProgram:''}, detailUrl:web, url:web};
}
