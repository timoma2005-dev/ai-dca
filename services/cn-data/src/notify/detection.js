import { compileNotifyRules } from './rules.js';
import { deliverCycleNotification, saveNotifyEvent } from './cycleDelivery.js';
import { buildNotificationDetailAction, buildDcaNotification, buildNotificationEventId, buildPlanNotification, resolveDcaWindow, updateDeliveryFailures } from './detectionSupport.js';
import { evaluatePlanRule, evaluateMarketAlertRules, evaluateHoldingAlertRules } from './detectionEvaluation.js';
import { loadLatestMarketMap, MARKETS_BASE } from './marketClient.js';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const MAX_RECENT_EVENTS = 30;
function appendEvent(recentEvents = [], event) {
  return [event, ...recentEvents].slice(0, MAX_RECENT_EVENTS);
}

function getDeliveryFailures(state = {}) {
  return typeof state?.deliveryFailures === 'object' && state.deliveryFailures ? state.deliveryFailures : {};
}


function splitMarketAlertRulesByVenue(rules = []) {
  return (Array.isArray(rules) ? rules : []).reduce((groups, rule) => {
    const kind = String(rule?.fundKind || '').trim().toLowerCase();
    const venue = kind === 'otc' || kind === 'qdii' ? 'otc' : 'exchange';
    groups[venue].push(rule);
    return groups;
  }, { exchange: [], otc: [] });
}


export function loadClientRecord(db, account) {
  const row = db.prepare("SELECT payload FROM notify_user_records WHERE owner_user_id=? AND record_type='client' AND record_id=?").get(account.userId, account.clientId);
  if (!row) return null;
  try { const record = JSON.parse(row.payload); return record && typeof record === 'object' && !Array.isArray(record) ? record : null; } catch { return null; }
}
export function writeClientRecord(db, account, record) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO notify_user_records(owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
    VALUES (?, 'client', ?, ?, 1, ?, ?) ON CONFLICT(owner_user_id, record_type, record_id)
    DO UPDATE SET payload=excluded.payload, revision=notify_user_records.revision+1, updated_at=excluded.updated_at`)
    .run(account.userId, account.clientId, JSON.stringify(record), now, now);
}
export async function runDetectionCycle(db, account, {reason = 'scheduled'} = {}) {
  const record = loadClientRecord(db, account);
  if (!record) return {skipped:'no-client-record'};
  const payload = record.payload || {};
  const storedState = record.state || {};
  const env = {NOTIFY_TIMEZONE:process.env.NOTIFY_TIMEZONE || DEFAULT_TIMEZONE, MARKETS_BASE_URL:MARKETS_BASE,
    __notifyCurrentClientId:account.clientId, deliver:notification => deliverCycleNotification(db, account, notification)};
  const nextState = {
    ruleStates: typeof storedState?.ruleStates === 'object' && storedState.ruleStates ? storedState.ruleStates : {},
    deliveryFailures: getDeliveryFailures(storedState),
    deliveryAcks: typeof storedState?.deliveryAcks === 'object' && storedState.deliveryAcks ? storedState.deliveryAcks : {},
    lastRunAt: new Date().toISOString()
  };
  let recentEvents = Array.isArray(storedState?.recentEvents) ? storedState.recentEvents : [];
  const compiled = compileNotifyRules(payload);
  const latestMarketMap = compiled.planRules.length ? await loadLatestMarketMap(compiled.planRules) : {};
  const dailyCache = new Map();
  const events = [];
  const now = new Date();
  // cn 移植保留失败计数用于观测，刻意不移植自动移除/禁用通道。
  const originalDeliver = env.deliver;
  env.deliver = async notification => {
    const delivery = await originalDeliver(notification);
    const update = updateDeliveryFailures(nextState.deliveryFailures, delivery.results, now.toISOString());
    nextState.deliveryFailures = update.nextFailures;
    for (const removal of update.removals) nextState.deliveryFailures[removal.configKey] = {...removal, count:removal.failures};
    return delivery;
  };
  const timeZone = String(env.NOTIFY_TIMEZONE || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;

  for (const rule of compiled.planRules) {
    const previousState = nextState.ruleStates[rule.ruleId] || {};
    try {
      const evaluation = await evaluatePlanRule(rule, latestMarketMap, dailyCache);
      const stageOrder = Number(evaluation.deepestTriggeredLayer?.order) || 0;
      const hasNewTrigger = stageOrder > 0 && (!previousState.isInTriggeredZone || stageOrder > (Number(previousState.lastHandledStage) || 0));

      if (stageOrder <= 0) {
        nextState.ruleStates[rule.ruleId] = {
          ...previousState,
          isInTriggeredZone: false,
          currentStage: 0,
          lastEvaluatedAt: now.toISOString(),
          lastTriggerPrice: evaluation.currentPrice
        };
        continue;
      }

      nextState.ruleStates[rule.ruleId] = {
        ...previousState,
        isInTriggeredZone: true,
        currentStage: stageOrder,
        lastEvaluatedAt: now.toISOString(),
        lastTriggerPrice: evaluation.currentPrice
      };

      if (!hasNewTrigger) {
        continue;
      }

      const notification = buildPlanNotification(rule, evaluation, {
        eventId: buildNotificationEventId(rule.ruleId, `stage-${stageOrder}`, now)
      });
      const delivery = await env.deliver(notification);
      nextState.ruleStates[rule.ruleId] = {
        ...nextState.ruleStates[rule.ruleId],
        lastHandledStage: stageOrder,
        lastHandledAt: now.toISOString(),
        lastHandledStatus: delivery.status
      };
      const event = {
        id: notification.eventId,
        eventType: notification.eventType,
        ruleId: rule.ruleId,
        title: notification.title,
        body: notification.body,
        body_md: notification.body_md || '',
        summary: notification.summary,
        symbol: notification.symbol,
        strategyName: notification.strategyName,
        triggerCondition: notification.triggerCondition,
        purchaseAmount: notification.purchaseAmount,
        detailUrl: notification.detailUrl,
        links: notification.links || null,
        target: notification.target || '',
        params: notification.params || null,
        status: delivery.status,
        channels: delivery.results,
        createdAt: now.toISOString(),
        reason
      };
      events.push(event);
      recentEvents = appendEvent(recentEvents, event);
      saveNotifyEvent(db, account, event);
    } catch (error) {
      nextState.ruleStates[rule.ruleId] = {
        ...previousState,
        lastEvaluatedAt: now.toISOString(),
        lastError: error instanceof Error ? error.message : '价格策略检测失败'
      };
    }
  }

  for (const rule of compiled.dcaRules) {
    const previousState = nextState.ruleStates[rule.ruleId] || {};
    const window = resolveDcaWindow(rule, now, timeZone);
    const isFirstExecution = Boolean(rule.linkedPlanId) && !previousState.firstExecutionHandled;

    nextState.ruleStates[rule.ruleId] = {
      ...previousState,
      lastEvaluatedAt: now.toISOString(),
      currentWindowKey: window.windowKey
    };

    if (!window.due || previousState.lastHandledWindowKey === window.windowKey) {
      continue;
    }

    const notification = buildDcaNotification(rule, window.localDateLabel, {
      isFirstExecution,
      eventId: buildNotificationEventId(rule.ruleId, window.windowKey, now)
    });
    const delivery = await env.deliver(notification);
    nextState.ruleStates[rule.ruleId] = {
      ...nextState.ruleStates[rule.ruleId],
      lastHandledWindowKey: window.windowKey,
      lastHandledAt: now.toISOString(),
      lastHandledStatus: delivery.status,
      firstExecutionHandled: previousState.firstExecutionHandled || isFirstExecution
    };
    const event = {
      id: notification.eventId,
      eventType: notification.eventType,
      ruleId: rule.ruleId,
      title: notification.title,
      body: notification.body,
      body_md: notification.body_md || '',
      summary: notification.summary,
      symbol: notification.symbol,
      strategyName: notification.strategyName,
      triggerCondition: notification.triggerCondition,
      purchaseAmount: notification.purchaseAmount,
      detailUrl: notification.detailUrl,
      links: notification.links || null,
      target: notification.target || '',
      params: notification.params || null,
      status: delivery.status,
      channels: delivery.results,
      createdAt: now.toISOString(),
      reason
    };
    events.push(event);
    recentEvents = appendEvent(recentEvents, event);
      saveNotifyEvent(db, account, event);
  }

  if (compiled.marketAlertRules?.length) {
    const groupedMarketAlerts = splitMarketAlertRulesByVenue(compiled.marketAlertRules);
    for (const [venue, venueRules] of Object.entries(groupedMarketAlerts)) {
      if (!venueRules.length) continue;
      const marketAlertStateKey = `${env.__notifyCurrentClientId}:market-alerts:${venue}`;
      const marketAlertResult = await evaluateMarketAlertRules(env, venueRules, {
        clientId: env.__notifyCurrentClientId,
        settings: env.__notifySettings,
        readState: async () => nextState.ruleStates[marketAlertStateKey] || {},
        writeState: async (data) => { nextState.ruleStates[marketAlertStateKey] = data; },
        now
      });

      for (const item of marketAlertResult.delivered || []) {
        const action = buildNotificationDetailAction('markets', '', {
          code: item.symbol,
          trigger: 'market-alert',
          ruleId: item.ruleId
        });
        const event = {
          id: `market-alert:${item.symbol}:${now.toISOString()}`,
          eventType: 'market-alert',
          ruleId: item.ruleId,
          title: `${item.symbol} 市场预警`,
          body: `触发值: ${item.actualValue.toFixed(2)}%`,
          body_md: '',
          summary: `${item.symbol} 市场预警`,
          symbol: item.symbol,
          strategyName: '',
          triggerCondition: '',
          purchaseAmount: '',
          detailUrl: action.detailUrl,
          links: action.links,
          target: action.target,
          params: action.params,
          status: 'delivered',
          channels: item.results,
          createdAt: now.toISOString(),
          reason
        };
        events.push(event);
        recentEvents = appendEvent(recentEvents, event);
      saveNotifyEvent(db, account, event);
      }
    }
  }

  if (compiled.holdingAlertRules?.length) {
    const holdingAlertStateKey = `${env.__notifyCurrentClientId}:holding-alerts`;
    const holdingAlertResult = await evaluateHoldingAlertRules(env, compiled.holdingAlertRules, {
      clientId: env.__notifyCurrentClientId,
      settings: env.__notifySettings,
      readState: async () => nextState.ruleStates[holdingAlertStateKey] || {},
      writeState: async (data) => { nextState.ruleStates[holdingAlertStateKey] = data; },
      now
    });

    // 持仓预警按 alertType 合并投递：delivered 每项对应一次组投递（非单条规则），
    // 事件直接复用通知的 ID 与内容，状态取投递引擎的真实聚合结果。
    for (const item of holdingAlertResult.delivered || []) {
      const notification = item.notification || {};
      const event = {
        id: notification.eventId,
        eventType: notification.eventType || 'holding-alert',
        ruleId: notification.ruleId,
        title: notification.title,
        body: notification.body,
        body_md: notification.body_md || '',
        summary: notification.summary,
        symbol: notification.symbol,
        merged: Boolean(notification.merged),
        alertType: notification.alertType || item.alertType || '',
        holdingCount: notification.holdingCount,
        alertCount: notification.alertCount,
        ruleIds: notification.ruleIds || [],
        symbols: notification.symbols || [],
        alerts: notification.alerts || [],
        strategyName: '',
        triggerCondition: '',
        purchaseAmount: '',
        detailUrl: notification.detailUrl,
        url: notification.url,
        links: notification.links || null,
        target: notification.target || '',
        params: notification.params || null,
        status: item.status,
        channels: item.results,
        createdAt: now.toISOString(),
        reason
      };
      events.push(event);
      recentEvents = appendEvent(recentEvents, event);
      saveNotifyEvent(db, account, event);
    }
  }

  writeClientRecord(db, account, {...record, state: {...nextState, recentEvents}});
  return {
    state: {
      ...nextState,
      recentEvents
    },
    summary: {
      triggeredCount: events.length,
      deliveredCount: events.filter((event) => event.status === 'delivered').length,
      events,
      counts: compiled.summary
    }
  };
}
