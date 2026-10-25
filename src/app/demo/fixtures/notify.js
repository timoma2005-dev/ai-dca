// 通知管理（notify）演示 mock：渠道已连接的演示账号 + 纳指 QDII ETF 溢价提醒。
// 通知页演示期间发出的带登录 GET（游客走演示占位令牌、已登录非 VIP 走真实令牌；均经 apiUrlWithFallback，主域名与 CF 备用域名同 pathname）：
//   GET /api/notify/status?view=summary  渠道 / 账号 / 规则计数 / 时间戳（结构同 cn-data handleStatusSummary）
//   GET /api/notify/status?view=details  最近事件 / 投递失败 / Web 设备（结构同 cn-data handleStatusDetails）
//   GET /api/notify/events               最近推送记录（结构同 cn-data handleEvents：{ events }，事件同 deliverNotification 写入的形态）
//   GET /api/notify/holdings-rule        持仓当日收益规则（结构同 holdingsRuleResponse）
//   GET /api/notify/switch/config        换基方案（useSwitchNotifyRules，复用基金切换演示的同一份方案）
// 推送记录在演示开始时生成一次并固定：全局 PC 通知轮询也会读 /events，列表不变就不会弹出演示桌面通知。
// 写入（保存渠道、启停、测试、同步规则、持仓规则、邮箱验证等 POST / PUT）不提供 mock，由演示框架按写入拦截（403）。
// 本地：seed 示例渠道缓存、溢价预警规则、预设开关、换基方案缓存与交易 / 定投计划（同交易计划演示；规则卡、预设计数、送达测试
// 不显示账号真实计划；首屏不闪账号原数据，不带入）；
// 通知页的修改都要写到服务器才算数，演示中被拦截，因此不保留任何内容（无 keepKeys / getState）。
import { RADAR_DEMO_ETFS } from './adminRadar.js';
import {
  SWITCH_CONFIG_CACHE_KEY, SWITCH_CONFIG_PATH, SWITCH_DEMO_CLIENT_ID, SWITCH_DEMO_RULES, buildSwitchDemoConfig, switchDemoComputedAt,
} from './fundSwitch.js';
import { getPreviousTradingDayShanghai } from '../../holidaysCN.js';
import { tradePlansDemoSeed } from './tradePlansData.js';

export const NOTIFY_STATUS_PATH = '/api/notify/status';
export const NOTIFY_EVENTS_PATH = '/api/notify/events';
export const NOTIFY_HOLDINGS_RULE_PATH = '/api/notify/holdings-rule';
export const NOTIFY_CLIENT_CONFIG_KEY = 'aiDcaNotifyClientConfig';
export const NOTIFY_MARKET_ALERTS_KEY = 'aiDcaMarketAlerts';
export const NOTIFY_HOLDING_ALERTS_KEY = 'aiDcaHoldingAlerts';
export const NOTIFY_PRESETS_KEY = 'ai-dca-notify-presets-v1';

export const NOTIFY_DEMO_USERNAME = 'demo';
export const NOTIFY_DEMO_CLIENT_ID = 'account:demo-user';
export const NOTIFY_DEMO_LABEL = '账号通知 · 演示账号';
export const NOTIFY_DEMO_BARK_KEY = 'DemoBarkKey7xQ2mN';
export const NOTIFY_DEMO_SERVERCHAN3 = Object.freeze({ uid: '20261', sendKeyMasked: 'sctp20...a9f3' });
export const NOTIFY_DEMO_EMAIL = 'de****@example.com';
const PREMIUM_ALERT_THRESHOLD = 15;

const ETF_BY_CODE = new Map(RADAR_DEMO_ETFS.map((item) => [item.code, item]));
// 示例单位净值（与基金切换演示同口径）。
const NAV_BASE = { 513100: 1.652, 159941: 1.214, 159513: 1.468, 513110: 1.873 };

function jitter(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 20001) / 10000 - 1;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function signedPct(value, digits = 2) {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}%`;
}

function shanghaiIso(day, minutes) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, minutes) - 8 * 3600 * 1000).toISOString();
}

function shanghaiDay(ms) {
  return new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 近 count 个交易日（由近到远），第一个是最近一次行情所在的交易日。 */
function recentTradingDays(now, count) {
  const days = [shanghaiDay(Date.parse(switchDemoComputedAt(now)))];
  while (days.length < count) days.push(getPreviousTradingDayShanghai(days[days.length - 1]));
  return days;
}

// 当日收盘溢价（与雷达 / 换基演示同一中枢）。
function premiumOn(day, code) {
  const etf = ETF_BY_CODE.get(code);
  return round(etf.base + jitter(`day:${day}`) * 0.6 + jitter(`${day}:${code}`) * 0.4, 2);
}

function etfLabel(code) {
  return `${code} ${ETF_BY_CODE.get(code)?.name || ''}`.trim();
}

const SWITCH_RULE_H2L = SWITCH_DEMO_RULES.find((rule) => rule.id === 'demo-ndx-h2l');

function channelResults({ serverChan3Failed = false } = {}) {
  return [
    { channel: 'bark', status: 'delivered', detail: '已发送到 Bark' },
    serverChan3Failed
      ? { channel: 'serverchan3', status: 'failed', detail: 'Server酱³ 请求超时，请稍后重试' }
      : { channel: 'serverchan3', status: 'delivered', detail: '已发送到 Server酱³' },
    { channel: 'email', status: 'delivered', detail: 'via resend demo' },
    { channel: 'pc', status: 'queued', detail: '已写入事件，等待 PC 浏览器拉取' },
  ];
}

function baseEvent(id, createdAt, fields, channels) {
  return {
    id,
    eventId: id,
    messageId: id,
    body_md: '',
    symbol: '',
    strategyName: '',
    triggerCondition: '',
    detailUrl: '',
    ...fields,
    status: channels.some((item) => item.status === 'delivered' || item.status === 'queued') ? 'delivered' : 'failed',
    channels,
    createdAt,
    reason: fields.reason || 'cycle',
  };
}

function switchEvent(day, minutes, toCode, opts) {
  const fromCode = SWITCH_RULE_H2L.high[0];
  const threshold = SWITCH_RULE_H2L.upperPct;
  const gap = round(premiumOn(day, fromCode) - premiumOn(day, toCode), 2);
  const createdAt = shanghaiIso(day, minutes);
  const gapStr = `${gap >= 0 ? '+' : ''}${gap.toFixed(2)}`;
  const navDate = getPreviousTradingDayShanghai(day);
  const detailUrl = `https://fast.freebacktrack.tech/markets?code=${fromCode}&source=switch-strategy`;
  return baseEvent(`switch:${SWITCH_RULE_H2L.id}:${fromCode}:${toCode}:RB:${createdAt.slice(0, 16)}`, createdAt, {
    ruleId: `switch:${SWITCH_RULE_H2L.id}:${fromCode}`,
    eventType: 'switch-strategy-trigger',
    title: `切换 B 高→低 | ${fromCode}→${toCode}`,
    body: `H−L ${gapStr}% > ${threshold}% · NAV ${navDate}\n卖 ${etfLabel(fromCode)} → 买 ${etfLabel(toCode)}\n下单前请以基金软件实时溢价为准。\n点此查看策略详情。`,
    body_md: [`**H−L ${gapStr}%** > ${threshold}% · NAV ${navDate}`, `卖 **${etfLabel(fromCode)}** → 买 **${etfLabel(toCode)}**`, '*点此查看策略详情，下单前请以基金软件实时溢价为准。*'].join('\n'),
    summary: `切换 B ${fromCode}→${toCode} ${gapStr}%`,
    symbol: fromCode,
    strategyName: `场内切换 · ${SWITCH_RULE_H2L.name}`,
    triggerCondition: `规则 B 高→低：H溢价 − L溢价 > ${threshold}%（溢价差扩大，从持仓 H 换到 L）`,
    detailUrl,
    reason: 'switch-strategy-trigger',
  }, channelResults(opts));
}

function premiumAlertEvent(day, minutes, code, alertType, threshold) {
  // 触发时刻的溢价：越过阈值一小段（按日期确定性浮动）。
  const overshoot = 0.08 + Math.abs(jitter(`alert:${day}:${code}`)) * 0.45;
  const premium = alertType === 'premium-below'
    ? round(Math.min(premiumOn(day, code), threshold - overshoot), 2)
    : round(Math.max(premiumOn(day, code), threshold + overshoot), 2);
  const price = round(NAV_BASE[code] * (1 + premium / 100), 3);
  const name = ETF_BY_CODE.get(code)?.name || code;
  const typeLabel = alertType === 'premium-below' ? '溢价率低于预警' : '溢价预警';
  const createdAt = shanghaiIso(day, minutes);
  const ruleId = alertType === 'premium-below' ? `market-alert:${code}:premium-below:demo` : `market-alert:preset:premium:${code}`;
  return baseEvent(`market-alert:${code}:${createdAt}`, createdAt, {
    ruleId,
    eventType: 'market-alert',
    title: `${code} ${name} ${typeLabel}`,
    body: `${code} 溢价率 ${premium.toFixed(2)}%，已${alertType === 'premium-below' ? '低于' : '超过'}设定阈值 ${threshold.toFixed(1)}%。当前价 ¥${price.toFixed(3)} → 点此查看行情详情。`,
    body_md: [`**${code} ${typeLabel}**`, '', `- 基金：${name}`, `- 当前价：**¥${price.toFixed(3)}**`, `- 溢价率 ${premium.toFixed(2)}%（阈值 ${threshold.toFixed(1)}%）`].join('\n'),
    summary: `${code} ${name} ${typeLabel}`,
    symbol: code,
    detailUrl: `https://fast.freebacktrack.tech/markets?code=${code}&source=market-alert`,
  }, channelResults());
}

function holdingsDailyEvent(day) {
  const contributors = HOLDINGS_DIGEST_EXCHANGE.map(({ code }) => ({ code, ratio: round(jitter(`ret:${day}:${code}`) * 1.6 + 0.2, 2) }))
    .sort((a, b) => Math.abs(b.ratio) - Math.abs(a.ratio));
  const total = round(HOLDINGS_DIGEST_EXCHANGE.reduce((sum, item) => sum + item.weight * (contributors.find((c) => c.code === item.code)?.ratio || 0), 0) / HOLDINGS_DIGEST_EXCHANGE.reduce((sum, item) => sum + item.weight, 0), 2);
  const dateLabel = day.slice(2);
  const top = contributors.slice(0, 3).map((item) => `${item.code} ${signedPct(item.ratio)}`);
  return baseEvent(`holdings-all-${day}`, shanghaiIso(day, 15 * 60 + 35), {
    ruleId: 'holdings-daily-all',
    eventType: 'holdings-daily-return',
    title: `[持仓总览] ${dateLabel} 当日收益 ${signedPct(total)}`,
    body: `今日加权收益率 ${signedPct(total)}；贡献 Top：${top.join('、')} → 点击查看明细。`,
    body_md: [`**当日加权收益率 ${signedPct(total)}**`, '', '贡献 Top：', ...contributors.slice(0, 3).map((item) => `- ${item.code} **${signedPct(item.ratio)}**`), '', '点击查看明细。'].join('\n'),
    summary: `当日加权收益率 ${signedPct(total)}`,
    symbol: '持仓总览',
    strategyName: '持仓当日收益',
    triggerCondition: `${day} all`,
    reason: 'holdings-daily',
  }, channelResults());
}

const HOLDINGS_DIGEST_EXCHANGE = Object.freeze([
  { code: '513100', weight: 0.4, kind: 'exchange' },
  { code: '159941', weight: 0.25, kind: 'exchange' },
  { code: '159513', weight: 0.15, kind: 'exchange' },
]);
const HOLDINGS_DIGEST_OTC = Object.freeze([{ code: '270042', weight: 0.2, kind: 'qdii' }]);

/** 最近推送记录（由新到旧，最多 30 条；不含 now 之后的事件）。 */
export function buildNotifyDemoEvents(now = Date.now()) {
  const [d0, d1, d2, d3] = recentTradingDays(now, 4);
  const events = [
    holdingsDailyEvent(d0),
    switchEvent(d0, 14 * 60 + 12, '159513'),
    premiumAlertEvent(d0, 10 * 60 + 41, '513100', 'premium', PREMIUM_ALERT_THRESHOLD),
    holdingsDailyEvent(d1),
    switchEvent(d1, 13 * 60 + 26, '513110', { serverChan3Failed: true }),
    premiumAlertEvent(d2, 9 * 60 + 52, '159513', 'premium-below', 9.5),
    holdingsDailyEvent(d2),
    premiumAlertEvent(d3, 11 * 60 + 3, '159941', 'premium', PREMIUM_ALERT_THRESHOLD),
    holdingsDailyEvent(d3),
  ];
  return events.filter((event) => Date.parse(event.createdAt) <= now)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** GET /api/notify/status?view=summary（cn-data handleStatusSummary 结构）。 */
export function buildNotifyDemoStatusSummary(events, now = Date.now()) {
  const [, d1, d2] = recentTradingDays(now, 3);
  return {
    ok: true,
    schemaVersion: 1,
    data: {
      account: {
        clientId: NOTIFY_DEMO_CLIENT_ID,
        accountClientId: NOTIFY_DEMO_CLIENT_ID,
        username: NOTIFY_DEMO_USERNAME,
        label: NOTIFY_DEMO_LABEL,
        notifyGroupId: NOTIFY_DEMO_CLIENT_ID,
      },
      channels: {
        bark: { deviceKey: NOTIFY_DEMO_BARK_KEY, enabled: true, configured: true },
        serverChan3: { uid: NOTIFY_DEMO_SERVERCHAN3.uid, sendKeyMasked: NOTIFY_DEMO_SERVERCHAN3.sendKeyMasked, configured: true, enabled: true },
        email: { maskedAddress: NOTIFY_DEMO_EMAIL, verified: true, verifiedAt: shanghaiIso(d2, 21 * 60 + 2), enabled: true, configured: true },
        webWs: { configured: false },
      },
      rules: { planRuleCount: 0, dcaRuleCount: 0, totalRuleCount: 0 },
      timestamps: {
        lastSyncedAt: shanghaiIso(d1, 20 * 60 + 31),
        lastCheckedAt: switchDemoComputedAt(now),
        lastTestedAt: shanghaiIso(d2, 21 * 60 + 5),
      },
      delivery: { eventCount: events.length, failureCount: 0 },
      webSockets: {
        groupId: NOTIFY_DEMO_CLIENT_ID,
        groupMemberCount: 0,
        registrationCount: 0,
        currentClientId: NOTIFY_DEMO_CLIENT_ID,
        currentClientRegistrationCount: 0,
        pairedRegistrationCount: 0,
        unpairedRegistrationCount: 0,
      },
    },
  };
}

/** GET /api/notify/status?view=details（cn-data handleStatusDetails 结构）。 */
export function buildNotifyDemoStatusDetails(events) {
  return {
    ok: true,
    schemaVersion: 1,
    data: {
      account: { clientId: NOTIFY_DEMO_CLIENT_ID, accountClientId: NOTIFY_DEMO_CLIENT_ID },
      delivery: { eventCount: events.length, lastEvent: events[0] || null, failureCount: 0, failures: [] },
      webSockets: { groupMemberClientIds: [], registrations: [], currentClientRegistrations: [] },
    },
  };
}

/** GET /api/notify/holdings-rule（holdingsRuleResponse 结构；digest 只含代码 + 权重）。 */
export function buildNotifyDemoHoldingsRule(now = Date.now()) {
  const [, d1] = recentTradingDays(now, 2);
  const at = shanghaiIso(d1, 20 * 60 + 31);
  return {
    enabled: true,
    digest: { version: 1, generatedAt: at, exchange: HOLDINGS_DIGEST_EXCHANGE.map((item) => ({ ...item })), otc: HOLDINGS_DIGEST_OTC.map((item) => ({ ...item })) },
    updatedAt: at,
  };
}

/** 示例本地预警规则：溢价预设展开的两条 + 一条手工「溢价率低于」。 */
export function buildNotifyDemoMarketAlerts(now = Date.now()) {
  const [, , d2] = recentTradingDays(now, 3);
  const at = shanghaiIso(getPreviousTradingDayShanghai(d2), 20 * 60);
  const preset = (code) => ({
    id: `market-alert:preset:premium:${code}`, type: 'market-alert', presetId: 'premium', symbol: code, name: ETF_BY_CODE.get(code).name,
    alertType: 'premium', threshold: PREMIUM_ALERT_THRESHOLD, enabled: true, createdAt: at, updatedAt: at,
  });
  return [
    preset('513100'),
    preset('159941'),
    {
      id: 'market-alert:159513:premium-below:demo', type: 'market-alert', symbol: '159513', name: ETF_BY_CODE.get('159513').name,
      alertType: 'premium-below', threshold: 9.5, enabled: true, createdAt: at, updatedAt: at,
    },
  ];
}

// 新手入门「看看怎么接通手机通知」进入的演示（window.__AI_DCA_DEMO_VARIANT__ = 'notify-setup'）：
// 渠道从空开始，保存渠道 / 发送测试走下面的内存 mock，只改本次演示的状态，不会真的发送。
export const NOTIFY_SETUP_VARIANT = 'notify-setup';
const ACCOUNT_NOTIFY_ITEMS_PATH = '/api/account/v1/notify/client-config/items/';
function isSetupVariant() {
  return typeof globalThis !== 'undefined' && globalThis.__AI_DCA_DEMO_VARIANT__ === NOTIFY_SETUP_VARIANT;
}
function parseJsonBody(body) {
  try { return JSON.parse(body || '{}') || {}; } catch { return {}; }
}
function maskKey(key) {
  const text = String(key || '');
  return text.length > 10 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text ? `${text.slice(0, 2)}...` : '';
}

/** notify-setup 变体：可变的渠道状态 + 保存 / 测试 / 账号资源接口 mock。 */
export function createNotifySetupFixtures(events, startedAt = Date.now()) {
  const channels = { barkDeviceKey: '', serverChan3: { uid: '', sendKey: '' } };
  const summary = () => {
    const base = buildNotifyDemoStatusSummary(events, startedAt);
    const sc = channels.serverChan3;
    base.data.channels = {
      bark: { deviceKey: channels.barkDeviceKey, enabled: Boolean(channels.barkDeviceKey), configured: Boolean(channels.barkDeviceKey) },
      serverChan3: { uid: sc.uid, sendKeyMasked: maskKey(sc.sendKey), configured: Boolean(sc.uid), enabled: Boolean(sc.uid) },
      email: { maskedAddress: '', verified: false, verifiedAt: '', enabled: false, configured: false },
      webWs: { configured: false },
    };
    return base;
  };
  const applyItem = (itemId, item = {}) => {
    if (itemId === 'channel:bark') channels.barkDeviceKey = String(item.barkDeviceKey || '').trim();
    if (itemId === 'channel:serverchan3') channels.serverChan3 = { uid: String(item.serverChan3Uid || '').trim(), sendKey: String(item.serverChan3SendKey || '').trim() };
  };
  const itemIdOf = (url) => decodeURIComponent(url.pathname.slice(ACCOUNT_NOTIFY_ITEMS_PATH.length));
  return {
    [`GET ${NOTIFY_STATUS_PATH}`]: ({ url }) => (url.searchParams.get('view') === 'details' ? buildNotifyDemoStatusDetails(events) : summary()),
    'GET /api/account/v1/migrations/legacy': () => ({ ok: true, status: 'no-legacy', legacy: { exists: false } }),
    'GET /api/account/v1/notify/client-config': () => ({
      ok: true,
      data: { barkDeviceKey: channels.barkDeviceKey, serverChan3Uid: channels.serverChan3.uid, serverChan3SendKey: channels.serverChan3.sendKey },
    }),
    [`PUT ${ACCOUNT_NOTIFY_ITEMS_PATH}*`]: ({ url, body }) => {
      applyItem(itemIdOf(url), parseJsonBody(body).item || {});
      return { ok: true };
    },
    [`DELETE ${ACCOUNT_NOTIFY_ITEMS_PATH}*`]: ({ url }) => {
      applyItem(itemIdOf(url), {});
      return { ok: true };
    },
    'POST /api/notify/test': ({ body }) => {
      const input = parseJsonBody(body);
      const channel = String(input.targetChannel || 'bark');
      // 演示里「发送测试」成功即视为接通（真实页面测试成功后也会把渠道记成已配置）。
      if (channel === 'serverchan3' && input.serverChan3?.uid) applyItem('channel:serverchan3', { serverChan3Uid: input.serverChan3.uid, serverChan3SendKey: input.serverChan3.sendKey || channels.serverChan3.sendKey });
      if (channel === 'bark' && input.barkDeviceKey) applyItem('channel:bark', { barkDeviceKey: input.barkDeviceKey });
      return {
        ok: true,
        summary: {
          deliveredCount: 1,
          events: [{ status: 'delivered', channels: [{ channel, status: 'delivered', detail: '演示：已模拟发送，不会真的推送' }] }],
        },
      };
    },
  };
}

export default {
  keepKeys: [],
  // 首屏读本地缓存时就显示演示账号的渠道、规则与预设（不闪出账号里原有的缓存）。
  seed() {
    const setup = isSetupVariant();
    return [
      [NOTIFY_CLIENT_CONFIG_KEY, JSON.stringify({
        barkDeviceKey: setup ? '' : NOTIFY_DEMO_BARK_KEY,
        serverChan3Uid: setup ? '' : NOTIFY_DEMO_SERVERCHAN3.uid,
        serverChan3SendKey: '',
        notifyClientId: 'web:demo-console',
        notifyClientLabel: 'Web 控制台 · 演示',
        notifyClientSecret: 'demo-client-secret',
      })],
      [NOTIFY_MARKET_ALERTS_KEY, JSON.stringify(buildNotifyDemoMarketAlerts())],
      [NOTIFY_HOLDING_ALERTS_KEY, '[]'],
      [NOTIFY_PRESETS_KEY, JSON.stringify({ daily: { enabled: true }, premium: { enabled: true, threshold: PREMIUM_ALERT_THRESHOLD } })],
      [SWITCH_CONFIG_CACHE_KEY, JSON.stringify(buildSwitchDemoConfig())],
      ...tradePlansDemoSeed(),
    ];
  },
  createFixtures() {
    const startedAt = Date.now();
    const events = buildNotifyDemoEvents(startedAt);
    return {
      routes: {
        [`GET ${NOTIFY_STATUS_PATH}`]: ({ url }) => (url.searchParams.get('view') === 'details'
          ? buildNotifyDemoStatusDetails(events)
          : buildNotifyDemoStatusSummary(events, startedAt)),
        [`GET ${NOTIFY_EVENTS_PATH}`]: () => ({ events: events.map((event) => ({ ...event, channels: event.channels.map((item) => ({ ...item })) })) }),
        [`GET ${NOTIFY_HOLDINGS_RULE_PATH}`]: () => buildNotifyDemoHoldingsRule(startedAt),
        [`GET ${SWITCH_CONFIG_PATH}`]: () => ({ ok: true, clientId: SWITCH_DEMO_CLIENT_ID, config: buildSwitchDemoConfig() }),
        ...(isSetupVariant() ? createNotifySetupFixtures(events, startedAt) : {}),
      },
    };
  },
};
