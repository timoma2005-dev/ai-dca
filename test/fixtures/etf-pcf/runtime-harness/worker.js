// 本地 workerd 运行时验证 harness（仅测试用，不部署）：
// 1) 在与生产相同的 2026-03-26 兼容日期下验证 workerd 的 GBK TextDecoder 与 PCF 解析；
// 2) 用注入的 mock fetchImpl 走 fetchEtfPcfLimit 全流程并写入本地 Miniflare KV，再读回校验；
// 3) 模拟 scheduled 事件，回显 controller.scheduledTime（毫秒语义）与 runEtfPcfScheduledRefresh
//    全流程统计。生产模块均支持 fetchImpl 注入，无需篡改 globalThis.fetch。
import fixtureBytes from '../ETF15994120261013.gbk.txt';
import {
  decodeEtfPcf,
  parseEtfPcf,
  fetchEtfPcfLimit,
  buildEtfPcfCacheKey,
  shanghaiDateKey
} from '../../../../workers/etf-shares/src/etfPcfLimit.js';
import { runEtfPcfScheduledRefresh } from '../../../../workers/etf-shares/src/etfPcfUniverse.js';

const fixtureU8 = fixtureBytes instanceof Uint8Array ? fixtureBytes : new Uint8Array(fixtureBytes);
const CODE = '159941';
const DATE_KEY = '2026-10-13';
const NOW = new Date('2026-10-13T01:30:00.000Z');
const SOURCE_URL = 'https://reportdocs.static.szse.cn/files/text/etf/ETF' + CODE + '20261013.txt';
const ETF_FILE_PATTERN = /ETF(159\d{3})(\d{8})\.txt$/;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*'
    }
  });
}

// 单标的刷新 mock：只有 159941 当日文件存在，其余一律 404。
function mockFetchForFixture(url, init = {}) {
  const method = init.method || 'GET';
  if (url === SOURCE_URL) {
    if (method === 'GET') return Promise.resolve(new Response(fixtureU8, { status: 200 }));
    if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }));
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}

// scheduled mock：159941 任意日期文件存在（HEAD 200 / GET 返回 fixture），其余 999 个 code 404。
function mockFetchForScheduled(url, init = {}) {
  const method = init.method || 'GET';
  const match = ETF_FILE_PATTERN.exec(url);
  if (!match) return Promise.resolve(new Response(null, { status: 404 }));
  if (match[1] === CODE) {
    if (method === 'GET') return Promise.resolve(new Response(fixtureU8, { status: 200 }));
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}

let lastScheduledRecord = null;

export default {
  async scheduled(controller, env) {
    const scheduledTime = controller.scheduledTime;
    const record = {
      cron: controller.cron,
      scheduledTime,
      // 生产约定：controller.scheduledTime 为毫秒，new Date(scheduledTime) 可直接解析（Cloudflare 文档口径）。
      dateFromMs: shanghaiDateKey(new Date(scheduledTime))
    };
    let summary = null;
    try {
      const result = await runEtfPcfScheduledRefresh({
        env,
        scheduledTime,
        fetchImpl: mockFetchForScheduled,
        timeoutMs: 2000
      });
      summary = {
        ok: result.ok,
        date: result.date,
        probeTotal: result.probeTotal,
        probeExists: result.probeExists,
        probeNotFound: result.probeNotFound,
        probeFailed: result.probeFailed,
        total: result.total,
        success: result.success,
        degraded: result.degraded
      };
    } catch (error) {
      summary = { error: String((error && error.message) || error) };
    }
    lastScheduledRecord = { ...record, summary };
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/__test/ping') {
      return new Response('pong');
    }

    if (url.pathname === '/__test/decode') {
      const text = decodeEtfPcf(fixtureU8);
      const parsed = parseEtfPcf(text, { code: CODE, date: DATE_KEY });
      return jsonResponse({
        ok: true,
        firstLine: text.split('\n')[0].trim(),
        fundName: parsed.fundName,
        fundType: parsed.fundType,
        fundManager: parsed.fundManager,
        targetIndexCode: parsed.targetIndexCode,
        netSubscribeLimitShares: parsed.netSubscribeLimitShares,
        netSubscribeLimitKind: parsed.netSubscribeLimitKind,
        netRedeemLimitShares: parsed.netRedeemLimitShares,
        netRedeemLimitKind: parsed.netRedeemLimitKind,
        accountNetSubscribeLimitKind: parsed.accountNetSubscribeLimitKind,
        accountTotalSubscribeLimitShares: parsed.accountTotalSubscribeLimitShares,
        totalRedeemLimitKind: parsed.totalRedeemLimitKind,
        creationRedemptionUnitShares: parsed.creationRedemptionUnitShares,
        subscriptionAllowed: parsed.subscriptionAllowed,
        redemptionAllowed: parsed.redemptionAllowed,
        estimatedCashDifference: parsed.estimatedCashDifference,
        cashSubstitutionRatioLimitPct: parsed.cashSubstitutionRatioLimitPct,
        iopvRequired: parsed.iopvRequired,
        unitCashDividend: parsed.unitCashDividend,
        localBasketSecurityCount: parsed.localBasketSecurityCount,
        totalBasketSecurityCount: parsed.totalBasketSecurityCount,
        warnings: parsed.warnings
      });
    }

    if (url.pathname === '/__test/decode-invalid') {
      // GBK 非法字节（0xFF 不是合法的 GBK 单字节或双字节首字节）在 fatal 模式下必须抛错。
      try {
        decodeEtfPcf(new Uint8Array([0xff, 0xff]));
        return jsonResponse({ throws: false });
      } catch (_error) {
        return jsonResponse({ throws: true });
      }
    }

    if (url.pathname === '/__test/fetch-limit') {
      const result = await fetchEtfPcfLimit({
        code: CODE,
        date: DATE_KEY,
        env,
        forceRefresh: true,
        now: NOW,
        fetchImpl: mockFetchForFixture
      });
      return jsonResponse(result);
    }

    if (url.pathname === '/__test/read-cache') {
      const key = buildEtfPcfCacheKey(CODE, DATE_KEY);
      const raw = await env.FUND_LIMIT_KV.get(key);
      if (raw == null) return jsonResponse({ found: false, key });
      const data = JSON.parse(raw);
      return jsonResponse({
        found: true,
        key,
        code: data.code,
        date: data.date,
        fundName: data.fundName,
        netSubscribeLimitShares: data.netSubscribeLimitShares,
        netRedeemLimitShares: data.netRedeemLimitShares,
        fetchedAt: data.fetchedAt,
        expiresAt: data.expiresAt
      });
    }

    if (url.pathname === '/__test/last-scheduled') {
      return jsonResponse(lastScheduledRecord || { found: false });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};
