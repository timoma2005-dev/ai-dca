-- /api/sync/analytics/track 匿名写入的按 IP 小时窗口限流计数器。
-- 与 workers/sync 的 analytics_rate_counters 同构（各自独立计数，不互相同步）。
-- key 形如 ip:<x-real-ip>:<UTC 小时桶>，窗口过期后由限流模块概率性清理。
CREATE TABLE IF NOT EXISTS analytics_rate_counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_rate_counters_expires
  ON analytics_rate_counters (expires_at);
