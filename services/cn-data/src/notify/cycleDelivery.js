import { normalizeBarkDeviceKey, sendBarkNotification } from './barkChannel.js';
import { sendServerChan3Notification } from './serverChan3Channel.js';
import { loadTestDeliverySettings } from './testDelivery.js';
const RESEND_FROM = 'notify@freebacktrack.tech'; // mirrors worker's DEFAULT_FROM

function text(value = '', max = 5000) { return String(value ?? '').trim().slice(0, max); }
export function normalizeTestTarget(value = '') {
  const target = text(value, 32).toLowerCase();
  if (target === 'ios') return 'bark';
  if (['android', 'andriod', 'serverchan'].includes(target)) return 'serverchan3';
  if (target === 'ws') return 'pc';
  return ['bark', 'serverchan3', 'email', 'pc'].includes(target) ? target : '';
}

function channelsOfTest(targetChannels) {
  const input = targetChannels ? (Array.isArray(targetChannels) ? targetChannels : [targetChannels]) : ['bark', 'serverchan3', 'email', 'pc'];
  return Array.from(new Set(input.map(normalizeTestTarget).filter(Boolean)));
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

function normalizeBarkConfig(value = {}) {
  const input = typeof value === 'string' ? { deviceKey: value } : value || {};
  const deviceKey = normalizeBarkDeviceKey(input.deviceKey ?? input.barkDeviceKey ?? '');
  return { deviceKey, enabled: Boolean(deviceKey && input.enabled !== false) };
}

function normalizeServerChan3Config(value = {}) {
  const input = value || {};
  const uid = String(input.uid || '').trim();
  const sendKey = String(input.sendKey || '').trim();
  return { uid, sendKey, enabled: Boolean(uid && sendKey && input.enabled !== false) };
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
      const config = normalizeBarkConfig(settings.bark ?? settings.barkDeviceKey);
      if (!config.deviceKey) return { channel, status: 'skipped', detail: '未配置 Bark' };
      if (!config.enabled) return { channel, status: 'skipped', detail: 'Bark 通知已关闭' };
      return await sendBarkNotification({
        ...notification,
        url: notification.url || notification.detailUrl || '',
        deviceKey: config.deviceKey
      });
    }
    if (channel === 'serverchan3') {
      const config = normalizeServerChan3Config(settings.serverChan3);
      if (!(config.uid && config.sendKey)) return { channel, status: 'skipped', detail: '未配置 Server酱' };
      if (!config.enabled) return { channel, status: 'skipped', detail: 'Server酱通知已关闭' };
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

export function saveNotifyEvent(db, account, event) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO notify_user_records (owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
    VALUES (?, 'event', ?, ?, 1, ?, ?)
    ON CONFLICT(owner_user_id, record_type, record_id) DO UPDATE SET payload=excluded.payload, revision=notify_user_records.revision+1, updated_at=excluded.updated_at`)
    .run(account.userId, `${account.clientId}::${event.id}`, JSON.stringify({
      clientId: account.clientId, createdAt: event.createdAt, value: event
    }), now, now);
}


export async function deliverCycleNotification(db, account, notification, {targetChannels = null} = {}) {
  const settings = loadTestDeliverySettings(db, account);
  const results = [];
  for (const channel of channelsOfTest(targetChannels)) {
    const result = await deliverTestChannel(notification, channel, settings);
    results.push({...result, configKey: `${channel}-client:${account.clientId}`, configType: `${channel}-client`, configId: account.clientId});
  }
  const status = results.some(r => r.status === 'delivered' || r.status === 'queued') ? 'delivered' : results.some(r => r.status !== 'skipped') ? 'failed' : 'skipped';
  return {status, results};
}
