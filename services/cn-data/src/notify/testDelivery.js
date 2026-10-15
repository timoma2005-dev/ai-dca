// Test notification delivery for cn-data
// Ported from workers/notify/src/accountDeliveryRoute.js (handleDirectAccountTest,
// deliverAccountNotification, loadAccountDeliverySettings) to synchronous node:sqlite.
// Email channel goes through Resend (workers/notify/src/channels/emailProviders.js:
// sendViaResend), token read from process.env.RESEND_TOKEN (supervisor env on cn host).

import { sendBarkNotification } from './barkChannel.js';
import { sendServerChan3Notification } from './serverChan3Channel.js';

const RESEND_FROM = 'notify@freebacktrack.tech'; // mirrors worker's DEFAULT_FROM

function text(value = '', max = 5000) { return String(value ?? '').trim().slice(0, max); }
function parse(value, fallback = {}) {
  try {
    const data = JSON.parse(String(value || ''));
    return data && typeof data === 'object' ? data : fallback;
  } catch { return fallback; }
}

export function normalizeTestTarget(value = '') {
  const target = text(value, 32).toLowerCase();
  if (target === 'ios') return 'bark';
  if (['android', 'andriod', 'serverchan'].includes(target)) return 'serverchan3';
  if (target === 'ws') return 'pc';
  return ['bark', 'serverchan3', 'email', 'pc'].includes(target) ? target : '';
}

export function notificationFromTestPayload(payload = {}) {
  return {
    eventId: text(payload.eventId, 240) || `notify-test-${Date.now()}`,
    eventType: text(payload.eventType, 80) || 'test',
    title: text(payload.title, 240) || '交易计划测试提醒',
    body: text(payload.body, 12000) || '这是一条测试通知，用来校验当前已接入的提醒通道是否可用。',
    body_md: text(payload.body_md || payload.bodyMd, 30000),
    summary: text(payload.summary, 1000) || '测试通知',
    ruleId: text(payload.ruleId, 240) || 'test',
    symbol: text(payload.symbol, 80),
    strategyName: text(payload.strategyName, 160),
    triggerCondition: text(payload.triggerCondition, 500),
    detailUrl: text(payload.detailUrl || payload.url, 1000),
    url: text(payload.url || payload.detailUrl, 1000)
  };
}

function channelsOfTest(targetChannels) {
  const input = targetChannels ? (Array.isArray(targetChannels) ? targetChannels : [targetChannels]) : ['bark', 'serverchan3', 'email', 'pc'];
  return Array.from(new Set(input.map(normalizeTestTarget).filter(Boolean)));
}

// Mirrors loadAccountDeliverySettings: reads client-channel records from
// notify_user_records and merges notify/client-config resource settings.
export function loadTestDeliverySettings(db, account) {
  const ids = [`${account.clientId}::bark`, `${account.clientId}::serverchan3`, `${account.clientId}::email`];
  const channelRows = db.prepare(`SELECT record_id, payload FROM notify_user_records
    WHERE owner_user_id = ? AND record_type = 'client-channel' AND record_id IN (?, ?, ?)`)
    .all(account.userId, ...ids);
  const resourceRows = db.prepare(`SELECT record_id, payload, deleted FROM account_resource_records
    WHERE user_id = ? AND resource = 'notify/client-config' ORDER BY position ASC, record_id ASC`)
    .all(account.userId);

  const settings = { barkDeviceKey: '', serverChan3: {}, email: {} };
  for (const row of channelRows) {
    const value = parse(row.payload);
    if (String(row.record_id).endsWith('::bark')) settings.barkDeviceKey = text(value.barkDeviceKey, 512);
    else if (String(row.record_id).endsWith('::serverchan3')) settings.serverChan3 = value.serverChan3 || {};
    else if (String(row.record_id).endsWith('::email')) settings.email = value.email || {};
  }
  // Resource settings take priority (same as worker's mergeAccountResourceNotifySettings)
  for (const row of resourceRows) {
    if (Number(row.deleted || 0) === 1) continue;
    const value = parse(row.payload);
    const id = String(row.record_id || '');
    if (id === 'channel:bark' && value.barkDeviceKey) settings.barkDeviceKey = text(value.barkDeviceKey, 512);
    else if (id === 'channel:serverchan3') {
      const uid = text(value.serverChan3Uid || value.serverChan3?.uid, 240);
      const sendKey = text(value.serverChan3SendKey || value.serverChan3?.sendKey, 512);
      if (uid || sendKey) settings.serverChan3 = { uid, sendKey };
    } else if (id === 'channel:email' && value.email) settings.email = value.email;
  }
  return settings;
}

// Ported from workers/notify/src/channels/emailProviders.js: sendViaResend.
// payload: { fromEmail, to, subject, text, html }
async function sendViaResend(payload) {
  const token = String(process.env.RESEND_TOKEN || '').trim();
  if (!token) throw new Error('cn 主机未配置 RESEND_TOKEN');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: payload.fromEmail,
      to: [payload.to],
      subject: payload.subject,
      ...(payload.html ? { html: payload.html } : {}),
      ...(payload.text ? { text: payload.text } : {})
    })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`resend error ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => ({}));
  return { messageId: data?.id ? String(data.id) : '', provider: 'resend' };
}

function normalizeEmailConfig(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const address = String(input.address || '').trim();
  const verified = Boolean(address && input.verified);
  return {
    address,
    verified,
    enabled: Boolean(verified && input.enabled)
  };
}

async function deliverTestEmail(notification, settings) {
  const config = normalizeEmailConfig(settings.email);
  if (!config.address || !config.verified) {
    return { channel: 'email', status: 'skipped', detail: '未配置收件邮箱' };
  }
  if (!config.enabled) {
    return { channel: 'email', status: 'skipped', detail: '邮箱通知已关闭' };
  }
  const token = String(process.env.RESEND_TOKEN || '').trim();
  if (!token) {
    return { channel: 'email', status: 'skipped', detail: 'cn 主机未配置 RESEND_TOKEN' };
  }
  const { messageId } = await sendViaResend({
    fromEmail: RESEND_FROM,
    to: config.address,
    subject: notification.title,
    text: notification.body
  });
  return { channel: 'email', status: 'delivered', detail: `via resend ${messageId}` };
}

async function deliverTestChannel(notification, channel, settings) {
  try {
    if (channel === 'bark') {
      return await sendBarkNotification({
        ...notification,
        url: notification.url || notification.detailUrl || '',
        deviceKey: text(settings.barkDeviceKey, 512)
      });
    }
    if (channel === 'serverchan3') {
      const config = settings.serverChan3 || {};
      return await sendServerChan3Notification({
        ...notification,
        uid: text(config.uid, 240),
        sendKey: text(config.sendKey, 512)
      });
    }
    if (channel === 'email') {
      return await deliverTestEmail(notification, settings);
    }
    if (channel === 'pc') {
      return { channel: 'pc', status: 'queued', detail: '已写入事件，等待 PC 浏览器拉取' };
    }
    return { channel, status: 'skipped', detail: `未知通道 ${channel}` };
  } catch (error) {
    return { channel, status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

function saveTestEvent(db, account, event) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO notify_user_records (owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
    VALUES (?, 'event', ?, ?, 1, ?, ?)
    ON CONFLICT(owner_user_id, record_type, record_id) DO UPDATE SET payload=excluded.payload, revision=notify_user_records.revision+1, updated_at=excluded.updated_at`)
    .run(account.userId, `${account.clientId}::${event.id}`, JSON.stringify({
      clientId: account.clientId, createdAt: event.createdAt, value: event
    }), now, now);
}

export async function deliverNotification(db, account, notification, { targetChannels = null, reason = 'manual-test' } = {}) {
  const settings = loadTestDeliverySettings(db, account);
  const channels = channelsOfTest(targetChannels);
  const results = [];
  for (const channel of channels) {
    results.push(await deliverTestChannel(notification, channel, settings));
  }
  const delivered = results.some((item) => item.status === 'delivered' || item.status === 'queued');
  const status = delivered ? 'delivered' : results.some((item) => item.status !== 'skipped') ? 'failed' : 'skipped';
  const createdAt = new Date().toISOString();
  const event = {
    id: notification.eventId,
    eventId: notification.eventId,
    messageId: notification.eventId,
    ruleId: notification.ruleId,
    eventType: notification.eventType,
    title: notification.title,
    body: notification.body,
    body_md: notification.body_md || '',
    summary: notification.summary,
    symbol: notification.symbol || '',
    strategyName: notification.strategyName || '',
    triggerCondition: notification.triggerCondition || '',
    detailUrl: notification.detailUrl || notification.url || '',
    status,
    channels: results,
    createdAt,
    reason
  };
  saveTestEvent(db, account, event);
  return {
    deliveredCount: results.filter((item) => item.status === 'delivered' || item.status === 'queued').length,
    events: [event],
    clientId: account.clientId
  };
}

export async function deliverTestNotification(db, account, notification, targetChannels = null) {
  return deliverNotification(db, account, notification, { targetChannels, reason: 'manual-test' });
}
