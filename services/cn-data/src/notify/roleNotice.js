// 角色开通站内信：auth 服务授予 VIP / SVIP 后调用 POST /internal/role-notice（仅本机回环，nginx 不转发 /internal）。
// 已配置 Bark / Server酱 / 邮箱的用户同时推送；未配置的只写入事件，出现在网站右上角「通知记录」里。
import { deliverNotification } from './testDelivery.js';

export const ROLE_NOTICE_PATH = '/internal/role-notice';
const SITE = 'https://fast.freebacktrack.tech/home.html';
const ROLE_LABEL = { vip: 'VIP', svip: 'SVIP' };
const VIP_FEATURES = [
  '行情中心：纳指 / 标普 QDII 实时溢价与偏离',
  '基金切换：高溢价换低溢价的切换提醒',
  '份额新增：每日场内份额与申购额度变化',
  '通知管理：Server酱（微信）/ Bark / 邮件提醒'
];
const SVIP_FEATURES = [
  '竞价看板：9:30 竞价、盘中轮动与隔夜轮动',
  '雷达：纳指雷达评分与纸面记录',
  '份额历史：份额 / 额度 / 溢价历史'
];

function text(value = '', max = 200) { return String(value ?? '').trim().slice(0, max); }

export function formatExpiry(expiresAt = '') {
  const ms = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(ms)) return '长期有效';
  const d = new Date(ms + 8 * 3600 * 1000);
  return `有效期至 ${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

export function buildRoleNotice({ userId = '', username = '', role = '', expiresAt = null, noticeId = '' } = {}) {
  const code = text(role, 16).toLowerCase();
  const label = ROLE_LABEL[code];
  if (!label || !text(userId, 96)) return null;
  const svip = code === 'svip';
  const features = svip ? [...SVIP_FEATURES, ...VIP_FEATURES] : VIP_FEATURES;
  const url = `${SITE}?tab=${svip ? 'adminAuction' : 'notify'}`;
  const expiry = formatExpiry(expiresAt);
  const who = text(username, 48);
  const lines = [
    `${who ? `${who}，` : ''}你的账号已开通 ${label}，${expiry}。`,
    '',
    '现在可以使用：',
    ...features.map((f) => `· ${f}`),
    '',
    svip ? '建议先打开「竞价看板」，再到「通知管理」配置提醒渠道。' : '建议先到「通知管理」配置一个提醒渠道，溢价到低位时第一时间提醒你。',
    url
  ];
  const suffix = text(noticeId, 64) || text(expiresAt, 40) || 'permanent';
  return {
    eventId: `role-notice-${code}-${text(userId, 96)}-${suffix}`.replace(/[^a-zA-Z0-9:_.-]+/g, '-'),
    eventType: 'account-notice',
    ruleId: `role-notice-${code}`,
    title: `🎉 ${label} 已开通`,
    summary: `${label} 已开通，${expiry}`,
    body: lines.join('\n'),
    body_md: lines.map((l) => (l ? `${l}  ` : '')).join('\n'),
    symbol: '',
    strategyName: '账号消息',
    triggerCondition: `${label} 开通`,
    detailUrl: url,
    url
  };
}

function isLoopback(req) {
  const addr = String(req?.socket?.remoteAddress || '');
  if (req?.headers?.['x-forwarded-for'] || req?.headers?.['x-real-ip']) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export async function handleRoleNoticeRoute(db, req, body = {}) {
  if (!isLoopback(req)) return { status: 404, body: { message: 'Not found' } };
  const notification = buildRoleNotice(body);
  if (!notification) return { status: 400, body: { message: 'role must be vip/svip and userId required' } };
  const userId = text(body.userId, 96);
  const account = { userId, username: text(body.username, 48), clientId: `account:${userId}` };
  const exists = db.prepare(`SELECT 1 FROM notify_user_records WHERE owner_user_id = ? AND record_type = 'event' AND record_id = ?`)
    .get(userId, `${account.clientId}::${notification.eventId}`);
  if (exists) return { status: 200, body: { ok: true, skipped: 'duplicate', eventId: notification.eventId } };
  const channels = body.inboxOnly ? ['pc'] : null;
  const result = await deliverNotification(db, account, notification, { targetChannels: channels, reason: 'role-notice' });
  const event = result.events[0] || {};
  return { status: 200, body: { ok: true, eventId: notification.eventId, status: event.status, channels: (event.channels || []).map((c) => ({ channel: c.channel, status: c.status })) } };
}
