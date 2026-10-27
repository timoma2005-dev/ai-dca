// /api/sync/analytics/track 匿名写入的按 IP 固定窗口限流（node:sqlite 同步版）。
// 与 workers/sync/src/analyticsRateLimit.js 同口径：默认 600 事件/小时/IP，
// 环境变量 ANALYTICS_RATE_LIMIT_PER_HOUR=0 关闭。cn-data 的 /opt 部署单元不能
// 跨目录 import shared/ 与 worker 模块，故保留这份同构实现，语义由双方测试守护。

export const DEFAULT_ANALYTICS_LIMIT_PER_HOUR = 600;
const WINDOW_MS = 60 * 60 * 1000;

export function resolveAnalyticsLimit(env = process.env) {
  const raw = Number(env?.ANALYTICS_RATE_LIMIT_PER_HOUR);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_ANALYTICS_LIMIT_PER_HOUR;
}

export function clientIpFromRequest(request) {
  const ip = String(
    request.headers?.get?.('x-real-ip')
    || request.headers?.get?.('cf-connecting-ip')
    || ''
  ).trim();
  return ip || 'unknown';
}

function hourBucket(nowMs) {
  const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  return {
    key: new Date(start).toISOString().slice(0, 13),
    startIso: new Date(start).toISOString(),
    expiresIso: new Date(start + WINDOW_MS).toISOString(),
  };
}

/**
 * 累加当前小时窗口计数并判定超限；超限请求的事件数同样计入，窗口结束自动恢复。
 * prune=true 时顺带清理过期窗口行（调用方按概率传入，避免每次请求都扫表）。
 */
export function enforceAnalyticsRateLimit(db, request, eventCount, { nowMs = Date.now(), prune = false, env = process.env } = {}) {
  const limit = resolveAnalyticsLimit(env);
  if (limit === 0) return { limited: false, limit, used: 0, retryAfter: 0 };
  if (prune) {
    db.prepare('DELETE FROM analytics_rate_counters WHERE expires_at <= ?').run(new Date(nowMs).toISOString());
  }
  const bucket = hourBucket(nowMs);
  const key = `ip:${clientIpFromRequest(request)}:${bucket.key}`;
  db.prepare(
    `INSERT INTO analytics_rate_counters (key, count, window_start, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + excluded.count`
  ).run(key, eventCount, bucket.startIso, bucket.expiresIso);
  const row = db.prepare('SELECT count FROM analytics_rate_counters WHERE key = ?').get(key);
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
