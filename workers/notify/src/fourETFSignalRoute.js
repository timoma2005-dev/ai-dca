/* global crypto, Response, TextDecoder, TextEncoder */
import { deliverAccountNotification } from './accountDeliveryRoute.js';

const OWNER = 'usr_ad2be81697b5eec7ca3b2204efb7270c';
const CODES = ['513100', '159696', '159501', '159941'];
const HOLIDAYS = {
  '2025': [['01-01', '01-01'], ['01-28', '02-04'], ['04-04', '04-06'], ['05-01', '05-05'], ['05-31', '06-02'], ['10-01', '10-08']],
  '2026': [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']]
};
const encoder = new TextEncoder();
const positive = value => Number.isFinite(value) && value > 0;
const session = hm => /^\d{4}$/.test(hm) && (('0930' <= hm && hm <= '1130') || ('1300' <= hm && hm <= '1500')) && Number(hm.slice(2)) < 60;

function tradingDay(date) {
  const ranges = HOLIDAYS[date.slice(0, 4)];
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return Boolean(ranges && weekday > 0 && weekday < 6 && !ranges.some(([a, b]) => a <= date.slice(5) && date.slice(5) <= b));
}

function previousDay(date) {
  const day = new Date(`${date}T00:00:00Z`);
  for (let i = 0; i < 40; i += 1) {
    day.setUTCDate(day.getUTCDate() - 1);
    const text = day.toISOString().slice(0, 10);
    if (!HOLIDAYS[text.slice(0, 4)]) return '';
    if (tradingDay(text)) return text;
  }
  return '';
}

function nextMinute(hm) {
  if (hm === '1500' || !session(hm)) return '';
  if (hm === '1130') return '1301';
  const n = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(2)) + 1;
  return `${Math.floor(n / 60)}`.padStart(2, '0') + `${n % 60}`.padStart(2, '0');
}

async function authorized(request, env) {
  const expected = String(env.INTERNAL_SYNC_TOKEN || '');
  if (!expected) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  const [left, right] = await Promise.all([given, expected].map(v => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function validateFourETFSignal(payload, now = new Date()) {
  if (!payload || payload.owner_user_id !== OWNER) return 'invalid_owner';
  const local = new Date(now.getTime() + 8 * 3600000).toISOString();
  const date = local.slice(0, 10); const hm = local.slice(11, 16).replace(':', '');
  if (!tradingDay(date) || payload.date !== date || !session(hm)) return 'outside_live_window';
  if (payload.decision !== 'rotate' || !CODES.includes(payload.holding) || !CODES.includes(payload.target) || payload.holding === payload.target) return 'invalid_rotation';
  const signalHm = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):00\+08:00$/.exec(payload.signal_ts || '');
  const signal = signalHm ? signalHm[1] + signalHm[2] : '';
  if (!signal || !payload.signal_ts.startsWith(`${date}T`) || !nextMinute(signal) || payload.event_id !== `fourETF:${date}:${signal}` || !/^[a-f0-9]{64}$/.test(payload.input_sha256 || '')) return 'invalid_signal_identity';
  const execution = payload.execution_reference || {};
  if (execution.time !== nextMinute(signal) || execution.time !== hm || !positive(execution.sell_close) || !positive(execution.buy_close) || !positive(execution.sell_volume) || !positive(execution.buy_volume)) return 'invalid_execution_reference';
  const actualGap = payload.deviations_pp?.[payload.holding] - payload.deviations_pp?.[payload.target];
  if (!Number.isFinite(payload.gap_pp) || payload.gap_pp <= 0.5 + 1e-12 || !Number.isFinite(actualGap) || Math.abs(actualGap - payload.gap_pp) > 1e-9) return 'below_threshold_or_inconsistent_gap';
  if (!payload.eligible?.[payload.holding] || !payload.eligible?.[payload.target]
      || CODES.some(c => typeof payload.eligible?.[c] !== 'boolean'
        || (payload.eligible[c] && (!Number.isFinite(payload.deviations_pp?.[c]) || payload.deviations_pp[c] < payload.deviations_pp[payload.target] - 1e-12)))) return 'invalid_candidate_eligibility';
  const quarter = `${date.slice(0, 4)}-${String(1 + 3 * Math.floor((Number(date.slice(5, 7)) - 1) / 3)).padStart(2, '0')}-01`;
  const effective = date < '2027-01-01' ? '2026-11-07' : quarter;
  if (payload.normal_effective !== effective || CODES.some(c => !Number.isFinite(payload.normal_pp?.[c]))) return 'invalid_normal';
  const ready = Date.parse(payload.nav_ready_at || '');
  const open = Date.parse(`${date}T09:30:00+08:00`);
  if (payload.nav_date !== previousDay(previousDay(date)) || !Number.isFinite(ready) || ready >= open || ready < Date.parse(`${date}T00:00:00+08:00`)) return 'invalid_preopen_t2_nav';
  const generated = Date.parse(payload.generated_at || '');
  if (!Number.isFinite(generated) || now.getTime() - generated > 45000 || generated - now.getTime() > 2000 || Number(local.slice(17, 19)) > 50) return 'stale_signal';
  return '';
}

async function boundedJson(request) {
  if (Number(request.headers.get('content-length') || 0) > 16384) throw new Error('oversize');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('empty');
  const decoder = new TextDecoder(); let size = 0; let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error('oversize'); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

async function deliveryAttempt(env, eventId) {
  return env.SYNC_DB.prepare("SELECT owner_user_id,event_id,channel,status,updated_at FROM notify_delivery_attempts WHERE owner_user_id=? AND event_id=? AND channel='email'").bind(OWNER, eventId).first();
}

export async function handleFourETFSignal(request, env, { deliver = deliverAccountNotification, now = () => new Date() } = {}) {
  if (request.method !== 'POST') return Response.json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  if (!await authorized(request, env)) return Response.json({ ok: false, code: 'UNAUTHORIZED' }, { status: 401 });
  let payload;
  try { payload = await boundedJson(request); }
  catch { return Response.json({ ok: false, code: 'INVALID_JSON' }, { status: 400 }); }
  if (payload?.owner_user_id !== OWNER) return Response.json({ ok: false, code: 'INVALID_OWNER' }, { status: 403 });
  if (payload.dry_run === true) {
    if (payload.verify_event_id !== undefined) {
      if (!/^fourETF:\d{4}-\d{2}-\d{2}:\d{4}$/.test(payload.verify_event_id)) return Response.json({ ok: false, code: 'INVALID_EVENT_ID' }, { status: 400 });
      return Response.json({ ok: true, dry_run: true, delivery_attempt: await deliveryAttempt(env, payload.verify_event_id) || null });
    }
    const row = await env.SYNC_DB.prepare("SELECT json_extract(payload, '$.email.verified') AS verified, json_extract(payload, '$.email.enabled') AS enabled FROM notify_user_records WHERE owner_user_id=? AND record_type='client-channel' AND record_id=?").bind(OWNER, `account:${OWNER}::email`).first();
    const ready = Boolean(row?.verified && row?.enabled);
    return Response.json({ ok: ready, dry_run: true, channel: 'email', ready, owner_user_id: OWNER }, { status: ready ? 200 : 409 });
  }
  const error = validateFourETFSignal(payload, now());
  if (error) return Response.json({ ok: false, code: error }, { status: 400 });
  try {
    const prior = await deliveryAttempt(env, payload.event_id);
    if (prior) return Response.json({ ok: prior.status === 'delivered', duplicate: true, event_id: payload.event_id, channel: 'email', status: prior.status, delivery_attempt: prior }, { status: prior.status === 'delivered' ? 200 : 409 });
    // A separate atomic ingress claim closes the check/send race. The shared
    // engine intentionally retries failed reservations for other callers; this
    // strategy must never retry an uncertain email, including concurrent POSTs.
    const claim = await env.SYNC_DB.prepare('INSERT OR IGNORE INTO notify_four_etf_signal_claims (owner_user_id,event_id,input_sha256,claimed_at) VALUES (?,?,?,?)')
      .bind(OWNER, payload.event_id, payload.input_sha256, now().toISOString()).run();
    if (Number(claim?.meta?.changes || 0) !== 1) {
      const previous = await deliveryAttempt(env, payload.event_id);
      return Response.json({ ok: previous?.status === 'delivered', duplicate: true, event_id: payload.event_id, channel: 'email', status: previous?.status || 'claimed_no_retry', delivery_attempt: previous || null }, { status: previous?.status === 'delivered' ? 200 : 409 });
    }
    const execution = payload.execution_reference;
    const message = {
      eventId: payload.event_id, eventType: 'four-etf-signal', ruleId: 'fourETF', strategyName: '四 ETF 溢价切换', symbol: payload.target,
      title: `四 ETF 换仓确认：${payload.holding} → ${payload.target}`,
      summary: `${payload.holding} → ${payload.target}，偏离差 ${payload.gap_pp.toFixed(4)}pp`,
      body: [
        `${payload.date} ${payload.signal_ts.slice(11, 16)} 信号，${execution.time.slice(0, 2)}:${execution.time.slice(2)} 下一分钟双方正量 close 已确认。`,
        `参考持仓 ${payload.holding} → ${payload.target}；信号偏离 ${payload.deviations_pp[payload.holding].toFixed(4)} vs ${payload.deviations_pp[payload.target].toFixed(4)}pp，差 ${payload.gap_pp.toFixed(4)}pp > 0.5pp。`,
        `成交参考 close ${execution.sell_close} / ${execution.buy_close}；NAV 日期 ${payload.nav_date}，季度常态起算 ${payload.normal_effective}。`,
        '仅信号提醒，不自动交易。参考持仓按策略路径更新；实际持仓不符时请先纠正。'
      ].join('\n'),
      params: { strategy: 'fourETF', holding: payload.holding, target: payload.target, gap_pp: payload.gap_pp, input_sha256: payload.input_sha256 }
    };
    const result = await deliver(env, { userId: OWNER, username: 'lovexl', clientId: `account:${OWNER}` }, message, ['email'], 'four-etf-signal');
    const email = result?.events?.[0]?.channels?.find(x => x.channel === 'email');
    const attempt = await deliveryAttempt(env, payload.event_id);
    const delivered = email?.status === 'delivered' && attempt?.status === 'delivered';
    return Response.json({ ok: delivered, event_id: payload.event_id, channel: 'email', status: attempt?.status || email?.status || 'failed', delivery_attempt: attempt || null, verification: 'notify_delivery_attempts' }, { status: delivered ? 200 : 503 });
  } catch {
    return Response.json({ ok: false, code: 'DELIVERY_FAILED', event_id: payload.event_id }, { status: 503 });
  }
}
