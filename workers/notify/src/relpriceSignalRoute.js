/* global crypto, Response, TextEncoder */
import { deliverAccountNotification } from './accountDeliveryRoute.js';

const RELPRICE_OWNER = 'usr_ad2be81697b5eec7ca3b2204efb7270c';
const RELPRICE_CODES = new Set(['513100', '513110', '513300', '513390', '513870', '159501', '159513', '159632', '159659', '159660', '159696', '159941']);
// Same 2026 calendar as market_collector/calendar_cn.py. Unknown years close.
const RELPRICE_HOLIDAYS = [['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'], ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'], ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'], ['2026-10-01', '2026-10-07']];
const relpriceEncoder = new TextEncoder();

async function relpriceAuthorized(request, env) {
  const expected = String(env.INTERNAL_SYNC_TOKEN || '');
  if (!expected) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  const [a, b] = await Promise.all([given, expected].map(value => crypto.subtle.digest('SHA-256', relpriceEncoder.encode(value))));
  const left = new Uint8Array(a); const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function validateRelpriceSignal(payload, now = new Date()) {
  if (!payload || payload.owner_user_id !== RELPRICE_OWNER) return 'invalid_owner';
  const local = new Date(now.getTime() + 8 * 3600000).toISOString();
  const date = local.slice(0, 10); const hm = local.slice(11, 16).replace(':', '');
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (!date.startsWith('2026-') || weekday === 0 || weekday === 6 || RELPRICE_HOLIDAYS.some(([start, end]) => start <= date && date <= end) || payload.date !== date || hm < '1441' || hm > '1501') return 'outside_live_window';
  if (payload.decision !== 'rotate' || !RELPRICE_CODES.has(payload.holding) || !RELPRICE_CODES.has(payload.target) || payload.holding === payload.target) return 'invalid_rotation';
  if (!Number.isFinite(payload.gap_bp) || payload.gap_bp < 60 - 1e-10) return 'below_threshold';
  if (payload.signal_ts !== `${date}T14:40:00+08:00` || payload.event_id !== `relprice:B_REL:${date}` || !/^[a-f0-9]{64}$/.test(payload.input_sha256 || '')) return 'invalid_signal_identity';
  const execution = payload.execution_reference || {};
  if (!/^\d{4}$/.test(execution.time || '') || execution.time < '1441' || execution.time > '1500' || execution.time > hm || !Number.isFinite(execution.sell_close) || execution.sell_close <= 0 || !Number.isFinite(execution.buy_close) || execution.buy_close <= 0) return 'invalid_execution_reference';
  const generated = Date.parse(payload.generated_at || '');
  if (!Number.isFinite(generated) || now.getTime() - generated > 45000 || generated - now.getTime() > 2000) return 'stale_signal';
  return '';
}

export async function handleRelpriceSignal(request, env, { deliver = deliverAccountNotification, now = () => new Date() } = {}) {
  if (request.method !== 'POST') return Response.json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  if (!await relpriceAuthorized(request, env)) return Response.json({ ok: false, code: 'UNAUTHORIZED' }, { status: 401 });
  let payload;
  try {
    const text = await request.text();
    if (text.length > 8192) throw new Error('oversize');
    payload = JSON.parse(text);
  } catch { return Response.json({ ok: false, code: 'INVALID_JSON' }, { status: 400 }); }
  if (payload?.owner_user_id !== RELPRICE_OWNER) return Response.json({ ok: false, code: 'INVALID_OWNER' }, { status: 403 });
  if (payload.dry_run === true && /^relprice:B_REL:\d{4}-\d{2}-\d{2}$/.test(payload.verify_event_id || '')) {
    const attempt = await env.SYNC_DB.prepare("SELECT owner_user_id,event_id,channel,status,updated_at FROM notify_delivery_attempts WHERE owner_user_id=? AND event_id=? AND channel='email'").bind(RELPRICE_OWNER, payload.verify_event_id).first();
    return Response.json({ ok: true, dry_run: true, delivery_attempt: attempt || null });
  }
  // This path never creates an event, reserves quota, or attempts delivery.
  if (payload.dry_run === true) {
    const recordId = `account:${RELPRICE_OWNER}::email`;
    const row = await env.SYNC_DB.prepare("SELECT json_extract(payload, '$.email.verified') AS verified, json_extract(payload, '$.email.enabled') AS enabled FROM notify_user_records WHERE owner_user_id=? AND record_type='client-channel' AND record_id=?").bind(RELPRICE_OWNER, recordId).first();
    const ready = Boolean(row?.verified && row?.enabled);
    return Response.json({ ok: ready, dry_run: true, owner_user_id: RELPRICE_OWNER, channel: 'email', ready }, { status: ready ? 200 : 409 });
  }
  const error = validateRelpriceSignal(payload, now());
  if (error) return Response.json({ ok: false, code: error }, { status: 400 });
  const message = {
    eventId: payload.event_id, eventType: 'relprice-signal', ruleId: 'relprice:B_REL',
    strategyName: 'relprice B_REL', symbol: payload.target,
    title: `relprice 14:40 换仓信号：${payload.holding} → ${payload.target}`,
    summary: `${payload.holding} → ${payload.target}，差值 ${payload.gap_bp.toFixed(2)}bp`,
    body: [
      `${payload.date} 14:40 B_REL 信号：换到 ${payload.target}（参考持仓 ${payload.holding}）。`,
      `30 日相对对数价格分数差 ${payload.gap_bp.toFixed(4)}bp，阈值 60bp。`,
      `最早 14:41；首个共同正量 bar ${payload.execution_reference.time.slice(0, 2)}:${payload.execution_reference.time.slice(2)}，参考 close ${payload.execution_reference.sell_close} / ${payload.execution_reference.buy_close}。`,
      '仅信号提醒，不自动交易。持仓为策略参考状态；实际持仓不符时请先纠正。'
    ].join('\n'),
    params: { strategy: 'B_REL', holding: payload.holding, target: payload.target, gap_bp: payload.gap_bp, input_sha256: payload.input_sha256 }
  };
  try {
    const result = await deliver(env, { userId: RELPRICE_OWNER, username: 'lovexl', clientId: `account:${RELPRICE_OWNER}` }, message, ['email'], 'relprice-signal');
    const channels = result?.events?.[0]?.channels || [];
    const email = channels.find(item => item.channel === 'email');
    // Provider detail and addresses stay inside the established delivery logs.
    const attempt = await env.SYNC_DB.prepare("SELECT owner_user_id,event_id,channel,status,updated_at FROM notify_delivery_attempts WHERE owner_user_id=? AND event_id=? AND channel='email'").bind(RELPRICE_OWNER, payload.event_id).first();
    const delivered = email?.status === 'delivered' && attempt?.status === 'delivered';
    return Response.json({ ok: delivered, event_id: payload.event_id, channel: 'email', status: attempt?.status || email?.status || 'failed', delivery_attempt: attempt || null, verification: 'notify_delivery_attempts' }, { status: delivered ? 200 : 503 });
  } catch {
    return Response.json({ ok: false, code: 'DELIVERY_FAILED', event_id: payload.event_id }, { status: 503 });
  }
}
