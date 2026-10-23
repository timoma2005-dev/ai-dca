// cn-data 仅作为活跃信息的只读补充；缺库、锁库或表结构不兼容均不影响认证服务。
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function openAnalyticsDb() {
  try {
    const path = process.env.AI_DCA_CN_DATA_DB || '/var/lib/ai-dca-cn-data/cn-data.db';
    return existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : null;
  } catch {
    return null;
  }
}

function readAnalytics(read, fallback) {
  const db = openAnalyticsDb();
  if (!db) return fallback();
  try {
    return read(db);
  } catch {
    return fallback();
  } finally {
    try { db.close(); } catch { /* 降级路径也不能影响用户列表。 */ }
  }
}

export function userLastActiveDates() {
  return readAnalytics((db) => new Map(db.prepare(
    'SELECT identity, MAX(event_date) AS d FROM analytics_daily_users GROUP BY identity',
  ).all().map((row) => [row.identity, row.d])), () => new Map());
}

export function listGuestActivity(limit = 200) {
  const max = Math.min(Math.max(Math.floor(Number(limit) || 200), 1), 500);
  return readAnalytics((db) => ({
    available: true,
    guests: db.prepare(`SELECT identity AS visitorId, MIN(event_date) AS firstSeenDate,
      MAX(event_date) AS lastActiveDate, COUNT(*) AS activeDays
      FROM analytics_daily_users WHERE is_visitor_only = 1
      GROUP BY identity ORDER BY lastActiveDate DESC LIMIT ?`).all(max).map((row) => ({ ...row })),
  }), () => ({ available: false, guests: [] }));
}
