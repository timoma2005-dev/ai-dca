import { buildNotificationDetailAction, buildNotificationEventId, HOLDING_ALERT_GROUP_ORDER, buildMergedHoldingAlertNotification, isChinaMarketHoliday } from './detectionSupport.js';
import { loadLatestMarketMap } from './marketClient.js';
import { buildMovingAverageValues, buildNasdaqStrategyPlan, buildPeakDrawdownStrategyPlan, findLatestFiniteValue, mapReferencePrice } from './strategyEnginePort.js';
import { getLatestBarClose, buildStageHighPrice, toDisplayLayers, resolveDeepestTriggeredLayer, getCurrency, roundPrice } from './detectionSupport.js';
import { loadDailyBars } from './marketClient.js';
const EXCHANGE_PREFIXES = new Set(['15', '50', '51', '52', '54', '56', '58']);

function getShanghaiParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now).reduce((map, part) => {
    map[part.type] = part.value;
    return map;
  }, {});
  return {
    date: `${parts.year || ''}-${parts.month || ''}-${parts.day || ''}`,
    weekday: parts.weekday,
    hhmm: Number(`${parts.hour || '00'}${parts.minute || '00'}`)
  };
}

function isChinaExchangeTradingSession(now = new Date()) {
  const { date, weekday, hhmm } = getShanghaiParts(now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  // 法定节假日休市（如国庆）：即使是工作日也不开盘，避免用过期数据跑规则。
  if (isChinaMarketHoliday(date)) return false;
  return (hhmm >= 930 && hhmm <= 1130) || (hhmm >= 1300 && hhmm <= 1500);
}

/** 休市日返回 'market-holiday'，其余非交易时段返回 'exchange-market-closed'（可观测）。 */
function exchangeClosedReason(now = new Date()) {
  const { date } = getShanghaiParts(now);
  return isChinaMarketHoliday(date) ? 'market-holiday' : 'exchange-market-closed';
}

function resolveRuleFundKind(rule = {}) {
  const explicit = String(rule.fundKind || rule.kind || '').trim().toLowerCase();
  if (explicit === 'exchange' || explicit === 'otc' || explicit === 'qdii') return explicit;
  const symbol = String(rule.symbol || '').trim();
  return /^\d{6}$/.test(symbol) && EXCHANGE_PREFIXES.has(symbol.slice(0, 2)) ? 'exchange' : '';
}

function isPremiumAlert(rule = {}) {
  return rule.alertType === 'premium' || rule.alertType === 'premium-below';
}

export async function evaluateMarketAlertRules(env, rules, options = {}) {
  const { readState, writeState, now = new Date() } = options;
  if (!Array.isArray(rules) || !rules.length) return { skipped: 'no-rules' };

  const exchangeTrading = isChinaExchangeTradingSession(now);
  const closedReason = exchangeClosedReason(now);
  const runnableRules = [];
  const preSkipped = [];

  for (const rule of rules) {
    const fundKind = resolveRuleFundKind(rule);
    if (fundKind === 'exchange' && !exchangeTrading) {
      preSkipped.push({ ruleId: rule.ruleId, reason: closedReason });
      continue;
    }
    if ((fundKind === 'otc' || fundKind === 'qdii') && isPremiumAlert(rule)) {
      preSkipped.push({ ruleId: rule.ruleId, reason: 'premium-unavailable-for-otc' });
      continue;
    }
    runnableRules.push({ ...rule, fundKind });
  }

  if (!runnableRules.length) return { delivered: [], skipped: preSkipped };

  const latestMarketMap = await loadLatestMarketMap(runnableRules.map(r => ({ symbol: r.symbol, fundKind: r.fundKind })), { forceRefresh: true });

  const prev = (typeof readState === 'function' ? (await readState()) : null) || {};
  const next = { ...prev };
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const delivered = [];
  const skipped = [...preSkipped];

  for (const rule of runnableRules) {
    const symbol = String(rule.symbol || '').trim();
    if (!symbol) continue;

    const marketEntry = latestMarketMap[symbol];
    if (!marketEntry) {
      skipped.push({ ruleId: rule.ruleId, reason: 'no-market-data' });
      continue;
    }

    const currentPrice = Number(marketEntry.current_price) || 0;
    const previousClose = Number(marketEntry.previous_close) || 0;

    if (currentPrice <= 0 || previousClose <= 0) {
      skipped.push({ ruleId: rule.ruleId, reason: 'invalid-price' });
      continue;
    }

    // 计算涨跌幅基准
    let basePrice = previousClose; // 默认是前一交易日收盘价（daily）
    if (rule.priceBase === 'alert-day' && rule.alertDayPrice) {
      basePrice = Number(rule.alertDayPrice);
    } else if (rule.priceBase === 'alert-day' && !rule.alertDayPrice) {
      // 首次触发，记录基准价格
      rule.alertDayPrice = previousClose;
      basePrice = previousClose;
    }

    const changePct = ((currentPrice - basePrice) / basePrice) * 100;
    const rawPremiumRate = Number(marketEntry.premium_rate ?? marketEntry.premiumPercent);
    const premiumRate = Number.isFinite(rawPremiumRate) ? rawPremiumRate : null;

    let triggered = false;
    let actualValue = 0;
    let valueLabel = '';

    switch (rule.alertType) {
      case 'gain':
        actualValue = changePct;
        triggered = changePct >= rule.threshold;
        valueLabel = `涨幅 ${changePct.toFixed(2)}%`;
        break;
      case 'loss':
        actualValue = -changePct;
        triggered = changePct <= -rule.threshold;
        valueLabel = `跌幅 ${Math.abs(changePct).toFixed(2)}%`;
        break;
      case 'premium':
        if (premiumRate === null) {
          skipped.push({ ruleId: rule.ruleId, reason: 'invalid-premium' });
          continue;
        }
        actualValue = premiumRate;
        triggered = premiumRate >= rule.threshold;
        valueLabel = `溢价率 ${premiumRate.toFixed(2)}%`;
        break;
      case 'premium-below':
        if (premiumRate === null) {
          skipped.push({ ruleId: rule.ruleId, reason: 'invalid-premium' });
          continue;
        }
        actualValue = premiumRate;
        triggered = premiumRate <= rule.threshold;
        valueLabel = `溢价率 ${premiumRate.toFixed(2)}%`;
        break;
    }

    if (!triggered) {
      skipped.push({ ruleId: rule.ruleId, reason: 'not-triggered', actualValue });
      continue;
    }

    const state = prev[rule.ruleId] || {};
    const prevAt = Number(state.lastPushedAt) || 0;
    const cooldownMs = (rule.cooldownHours || 24) * 60 * 60 * 1000;

    if (nowMs - prevAt < cooldownMs) {
      skipped.push({ ruleId: rule.ruleId, reason: 'debounced', actualValue });
      continue;
    }

    const typeLabel = {
      gain: '涨幅预警',
      loss: '跌幅预警',
      premium: '溢价预警',
      'premium-below': '溢价率低于预警'
    }[rule.alertType] || '市场预警';

    const title = `${symbol} ${rule.name || ''} ${typeLabel}`;
    const body = `${symbol} ${valueLabel}，已超过设定阈值 ${rule.threshold.toFixed(1)}%。当前价 ¥${currentPrice.toFixed(3)} → 点此查看行情详情。`;
    const body_md = [
      `**${symbol} ${typeLabel}**`,
      '',
      `- 基金：${rule.name || symbol}`,
      `- 当前价：**¥${currentPrice.toFixed(3)}**`,
      `- ${valueLabel}（阈值 ${rule.threshold.toFixed(1)}%）`,
      `- 昨收：¥${previousClose.toFixed(3)}`
    ].join('\n');

    const action = buildNotificationDetailAction('markets', '', {
      code: symbol,
      trigger: 'market-alert',
      ruleId: rule.ruleId
    });


    const notification = {
      eventId: buildNotificationEventId(rule.ruleId, `triggered:${actualValue.toFixed(2)}`, new Date(nowMs)),
      eventType: 'market-alert',
      ruleId: rule.ruleId,
      title,
      body,
      body_md,
      summary: title,
      symbol,
      detailUrl: action.detailUrl,
      url: action.url,
      links: action.links,
      target: action.target,
      params: action.params
    };

    try {
      const result = await env.deliver(notification);
      delivered.push({ ruleId: rule.ruleId, symbol, actualValue, results: result?.results || [] });
      next[rule.ruleId] = { lastPushedAt: nowMs, lastPushedValue: actualValue };
    } catch (error) {
      skipped.push({ ruleId: rule.ruleId, reason: 'delivery-error', detail: error.message });
    }
  }

  if (typeof writeState === 'function' && delivered.length) {
    await writeState(next);
  }

  return { delivered, skipped };
}

export async function evaluateHoldingAlertRules(env, rules, options = {}) {
  const { clientId = '', readState, writeState, now = new Date() } = options;
  if (!Array.isArray(rules) || !rules.length) return { skipped: 'no-rules' };

  // A 股休市日净值不更新，用过期数据跑持仓预警会误报，直接跳过（可观测）。
  if (isChinaMarketHoliday(getShanghaiParts(now).date)) {
    return { skipped: 'market-holiday', delivered: [], skippedRules: rules.map((r) => r.ruleId) };
  }

  const latestMarketMap = await loadLatestMarketMap(rules.map(r => ({ symbol: r.symbol, fundKind: r.fundKind })), { forceRefresh: true });

  const prev = (typeof readState === 'function' ? (await readState()) : null) || {};
  const next = { ...prev };
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const delivered = [];
  const skipped = [];
  const eligibleByType = { gain: [], loss: [] };

  for (const rule of rules) {
    const symbol = String(rule.symbol || '').trim();
    if (!symbol) continue;

    const marketEntry = latestMarketMap[symbol];
    if (!marketEntry) {
      skipped.push({ ruleId: rule.ruleId, reason: 'no-market-data' });
      continue;
    }

    const currentPrice = Number(marketEntry.current_price) || 0;
    const holdingCost = Number(rule.holdingCost) || 0;

    if (currentPrice <= 0 || holdingCost <= 0) {
      skipped.push({ ruleId: rule.ruleId, reason: 'invalid-price-or-cost' });
      continue;
    }

    const gainPct = ((currentPrice - holdingCost) / holdingCost) * 100;

    let triggered = false;
    const actualValue = gainPct;

    switch (rule.alertType) {
      case 'gain':
        triggered = gainPct >= rule.threshold;
        break;
      case 'loss':
        triggered = gainPct <= -rule.threshold;
        break;
    }

    if (!triggered) {
      skipped.push({ ruleId: rule.ruleId, reason: 'not-triggered', actualValue });
      continue;
    }

    const state = prev[rule.ruleId] || {};
    const prevAt = Number(state.lastPushedAt) || 0;
    const cooldownMs = (rule.cooldownHours || 24) * 60 * 60 * 1000;

    if (nowMs - prevAt < cooldownMs) {
      skipped.push({ ruleId: rule.ruleId, reason: 'debounced', actualValue });
      continue;
    }

    // 命中且过了冷却的规则先按 alertType 入桶；循环结束后每桶合并成一条推送，
    // 避免一次评估周期内 28 只持仓触发 28 条独立推送。
    if (rule.alertType === 'gain' || rule.alertType === 'loss') {
      eligibleByType[rule.alertType].push({
        ruleId: rule.ruleId,
        symbol,
        name: String(rule.name || '').trim(),
        fundKind: String(rule.fundKind || '').trim(),
        alertType: rule.alertType,
        threshold: rule.threshold,
        actualValue,
        currentPrice,
        holdingCost,
        cooldownHours: rule.cooldownHours || 24
      });
    }
  }

  // 顺序固定 gain → loss；每桶一次投递，单组异常不影响另一组。
  for (const alertType of HOLDING_ALERT_GROUP_ORDER) {
    const alerts = eligibleByType[alertType];
    if (!alerts.length) continue;


    try {
      const notification = await buildMergedHoldingAlertNotification({ alertType, alerts, clientId, nowMs });
      const result = await env.deliver(notification);
      delivered.push({
        notification,
        alertType,
        alerts: notification.alerts,
        status: result?.status,
        results: result?.results || []
      });
      // 组内一次投递后，每个成员各自推进原 ruleId 的冷却状态（沿用「不抛错即推进」的现有策略）。
      for (const alert of notification.alerts) {
        next[alert.ruleId] = { lastPushedAt: nowMs, lastPushedValue: alert.actualValue };
      }
    } catch (error) {
      for (const alert of alerts) {
        skipped.push({ ruleId: alert.ruleId, reason: 'delivery-error', detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (typeof writeState === 'function' && delivered.length) {
    await writeState(next);
  }

  return { delivered, skipped };
}

export async function evaluatePlanRule(rule, latestMarketMap, dailyCache) {
  const selectedEntry = latestMarketMap[rule.symbol] || null;
  const benchmarkEntry = latestMarketMap[rule.referenceSymbol] || selectedEntry || null;
  const benchmarkBars = await loadDailyBars(dailyCache, rule.referenceSymbol);

  const fallbackBenchmarkClose = getLatestBarClose(benchmarkBars);
  let currentFundPrice = Number(selectedEntry?.current_price) || 0;
  let currentBenchmarkPrice = Number(benchmarkEntry?.current_price) || 0;
  if (!(currentBenchmarkPrice > 0)) {
    currentBenchmarkPrice = fallbackBenchmarkClose;
  }
  if (!(currentFundPrice > 0)) {
    if (rule.symbol === rule.referenceSymbol) {
      currentFundPrice = currentBenchmarkPrice;
    } else {
      const selectedBars = await loadDailyBars(dailyCache, rule.symbol);
      currentFundPrice = getLatestBarClose(selectedBars);
    }
  }
  if (!(currentBenchmarkPrice > 0)) {
    currentBenchmarkPrice = currentFundPrice;
  }
  const dailyMa120 = findLatestFiniteValue(
    buildMovingAverageValues(benchmarkBars, 120, { allowPartial: benchmarkBars.length > 0 && benchmarkBars.length < 120 })
  );
  const dailyMa200 = findLatestFiniteValue(
    buildMovingAverageValues(benchmarkBars, 200, { allowPartial: benchmarkBars.length > 0 && benchmarkBars.length < 200 })
  );
  const stageHighPrice = buildStageHighPrice(benchmarkBars);
  const strategyTriggerPrice = Number.isFinite(dailyMa120)
    ? dailyMa120
    : Number.isFinite(dailyMa200)
      ? dailyMa200
      : currentBenchmarkPrice > 0
        ? currentBenchmarkPrice
        : Number(rule.basePrice) || 0;
  const riskControlPrice = Number.isFinite(dailyMa200)
    ? dailyMa200
    : strategyTriggerPrice > 0
      ? strategyTriggerPrice * 0.85
      : Number(rule.riskControlPrice) || 0;
  const strategyPlan = rule.selectedStrategy === 'peak-drawdown'
    ? buildPeakDrawdownStrategyPlan({
        totalBudget: rule.totalBudget,
        cashReservePct: rule.cashReservePct,
        peakPrice: stageHighPrice,
        fallbackPrice: currentBenchmarkPrice || Number(rule.basePrice) || 0
      })
    : buildNasdaqStrategyPlan({
        totalBudget: rule.totalBudget,
        cashReservePct: rule.cashReservePct,
        ma120: strategyTriggerPrice,
        ma200: riskControlPrice,
        fallbackPrice: currentBenchmarkPrice || Number(rule.basePrice) || 0
      });
  const shouldMapPrices = rule.symbol !== rule.referenceSymbol && currentFundPrice > 0 && currentBenchmarkPrice > 0;
  const strategyPriceRatio = shouldMapPrices ? currentFundPrice / currentBenchmarkPrice : 1;
  const displayLayers = toDisplayLayers(strategyPlan, strategyPriceRatio);
  const displayCurrentPrice = shouldMapPrices ? currentFundPrice : currentBenchmarkPrice;
  const deepestTriggeredLayer = resolveDeepestTriggeredLayer(displayLayers, displayCurrentPrice);

  return {
    currency: getCurrency(shouldMapPrices ? selectedEntry : benchmarkEntry),
    currentPrice: roundPrice(displayCurrentPrice),
    deepestTriggeredLayer,
    nextTriggerLayer: displayLayers.find((layer) => displayCurrentPrice > layer.price) || null,
    triggerPrice: roundPrice(mapReferencePrice(strategyTriggerPrice, strategyPriceRatio)),
    riskControlPrice: roundPrice(mapReferencePrice(riskControlPrice, strategyPriceRatio)),
    stageHighPrice: roundPrice(mapReferencePrice(stageHighPrice, strategyPriceRatio))
  };
}
