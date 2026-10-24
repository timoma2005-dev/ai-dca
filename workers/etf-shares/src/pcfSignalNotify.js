// PCF 限额放开事件信号推送
// 在每日 cron 检测到限额放开事件后，调用 notify worker 的内部接口发送推送

import { isWellFormedEtfPcfDateKey } from './etfPcfLimit.js';

const NOTIFY_PCF_SIGNAL_URL = 'https://api.freebacktrack.tech/api/notify/internal/pcf-signal';
const NOTIFY_PCF_AT_LIMIT_URL = 'https://api.freebacktrack.tech/api/notify/internal/pcf-at-limit';

// 从事件中提取推送需要的数据
function extractSignalData(event) {
  if (!event || event.signal_type !== 'limit_relaxation') return null;
  const { code, tier, prev, cur, ratio, date } = event;
  if (!['5x', '10x', 'unlimited'].includes(tier)) return null;
  return { code, tier, prev, cur, ratio, date };
}

export async function sendPcfSignalNotifications(env, events) {
  const signals = (events || [])
    .map(extractSignalData)
    .filter(Boolean);

  if (!signals.length) {
    return { ok: true, sent: 0, reason: 'no_signals' };
  }

  const results = [];
  const token = env.INTERNAL_NOTIFY_TOKEN || '';

  for (const signal of signals) {
    try {
      // 尝试获取当前溢价（通过 MARKETS 服务，如果可用）
      let premium = null;
      try {
        if (env.MARKETS) {
          // MARKETS 服务绑定可用于获取行情数据
          // 这里简化处理，实际可根据 MARKETS 的 API 调整
        }
      } catch {
        // 溢价获取失败不阻塞推送
      }

      const response = await fetch(NOTIFY_PCF_SIGNAL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ...signal, premium }),
      });

      const result = await response.json().catch(() => ({}));
      results.push({
        code: signal.code,
        tier: signal.tier,
        ok: response.ok && result.ok,
        status: response.status,
      });

      console.log(`[pcf-signal] notified ${signal.code} tier=${signal.tier} status=${response.status}`);
    } catch (e) {
      console.error(`[pcf-signal] failed for ${signal.code}:`, e.message);
      results.push({
        code: signal.code,
        tier: signal.tier,
        ok: false,
        error: e.message,
      });
    }
  }

  const sent = results.filter(r => r.ok).length;
  return { ok: true, sent, total: signals.length, results };
}

export async function sendPcfAtLimitNotifications(env, events) {
  const signals = (events || []).filter(
    event => event?.signal_type === 'net_creation_near_total_limit' && event.basis === 'total'
  );
  const results = [];
  const days = new Map();
  const kv = env?.FUND_LIMIT_KV;
  const token = env?.INTERNAL_NOTIFY_TOKEN || '';

  for (const event of signals) {
    const { code, date, signal_type, basis } = event;
    // 日期/代码必须先校验，不能让损坏事件写到其它日的去重键。
    if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !isWellFormedEtfPcfDateKey(date)) {
      results.push({ code, date, ok: false, error: 'invalid_event_identity', dedupe: 'invalid_event' });
      continue;
    }
    const id = `${date}:${code}:${signal_type}:${basis}`;
    let day = days.get(date);
    if (!day) {
      day = {
        key: `etf-pcf-atlimit-notified:${date.replaceAll('-', '')}`,
        ids: new Set(),
        dedupe: kv ? 'ready' : 'unavailable',
        sent: []
      };
      days.set(date, day);
      if (kv) {
        try {
          const raw = await kv.get(day.key);
          const ids = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const validId = new RegExp(`^${date}:\\d{6}:net_creation_near_total_limit:total$`);
          if (ids !== null && (!Array.isArray(ids) || !ids.every(value => typeof value === 'string' && validId.test(value)))) {
            day.dedupe = 'invalid_cache';
          } else {
            day.ids = new Set(ids || []);
          }
        } catch (e) {
          day.dedupe = 'read_failed';
          console.error(`[pcf-at-limit] dedupe read failed for ${date}:`, e.message);
        }
      }
    }
    if (day.ids.has(id)) {
      results.push({ code, date, ok: true, skipped: true, dedupe: 'hit' });
      continue;
    }

    const entry = { code, date, ok: false, dedupe: day.dedupe === 'ready' ? 'miss' : day.dedupe };
    results.push(entry);
    try {
      const response = await fetch(NOTIFY_PCF_AT_LIMIT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          code, date, netCreation: event.netCreation,
          totalLimitShares: event.totalLimit?.shares, ratio: event.ratio
        })
      });
      const result = await response.json().catch(() => ({}));
      entry.ok = Boolean(response.ok && result?.ok);
      entry.status = response.status;
      if (entry.ok) {
        day.ids.add(id);
        day.sent.push(entry);
      }
      console.log(`[pcf-at-limit] notified ${code} date=${date} status=${response.status}`);
    } catch (e) {
      entry.error = e.message;
      console.error(`[pcf-at-limit] failed for ${code}:`, e.message);
    }
  }

  for (const day of days.values()) {
    // 每个日期只写一次，避免同一 KV key 的写入速率限制；读失败时不覆盖未知的已发送集合。
    if (!day.sent.length || day.dedupe !== 'ready') continue;
    let dedupe = 'stored';
    try {
      await kv.put(day.key, JSON.stringify([...day.ids]));
    } catch (e) {
      dedupe = 'write_failed';
      console.error(`[pcf-at-limit] dedupe write failed for ${day.key}:`, e.message);
    }
    for (const entry of day.sent) entry.dedupe = dedupe;
  }
  const sent = results.filter(r => r.ok && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  return { ok: true, sent, skipped, total: signals.length, results };
}
