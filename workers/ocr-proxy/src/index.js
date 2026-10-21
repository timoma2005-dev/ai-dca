/* global console, URL */
/* eslint no-unused-vars: ["error", { "caughtErrorsIgnorePattern": "^_" }] */
import { handleEtfPcfShares } from './etfPcfSharesRoute.js';
import { handleFundFee, handleFundLimit, handleFundLimitOverview } from './fundRoutes.js';
import { refreshFundLimitCache } from './fundLimit.js';
import { refreshFundLimitOverview } from './fundLimitOverview.js';
import { runEtfPcfEvents } from './etfPcfEvents.js';
import { TARGET_CODES } from './etfPcfShares.js';
import { handleEtfPcfEvents, handleEtfPcfLimit } from './etfPcfRoutes.js';
import { runEtfPcfScheduledRefresh } from './etfPcfUniverse.js';
import { refreshSsePcfLimitCache } from './ssePcfLimit.js';
import {
  handleHoldingsNav,
  handleHoldingsNavHistory,
  handleHoldingsNavHistoryBatch
} from './holdingsNavRoutes.js';
import { handleHoldingsOcr, handleOcr } from './imageOcrRoutes.js';
import { sendPcfSignalNotifications } from './pcfSignalNotify.js';
import { emptyResponse, jsonResponse } from './ocrHttp.js';
import { HOLDINGS_PROMPT_VERSION, PROMPT_VERSION } from './geminiPrompt.js';
import { isTradingDayShanghai } from '../../../shared/etfPcfTradingCalendar.js';

const FUND_LIMIT_CRON = '0 12 * * *';
// 30 1 * * 1-5：北京时间 09:30 补跑，覆盖 09:00 时交易所数据尚未就绪的情况。
const ETF_PCF_DAILY_CRONS = new Set(['0 1 * * *', '0 1 * * 1-5', '30 1 * * 1-5']);

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
    szse = await szseRefresh({ env, scheduledTime, onSuccess: data => { if (TARGET_CODES.includes(data.code) && data.code.startsWith('159')) pcfs.push(data); } });
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
  return { sse, szse, events, pcfSignal, jobDurationMs: Date.now() - startMs };
}

export default {
  async scheduled(controller, env, ctx) {
    const cron = String(controller?.cron || '').trim();
    if (cron === FUND_LIMIT_CRON) {
      ctx.waitUntil((async () => {
        await refreshFundLimitCache({ env, ctx, force: true, concurrency: 4 });
        await refreshFundLimitOverview({ env, concurrency: 4 });
      })());
    }
    // 北京时间交易日 09:00（UTC 01:00）：先上交所 5 只纳指 ETF 小规模刷新，再深交所
    // ETF PCF 全量刷新（探测 → 校准 → 逐项抓取），两阶段异常隔离、统计独立。
    if (ETF_PCF_DAILY_CRONS.has(cron)) {
      const trigger = resolveEtfPcfDailyTrigger({ cron, scheduledTime: controller?.scheduledTime });
      if (!trigger.shouldRun) {
        console.log(`[etf-pcf] skip daily refresh: ${trigger.reason}`, trigger);
        return;
      }
      ctx.waitUntil(runEtfPcfDailyRefresh({ env, scheduledTime: controller?.scheduledTime }));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/etf-pcf-shares') return handleEtfPcfShares(request, env, ctx, url.searchParams);

    if (request.method === 'OPTIONS') {
      return emptyResponse();
    }

    if (url.pathname === '/api/health') {
      return jsonResponse({
        ok: true,
        service: 'ocr-proxy',
        fundSwitchPromptVersion: PROMPT_VERSION,
        fundHoldingsPromptVersion: HOLDINGS_PROMPT_VERSION
      });
    }

    if (url.pathname === '/api/ocr') {
      if (request.method !== 'POST') {
        return jsonResponse({
          error: 'Method not allowed'
        }, 405, {
          allow: 'POST, OPTIONS'
        });
      }

      try {
        return await handleOcr(request, env);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : 'OCR 代理执行失败。'
        }, 502);
      }
    }

    if (url.pathname === '/api/holdings/ocr') {
      if (request.method !== 'POST') {
        return jsonResponse({
          error: 'Method not allowed'
        }, 405, {
          allow: 'POST, OPTIONS'
        });
      }

      try {
        return await handleHoldingsOcr(request, env);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : '持仓 OCR 代理执行失败。'
        }, 502);
      }
    }

    if (url.pathname === '/api/holdings/nav') {
      if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse({
          error: 'Method not allowed'
        }, 405, {
          allow: 'GET, POST, OPTIONS'
        });
      }

      try {
        return await handleHoldingsNav(request, env);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : '持仓净值代理执行失败。'
        }, 502);
      }
    }

    if (url.pathname === '/api/holdings/nav-history') {
      // GET ?code=XXXXXX            → 单 code（兼容）
      // POST { codes:[], from?, to?, days?, force? }   → 批量
      if (request.method !== 'GET' && request.method !== 'POST') {
        return jsonResponse({
          error: 'Method not allowed'
        }, 405, {
          allow: 'GET, POST, OPTIONS'
        });
      }

      try {
        if (request.method === 'POST') {
          return await handleHoldingsNavHistoryBatch(request, env);
        }
        return await handleHoldingsNavHistory(request, env);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : '净值历史代理执行失败。'
        }, 502);
      }
    }

    if (url.pathname === '/api/fund-limit/overview') {
      // GET ?days=7|30 → 缓存快照、趋势与限额变动事件；不触发实时上游抓取。
      try {
        return await handleFundLimitOverview(request, env, url.searchParams);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : '场外限额聚合快照读取失败。'
        }, 502);
      }
    }

    if (url.pathname === '/api/fund-limit') {
      // GET ?code=XXXXXX        → 只读 FUND_LIMIT_KV
      // POST { code: XXXXXX }  → 单 code 手动刷新并写入 FUND_LIMIT_KV
      if (request.method !== 'GET' && request.method !== 'POST') {
        return jsonResponse({
          error: 'Method not allowed'
        }, 405, {
          allow: 'GET, POST, OPTIONS'
        });
      }

      try {
        return await handleFundLimit(request, env, ctx, url.searchParams);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : '基金限额代理执行失败。'
        }, 502);
      }
    }

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

    if (url.pathname === '/api/fund-fee') {
      // GET ?code=XXXXXX        → 单 code
      // POST { codes: [...] }   → 批量，场外走蛋卷，场内 ETF 自动降级 F10
      if (request.method !== 'GET' && request.method !== 'POST') {
        return jsonResponse({
          error: 'Method not allowed'
        }, 405, {
          allow: 'GET, POST, OPTIONS'
        });
      }

      try {
        return await handleFundFee(request, env, ctx, url.searchParams);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : '基金费率代理执行失败。'
        }, 502);
      }
    }

    return jsonResponse({
      error: 'Not found'
    }, 404);
  }
};
