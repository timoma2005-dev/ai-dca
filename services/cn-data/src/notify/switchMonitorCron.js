import { openDb, closeDb } from '../db.js';
import { runMonitorTick } from './switchMonitor.js';
import { getShanghaiHourMinute } from './switchStrategyPort.js';

function tradingTimeToday() {
  const now = new Date();
  const { weekday, hour, minute } = getShanghaiHourMinute(now);
  const result = new Date(now.getTime() + (600 - hour * 60 - minute) * 60000);
  result.setUTCSeconds(0, 0);
  // 手动强制模式在周末也绕过交易窗口，使用最近的周五。
  if (weekday === 'Sat') result.setUTCDate(result.getUTCDate() - 1);
  if (weekday === 'Sun') result.setUTCDate(result.getUTCDate() - 2);
  return result;
}

const dbPath = process.env.CN_DATA_DB_PATH || '/var/lib/ai-dca-cn-data/cn-data.db';
const force = process.env.SWITCH_MONITOR_FORCE === '1';
let db;
try {
  db = openDb(dbPath);
  const summary = await runMonitorTick(db, force ? { now: tradingTimeToday() } : {});
  console.log('[switch-monitor] ' + JSON.stringify(summary));
} catch (error) {
  console.error('[switch-monitor] fatal', error);
  process.exitCode = 1;
} finally { closeDb(db); }
