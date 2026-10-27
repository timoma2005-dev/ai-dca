/* global console, URL */
/* eslint no-unused-vars: ["error", { "caughtErrorsIgnorePattern": "^_" }] */
// ai-dca-etf-shares：13 只纳指 ETF 的 PCF 申购限额 + 每日份额 + 限额环比投影。
// 路由 api.freebacktrack.tech/api/etf-pcf*；定时见 wrangler.toml（工作日北京时间 08:30 主跑，08:45 / 09:00 不完整时补抓）。
// 从 ocr-proxy 拆出（2026-10-22），只保留 ETF 限额/份额相关代码。
import { handleEtfPcfShares } from './etfPcfSharesRoute.js';
import { runEtfPcfEvents } from './etfPcfEvents.js';
import { TARGET_CODES } from './etfPcfShares.js';
import { handleEtfPcfEvents, handleEtfPcfLimit } from './etfPcfRoutes.js';
import { runEtfPcfScheduledRefresh } from './etfPcfUniverse.js';
import { refreshSsePcfLimitCache } from './ssePcfLimit.js';
import { sendPcfSignalNotifications, sendPcfAtLimitNotifications } from './pcfSignalNotify.js';
import { emptyResponse, jsonResponse } from './util.js';
import { isTradingDayShanghai } from '../../../shared/etfPcfTradingCalendar.js';

// 注意：Cloudflare cron 星期 1=周日…7=周六，「1-5」是周日到周四，周五不会触发；工作日必须写 MON-FRI。
// 30 1 * * MON-FRI：北京时间 09:30 补跑，覆盖 09:00 时交易所数据尚未就绪的情况。
// 旧写法（1-5）保留识别，避免定时切换期间被当成 wrong-cron。
const ETF_PCF_DAILY_CRONS = new Set(['30 0 * * MON-FRI', '45 0 * * MON-FRI', '0 1 * * *', '0 1 * * MON-FRI', '30 1 * * MON-FRI', '0 1 * * 1-5', '30 1 * * 1-5']);
// 08:30 主跑必定执行；其余为补抓：当天已完整（KV 完成标记存在）就跳过。
export const ETF_PCF_PRIMARY_CRON = '30 0 * * MON-FRI';
const COMPLETE_KEY_PREFIX = 'etf-pcf-daily-complete:';
const COMPLETE_TTL_SECONDS = 3 * 24 * 3600;

export function isEtfPcfDailyRunComplete(result) {
  const sse = result?.sse;
  const szse = result?.szse;
  const sseOk = Boolean(sse?.ok && sse.stats && sse.stats.success + sse.stats.notFound === sse.stats.total);
  const szseOk = Boolean(szse?.ok && Number.isFinite(szse.total) && szse.success + (szse.notFound || 0) === szse.total);
  return sseOk && szseOk && Boolean(result?.events?.ok);
}

async function readDailyComplete(env, date) {
  try { return Boolean(await env?.FUND_LIMIT_KV?.get(COMPLETE_KEY_PREFIX + date)); } catch (_e) { return false; }
}

export async function runEtfPcfDailyWithCompletion({ env, cron, scheduledTime, date, refresh = runEtfPcfDailyRefresh }) {
  if (cron !== ETF_PCF_PRIMARY_CRON && await readDailyComplete(env, date)) {
    console.log(`[etf-pcf] ${date} already complete, skip follow-up ${cron}`);
    return { skipped: true, reason: 'already-complete' };
  }
  const result = await refresh({ env, scheduledTime });
  const complete = isEtfPcfDailyRunComplete(result);
  if (complete) {
    try { await env?.FUND_LIMIT_KV?.put(COMPLETE_KEY_PREFIX + date, new Date().toISOString(), { expirationTtl: COMPLETE_TTL_SECONDS }); } catch (_e) { /* 标记失败下一轮再跑一次 */ }
  }
  console.log(`[etf-pcf] ${date} cron=${cron} complete=${complete}`);
  return { ...result, complete };
}

export function resolveEtfPcfDailyTrigger({ cron, scheduledTime } = {}) {
  if (!ETF_PCF_DAILY_CRONS.has(cron)) {
    return { shouldRun: false, date: null, reason: 'wrong-cron' };
  }
  if (!Number.isFinite(scheduledTime) || !Number.isFinite(new Date(scheduledTime).getTime())) {
    return { shouldRun: false, date: null, reason: 'invalid-scheduled-time' };
  }
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(scheduledTime));
  const shouldRun = isTradingDayShanghai(date);
  return { shouldRun, date, reason: shouldRun ? 'ok' : 'non-trading-day' };
}

// SSE 阶段 60 秒软预算：到期停止分配、取消进行中请求并分类 skippedDeadline；
// 不延长深交所阶段原 12 分钟预算，两阶段顺序执行不重叠。
const ETF_PCF_SSE_STAGE_DEADLINE_MS = 60 * 1000;

// 北京时间 09:00 顺序执行 SSE → SZSE → events，各阶段异常隔离。
// SZSE 阶段只抓 TARGET_CODES 里的 159 代码（原来按代码顺序爬全市场约 1000 只，目标 159 要到 09:15 左右才轮到）。
// 份额投影阶段：默认 20s 在 cron 里经常跑不到 projection（历史读取+两所份额下载），放宽到 120s。
const ETF_PCF_EVENTS_STAGE_DEADLINE_MS = 120 * 1000;
export async function runEtfPcfDailyRefresh({
  env,
  scheduledTime,
  sseDeadlineMs = ETF_PCF_SSE_STAGE_DEADLINE_MS,
  sseRefresh = refreshSsePcfLimitCache,
  szseRefresh = runEtfPcfScheduledRefresh,
  eventsRefresh = runEtfPcfEvents
} = {}) {
  const startMs = Date.now();
  if (!Number.isFinite(scheduledTime)) {
    return {
      ok: false,
      reason: 'invalid_scheduled_time',
      sse: { ok: false, reason: 'invalid_scheduled_time' },
      szse: { ok: false, reason: 'invalid_scheduled_time' },
      events: { ok: false, reason: 'invalid_scheduled_time' },
      pcfSignal: null,
      pcfAtLimit: null,
      jobDurationMs: Date.now() - startMs
    };
  }
  const now = new Date(scheduledTime);
  let sse;
  try {
    sse = await sseRefresh({ env, now, deadlineMs: sseDeadlineMs });
  } catch (e) {
    sse = { ok: false, reason: 'sse_stage_error', error: (e && e.message) || String(e) };
    console.log('[etf-pcf][sse] scheduled stage crashed: ' + ((e && e.message) || e));
  }
  let szse; const pcfs = [];
  try {
    szse = await szseRefresh({ env, scheduledTime, codes: TARGET_CODES.filter(c => c.startsWith('159')), onSuccess: data => { if (TARGET_CODES.includes(data.code) && data.code.startsWith('159')) pcfs.push(data); } });
  } catch (e) {
    szse = { ok: false, reason: 'szse_stage_error', error: (e && e.message) || String(e) };
    console.log('[etf-pcf] scheduled stage crashed: ' + ((e && e.message) || e));
  }
  let events;
  try { events = await eventsRefresh({ env, pcfs: pcfs.map(({ code, date }) => ({ code, date })), pcfData: pcfs, scheduledTime, deadlineMs: ETF_PCF_EVENTS_STAGE_DEADLINE_MS }); } catch (_e) { events = { ok: false, reason: 'events_stage_error' }; }
  // PCF 限额放开信号推送：检测到 5x/10x/unlimited 事件后发送通知
  let pcfSignal = null;
  if (events?.ok && Array.isArray(events.detectedEvents) && events.detectedEvents.length > 0) {
    try {
      pcfSignal = await sendPcfSignalNotifications(env, events.detectedEvents);
    } catch (e) {
      console.log('[etf-pcf][pcf-signal] notification failed: ' + ((e && e.message) || e));
      pcfSignal = { ok: false, reason: 'notification_error' };
    }
  }
  let pcfAtLimit = null;
  if (events?.ok && Array.isArray(events.detectedEvents) && events.detectedEvents.some(
    event => event?.signal_type === 'net_creation_near_total_limit' && event.basis === 'total'
  )) {
    try {
      pcfAtLimit = await sendPcfAtLimitNotifications(env, events.detectedEvents);
    } catch (e) {
      console.log('[etf-pcf][pcf-at-limit] notification failed: ' + ((e && e.message) || e));
      pcfAtLimit = { ok: false, reason: 'notification_error' };
    }
  }
  return { sse, szse, events, pcfSignal, pcfAtLimit, jobDurationMs: Date.now() - startMs };
}

export default {
  async scheduled(controller, env, ctx) {
    const cron = String(controller?.cron || '').trim();
    // 工作日北京时间 09:00 / 09:30：上交所 5 只 → 深交所目标 159 → 份额/限额环比投影。
    if (ETF_PCF_DAILY_CRONS.has(cron)) {
      const trigger = resolveEtfPcfDailyTrigger({ cron, scheduledTime: controller?.scheduledTime });
      if (!trigger.shouldRun) {
        console.log(`[etf-pcf] skip daily refresh: ${trigger.reason}`, trigger);
        return;
      }
      ctx.waitUntil(runEtfPcfDailyWithCompletion({ env, cron, scheduledTime: controller?.scheduledTime, date: trigger.date }));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // shares 路由自己处理 OPTIONS（no-store/Allow），必须排在通用 OPTIONS 之前。
    if (url.pathname === '/api/etf-pcf-shares') return handleEtfPcfShares(request, env, ctx, url.searchParams);
    if (request.method === 'OPTIONS') return emptyResponse();
    if (url.pathname === '/api/etf-pcf-events') return handleEtfPcfEvents(request, env, ctx, url.searchParams);
    if (url.pathname === '/api/etf-pcf-limit') {
      // PCF GET 只读缓存，POST 单标的刷新。
      if (request.method !== 'GET' && request.method !== 'POST') {
        return jsonResponse({
          error: 'Method not allowed'
        }, 405, {
          allow: 'GET, POST, OPTIONS'
        });
      }

      try {
        return await handleEtfPcfLimit(request, env, ctx, url.searchParams);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : 'ETF PCF 限额代理执行失败。'
        }, 502);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};
