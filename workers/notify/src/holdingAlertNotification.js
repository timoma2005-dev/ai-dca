import { buildNotificationDetailAction } from './notificationRuleEvaluation.js';

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
export async function buildMergedHoldingAlertNotification(env, { alertType, alerts = [], clientId = '', nowMs = Date.now() } = {}) {
  const sorted = collectHoldingAlertSnapshots(alerts);
  if (!sorted.length) {
    throw new Error('合并持仓预警至少需要一条命中规则');
  }

  const symbols = [...new Set(sorted.map((alert) => alert.symbol))];
  const title = `${holdingAlertTypeLabel(alertType)}（${symbols.length}只）`;
  const action = buildNotificationDetailAction(env, 'holdings', '', {
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
