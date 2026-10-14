// PCF 限额放开事件信号推送
// 在每日 cron 检测到限额放开事件后，调用 notify worker 的内部接口发送推送

const NOTIFY_PCF_SIGNAL_URL = 'https://api.freebacktrack.tech/api/notify/internal/pcf-signal';

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
