// /api/sync/analytics/track 匿名写入的按 IP 固定窗口限流（D1 持久化）。
// 背景：该端点无鉴权，仅靠单请求 50 条上限与 31 天清理不足以阻止脚本刷量，
// 会污染分析数据并消耗 D1 写入额度。Cloudflare 会覆写 cf-connecting-ip，
// 该头可信；多 isolate 下进程内 Map 不可靠，所以计数器落 D1。
// cn-data 侧有同口径实现（services/cn-data/src/sync/analyticsRateLimit.js），
// 因 /opt 部署边界不能共享模块，语义一致性由双方测试守护。

export const DEFAULT_ANALYTICS_LIMIT_PER_HOUR = 600;
const WINDOW_MS = 60 * 60 * 1000;

/** 0 表示关闭限流（应急/测试）；非法值回退默认。 */
export function resolveAnalyticsLimit(env) {
  const raw = Number(env?.ANALYTICS_RATE_LIMIT_PER_HOUR);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_ANALYTICS_LIMIT_PER_HOUR;
}

export function clientIpFromRequest(request) {
  const ip = String(
    request.headers.get('cf-connecting-ip')
    || request.headers.get('x-real-ip')
    || ''
  ).trim();
  return ip || 'unknown';
}

function hourBucket(nowMs) {
  const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  return {
    key: new Date(start).toISOString().slice(0, 13), // UTC 小时桶 yyyy-mm-ddTHH
    startIso: new Date(start).toISOString(),
    expiresIso: new Date(start + WINDOW_MS).toISOString(),
  };
}

/**
 * 累加当前小时窗口的事件计数并判定是否超限。计数在写入前累加，
 * 超限请求的事件数也会计入（让滥用方保持被限状态，窗口结束自动恢复）。
 * 返回 { limited, limit, used, retryAfter }。
 */
export async function enforceAnalyticsRateLimit(env, request, eventCount, nowMs = Date.now()) {
  const limit = resolveAnalyticsLimit(env);
  if (limit === 0) return { limited: false, limit, used: 0, retryAfter: 0 };
  const bucket = hourBucket(nowMs);
  const key = `ip:${clientIpFromRequest(request)}:${bucket.key}`;
  await env.DB.prepare(
    `INSERT INTO analytics_rate_counters (key, count, window_start, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + excluded.count`
  ).bind(key, eventCount, bucket.startIso, bucket.expiresIso).run();
  const row = await env.DB.prepare('SELECT count FROM analytics_rate_counters WHERE key = ?')
    .bind(key)
    .first();
  const used = Number(row?.count || 0);
  const limited = used > limit;
  return {
    limited,
    limit,
    used,
    retryAfter: limited
      ? Math.max(1, Math.ceil((new Date(bucket.expiresIso).getTime() - nowMs) / 1000))
      : 0,
  };
}

/** 清理已过期窗口行，由 scheduled cron 调用。 */
export async function pruneExpiredRateCounters(env, nowMs = Date.now()) {
  const result = await env.DB.prepare('DELETE FROM analytics_rate_counters WHERE expires_at <= ?')
    .bind(new Date(nowMs).toISOString())
    .run();
  return { deleted: Number(result?.meta?.changes) || 0 };
}
