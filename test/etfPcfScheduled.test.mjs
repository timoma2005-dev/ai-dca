// cron 编排测试：runEtfPcfScheduledRefresh 两阶段（探测 → 名单校准 → 逐项抓取）、
// scheduledTime 上海换日、失败隔离、重试/预算/deadline、降级；09:00 组合刷新
// runEtfPcfDailyRefresh（先上交所 5 只小规模刷新，再深交所全量，两阶段异常隔离、
// 统计独立、SSE 60 秒软预算与并发 2）；以及 index.js 的 cron 分发
//（新 09:00 触发双市场，旧 20:00 顺序不变）。全部 mock fetch + fake KV 离线运行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker, { runEtfPcfDailyRefresh } from '../workers/ocr-proxy/src/index.js';
import {
  ETF_PCF_UNIVERSE_KEY,
  refreshEtfPcfLimitCache,
  runEtfPcfScheduledRefresh
} from '../workers/ocr-proxy/src/etfPcfUniverse.js';
import { clearEtfPcfRuntimeStateForTests } from '../workers/ocr-proxy/src/etfPcfLimit.js';
import {
  SSE_PCF_CODES,
  clearSsePcfRuntimeStateForTests,
  refreshSsePcfLimitCache
} from '../workers/ocr-proxy/src/ssePcfLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BYTES = new Uint8Array(
  readFileSync(path.join(__dirname, 'fixtures/etf-pcf/ETF15994120261013.gbk.txt'))
);
// 2026-10-13 09:00 上海（= UTC 01:00）：新 cron 的名义触发时间。
const SCHEDULED_MS = Date.UTC(2026, 9, 13, 1, 0, 0);
const DATE_KEY = '2026-10-13';
const originalGlobalFetch = globalThis.fetch;

// 上交所 2026-10-13 五只真实脱敏 fixture（TRADING_DAY 均为 20261013）。
const SSE_FIXTURES = new Map();
for (const code of SSE_PCF_CODES) {
  SSE_FIXTURES.set(
    code,
    readFileSync(path.join(__dirname, 'fixtures/etf-pcf-sse', `SSE${code}20261013.json`), 'utf8')
  );
}
const SSE_URL_PREFIX = 'https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=';
const SSE_REFERER = 'https://www.sse.com.cn/';

class FakeKV {
  constructor(initial = new Map()) {
    this.store = initial instanceof Map ? initial : new Map(Object.entries(initial));
    this.getCalls = [];
    this.putCalls = [];
  }

  async get(key) {
    this.getCalls.push(key);
    if (this.getImpl) return this.getImpl(key);
    const value = this.store.get(key);
    return value === undefined ? null : value;
  }

  async put(key, value, options) {
    this.putCalls.push({ key, value, options });
    if (this.putImpl) return this.putImpl(key, value, options);
    this.store.set(key, value);
    return true;
  }
}

// fixture 正文代码「159941」为纯 ASCII 且前置空格保证 GBK 对齐，按字节替换即可
// 为任意探测存在的 code 生成身份匹配的文件内容。
function fixtureBytesForCode(code) {
  if (code === '159941') return FIXTURE_BYTES;
  const needle = [0x31, 0x35, 0x39, 0x39, 0x34, 0x31]; // '159941'
  const replacement = new TextEncoder().encode(code);
  const out = new Uint8Array(FIXTURE_BYTES);
  let replaced = 0;
  for (let i = 1; i + 6 <= out.length; i += 1) {
    if (out[i - 1] !== 0x20) continue;
    let matched = true;
    for (let j = 0; j < 6; j += 1) {
      if (out[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      for (let j = 0; j < 6; j += 1) out[i + j] = replacement[j];
      replaced += 1;
      i += 5;
    }
  }
  assert.ok(replaced >= 1, 'fixture 代码标记未找到');
  return out;
}

// 全流程 mock：探测阶段走 HEAD（probeBehavior 可指定持续故障），文件阶段走 GET
//（fileBehavior 可指定 404/超时/坏字节/500 一次）。记录调用顺序与各阶段并发峰值。
function createPipelineMock({ exists = new Set(), probeBehavior = new Map(), fileBehavior = new Map() } = {}) {
  const calls = [];
  let activeProbes = 0;
  let maxActiveProbes = 0;
  let activeFiles = 0;
  let maxActiveFiles = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const code = (/ETF(159\d{3})\d{8}\.txt$/.exec(url) || [])[1];
    const seq = calls.length + 1;
    calls.push({ seq, url, method, code });
    if (method === 'HEAD') {
      activeProbes += 1;
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
      try {
        if (probeBehavior.get(code) === 'probe_500') return { status: 500 };
        return { status: exists.has(code) ? 200 : 404 };
      } finally {
        activeProbes -= 1;
      }
    }
    activeFiles += 1;
    maxActiveFiles = Math.max(maxActiveFiles, activeFiles);
    try {
      const mode = fileBehavior.get(code);
      if (mode === 'not_found') return { status: 404 };
      if (mode === 'timeout') {
        return await new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (mode === 'corrupt') return { status: 200, arrayBuffer: async () => new Uint8Array([0x81]) };
      if (mode === '500_once') {
        fileBehavior.set(code, 'ok');
        return { status: 500 };
      }
      if (mode === 'file_ok' || exists.has(code)) {
        return { status: 200, arrayBuffer: async () => fixtureBytesForCode(code) };
      }
      return { status: 404 };
    } finally {
      activeFiles -= 1;
    }
  };
  return {
    fetchImpl,
    calls,
    get maxActiveProbes() {
      return maxActiveProbes;
    },
    get maxActiveFiles() {
      return maxActiveFiles;
    }
  };
}

function largeExists(count = 597) {
  const exists = new Set();
  for (let i = 0; i <= count - 1; i += 1) exists.add('159' + String(i).padStart(3, '0'));
  exists.add('159632');
  exists.add('159659');
  exists.add('159941');
  return exists;
}

// 组合 mock：同一 fetchImpl 同时服务上交所清单 URL 与深交所探测/文件 URL。
// 统一记录调用顺序（seq 全局递增，供阶段顺序断言），并跟踪 SSE 阶段外部并发峰值。
// sseBehavior：code → 'not_found' | 'empty' | 'corrupt'（缺省返回真实 fixture）。
function createCombinedMock(
  { exists = new Set(), probeBehavior = new Map(), fileBehavior = new Map() } = {},
  sseBehavior = new Map()
) {
  const pipeline = createPipelineMock({ exists, probeBehavior, fileBehavior });
  const calls = [];
  let activeSse = 0;
  let maxActiveSse = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const seq = calls.length + 1;
    if (u.includes('/api/report/ShowReport?')) {
      calls.push({ seq, url: u, method: 'GET', market: 'shares', init });
      return { status: 404 };
    }
    if (u.includes('sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L')) {
      calls.push({ seq, url: u, method: 'GET', market: 'sse_shares', init });
      return { status: 404, body: null };
    }
    if (u.startsWith(SSE_URL_PREFIX)) {
      const code = u.slice(SSE_URL_PREFIX.length).split('&')[0];
      activeSse += 1;
      maxActiveSse = Math.max(maxActiveSse, activeSse);
      calls.push({ seq, url: u, method: 'GET', market: 'sse', code, init });
      try {
        const mode = sseBehavior.get(code);
        if (mode === 'not_found') return { status: 404 };
        if (mode === 'empty') return { status: 200, arrayBuffer: async () => new Uint8Array(0) };
        if (mode === 'corrupt') {
          return { status: 200, arrayBuffer: async () => new TextEncoder().encode('cb({broken);') };
        }
        return { status: 200, arrayBuffer: async () => new TextEncoder().encode(SSE_FIXTURES.get(code)) };
      } finally {
        activeSse -= 1;
      }
    }
    calls.push({ seq, url: u, method: init.method || 'GET', market: 'szse' });
    return pipeline.fetchImpl(url, init);
  };
  return {
    fetchImpl,
    calls,
    pipeline,
    get maxActiveSse() {
      return maxActiveSse;
    }
  };
}

test.beforeEach(() => {
  clearEtfPcfRuntimeStateForTests();
  clearSsePcfRuntimeStateForTests();
  globalThis.fetch = async () => { throw new Error('offline test'); };
});
test.afterEach(() => { globalThis.fetch = originalGlobalFetch; });

// ─── runEtfPcfScheduledRefresh 全流程 ─────────────────────────────

test('全量刷新：1000 探测 + 600 项名单，两阶段顺序、并发 ≤5、KV 写入与统计一致', async () => {
  const exists = largeExists(597);
  assert.equal(exists.size, 600);
  const mock = createPipelineMock({ exists });
  const kv = new FakeKV();

  const result = await runEtfPcfScheduledRefresh({ env: { FUND_LIMIT_KV: kv }, scheduledTime: SCHEDULED_MS, fetchImpl: mock.fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.degraded, false);
  assert.equal(result.date, DATE_KEY);
  assert.equal(result.fallbackStatus, null);
  assert.equal(result.universeSourceAge, null);

  // 探测阶段统计（合计 = 1000）。
  assert.equal(result.probeTotal, 1000);
  assert.equal(result.probeExists, 600);
  assert.equal(result.probeNotFound, 400);
  assert.equal(result.probeFailed, 0);
  assert.equal(result.probeSkippedDeadline, 0);
  assert.equal(result.probeExists + result.probeNotFound + result.probeFailed + result.probeSkippedDeadline, 1000);

  // 抓取阶段统计（合计 = total）。
  assert.equal(result.total, 600);
  assert.equal(result.success, 600);
  assert.equal(result.notFound, 0);
  assert.equal(result.fetchFailed, 0);
  assert.equal(result.parseFailed, 0);
  assert.equal(result.kvWriteFailed, 0);
  assert.equal(result.skippedDeadline, 0);
  assert.deepEqual(result.failures, []);

  // 冷启动：全部为新增，无消失/移除。
  assert.equal(result.addedCodes.length, 600);
  assert.deepEqual(result.missingCodes, []);
  assert.deepEqual(result.removedCodes, []);
  assert.equal(result.universeWrite, 'updated');

  // 两阶段顺序：全部 HEAD 探测先于任何文件 GET。
  const maxHeadSeq = Math.max(...mock.calls.filter((c) => c.method === 'HEAD').map((c) => c.seq));
  const minGetSeq = Math.min(...mock.calls.filter((c) => c.method === 'GET').map((c) => c.seq));
  assert.ok(maxHeadSeq < minGetSeq, '探测阶段必须先于抓取阶段完成');
  assert.equal(mock.calls.length, 1600);
  assert.ok(mock.maxActiveProbes <= 5, '探测并发 max=' + mock.maxActiveProbes);
  assert.ok(mock.maxActiveFiles <= 5, '抓取并发 max=' + mock.maxActiveFiles);

  // KV 写入：600 个结果 key + 1 个名单 key。
  const resultPuts = kv.putCalls.filter((p) => p.key.startsWith('etf-pcf:'));
  assert.equal(resultPuts.length, 600);
  for (const put of resultPuts) {
    assert.equal(put.options.expirationTtl, 86400);
    assert.match(put.key, /^etf-pcf:159\d{3}:20261013$/);
    const data = JSON.parse(put.value);
    assert.equal(data.date, DATE_KEY);
    assert.equal(data.code, put.key.split(':')[1]);
    assert.equal(data.fetchedAt, new Date(SCHEDULED_MS).toISOString());
    assert.equal(data.expiresAt, new Date(SCHEDULED_MS + 86400 * 1000).toISOString());
    assert.equal(data.netSubscribeLimitShares, 1300000);
    assert.equal(data.fundName, '纳指ETF广发');
  }
  const universePuts = kv.putCalls.filter((p) => p.key === ETF_PCF_UNIVERSE_KEY);
  assert.equal(universePuts.length, 1);
  const universe = JSON.parse(universePuts[0].value);
  assert.equal(universe.total, 600);
  assert.equal(universe.lastProbeDate, DATE_KEY);
  assert.equal(new Set(universe.codes).size, 600);
});

test('scheduledTime 换算上海业务日期：UTC 前一日 16:30 → 上海当日', async () => {
  const mock = createPipelineMock({ exists: new Set(['159941']) });
  const kv = new FakeKV();
  // 2026-10-12 16:30 UTC = 上海 2026-10-13 00:30。
  const result = await runEtfPcfScheduledRefresh({
    env: { FUND_LIMIT_KV: kv },
    scheduledTime: Date.UTC(2026, 9, 12, 16, 30, 0),
    fetchImpl: mock.fetchImpl
  });
  assert.equal(result.date, '2026-10-13');
  assert.equal(result.probeExists, 1);
  assert.equal(result.success, 1);
  assert.ok(mock.calls.every((c) => c.url.includes('20261013')));
});

test('单项失败隔离：404/超时/坏字节/KV 写失败不拖垮其它项，发现身份保留', async () => {
  const mock = createPipelineMock({
    exists: new Set(['159941', '159632', '159659', '159650', '159700']),
    fileBehavior: new Map([
      ['159632', 'not_found'],
      ['159659', 'timeout'],
      ['159650', 'corrupt']
    ])
  });
  const kv = new FakeKV();
  kv.putImpl = async (key) => {
    if (key === 'etf-pcf:159700:20261013') throw new Error('kv write down');
    kv.store.set(key, kv.putCalls[kv.putCalls.length - 1].value);
  };
  const result = await runEtfPcfScheduledRefresh({
    env: { FUND_LIMIT_KV: kv },
    scheduledTime: SCHEDULED_MS,
    fetchImpl: mock.fetchImpl,
    timeoutMs: 25
  });

  assert.equal(result.ok, true);
  assert.equal(result.probeExists, 5);
  assert.equal(result.total, 5);
  assert.equal(result.success, 1);
  assert.equal(result.notFound, 1);
  assert.equal(result.fetchFailed, 1);
  assert.equal(result.parseFailed, 1);
  assert.equal(result.kvWriteFailed, 1);
  assert.equal(result.skippedDeadline, 0);
  assert.equal(result.success + result.notFound + result.fetchFailed + result.parseFailed + result.kvWriteFailed, 5);

  // 404 属正常分类不计入 failures；三类失败各自隔离。
  const failureCodes = result.failures.map((f) => f.code).sort();
  assert.deepEqual(failureCodes, ['159650', '159659', '159700']);

  // 探测到但抓取/解析失败的 code 仍保留发现身份，不从名单移除。
  const universePuts = kv.putCalls.filter((p) => p.key === ETF_PCF_UNIVERSE_KEY);
  assert.equal(universePuts.length, 1);
  const universe = JSON.parse(universePuts[0].value);
  assert.equal(universe.total, 5);
  for (const code of ['159941', '159632', '159659', '159650', '159700']) {
    assert.ok(universe.codes.includes(code), code);
  }
  // 只有 159941 成功写入结果 KV。
  const resultPuts = kv.putCalls.filter((p) => p.key.startsWith('etf-pcf:') && p.key !== 'etf-pcf:159700:20261013');
  assert.deepEqual(resultPuts.map((p) => p.key), ['etf-pcf:159941:20261013']);
  assert.equal(kv.store.has('etf-pcf:159700:20261013'), false);
});

test('瞬态 500 重试一次成功，404 不重试；批量刷新不读名单缓存', async () => {
  const codes = [];
  for (let i = 0; i < 11; i += 1) codes.push('159' + String(i).padStart(3, '0'));
  const mock = createPipelineMock({
    exists: new Set(codes),
    fileBehavior: new Map([
      ['159000', '500_once'],
      ['159001', 'not_found']
    ])
  });
  const kv = new FakeKV();
  const result = await refreshEtfPcfLimitCache({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, codes, fetchImpl: mock.fetchImpl, timeoutMs: 25 });

  assert.equal(result.ok, true);
  assert.equal(result.stats.total, 11);
  assert.equal(result.stats.success, 10);
  assert.equal(result.stats.notFound, 1);
  assert.equal(result.universeSourceAge, null);
  // 500 重试一次后成功（2 次调用），404 不重试（1 次调用）。
  assert.equal(mock.calls.filter((c) => c.code === '159000').length, 2);
  assert.equal(mock.calls.filter((c) => c.code === '159001').length, 1);
  // 显式 codes 时按 code 去重排序后执行。
  assert.equal(kv.putCalls.filter((p) => p.key.startsWith('etf-pcf:')).length, 10);
});

test('请求预算耗尽：抓取阶段停止分配并计入 skippedDeadline，统计仍闭合', async () => {
  const exists = largeExists(597);
  const mock = createPipelineMock({ exists });
  const kv = new FakeKV();
  const result = await runEtfPcfScheduledRefresh({
    env: { FUND_LIMIT_KV: kv },
    scheduledTime: SCHEDULED_MS,
    fetchImpl: mock.fetchImpl,
    requestLimit: 1010
  });

  assert.equal(result.ok, true);
  assert.equal(result.probeTotal, 1000);
  assert.equal(result.probeExists, 600);
  assert.equal(result.total, 600);
  assert.equal(result.success, 10);
  assert.equal(result.skippedDeadline, 590);
  assert.equal(result.success + result.skippedDeadline, 600);
  assert.equal(mock.calls.filter((c) => c.method === 'GET').length, 10);
});

test('软 deadline 为零：探测全部跳过、不降级、不写任何 KV', async () => {
  const mock = createPipelineMock({ exists: new Set(['159941']) });
  const kv = new FakeKV();
  const result = await runEtfPcfScheduledRefresh({
    env: { FUND_LIMIT_KV: kv },
    scheduledTime: SCHEDULED_MS,
    fetchImpl: mock.fetchImpl,
    deadlineMs: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'universe_discovery_incomplete');
  assert.equal(result.probeSkippedDeadline, 1000);
  assert.equal(result.degraded, false);
  assert.equal(result.fallbackStatus, 'skipped_no_budget');
  assert.equal(result.total, 0);
  assert.equal(mock.calls.length, 0);
  assert.equal(kv.putCalls.length, 0);
});

test('发现未完成时降级使用 7 天内旧名单，且不重写名单', async () => {
  const seededFetchedAt = new Date(Date.now() - 3600 * 1000).toISOString();
  const kv = new FakeKV(
    new Map([
      [
        ETF_PCF_UNIVERSE_KEY,
        JSON.stringify({
          schemaVersion: 1,
          source: 'szse_pcf_probe',
          codes: ['159941'],
          total: 1,
          fetchedAt: seededFetchedAt,
          lastProbeDate: '2026-10-12',
          entries: { '159941': { lastSeenDate: '2026-10-12', missingCount: 0 } }
        })
      ]
    ])
  );
  // 一个 code 的探测持续 500 → 发现未完成；159941 仅存在于旧名单（file_ok 提供文件）。
  const mock = createPipelineMock({
    exists: new Set(),
    probeBehavior: new Map([['159900', 'probe_500']]),
    fileBehavior: new Map([['159941', 'file_ok']])
  });
  const result = await runEtfPcfScheduledRefresh({ env: { FUND_LIMIT_KV: kv }, scheduledTime: SCHEDULED_MS, fetchImpl: mock.fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.fallbackStatus, 'used_kv_universe');
  assert.equal(result.probeFailed, 1);
  assert.equal(result.total, 1);
  assert.equal(result.success, 1);
  assert.ok(Math.abs(result.universeSourceAge - 3600 * 1000) < 5000, 'universeSourceAge=' + result.universeSourceAge);
  // 名单未被部分发现覆盖。
  assert.equal(kv.putCalls.filter((p) => p.key === ETF_PCF_UNIVERSE_KEY).length, 0);
  const resultPuts = kv.putCalls.filter((p) => p.key.startsWith('etf-pcf:'));
  assert.deepEqual(resultPuts.map((p) => p.key), ['etf-pcf:159941:20261013']);
});

test('降级但旧名单超龄：报告失败而不是用部分发现冒充', async () => {
  const kv = new FakeKV(
    new Map([
      [
        ETF_PCF_UNIVERSE_KEY,
        JSON.stringify({
          schemaVersion: 1,
          source: 'szse_pcf_probe',
          codes: ['159941'],
          total: 1,
          fetchedAt: new Date(Date.now() - 8 * 86400 * 1000).toISOString(),
          lastProbeDate: '2026-10-05',
          entries: { '159941': { lastSeenDate: '2026-10-05', missingCount: 0 } }
        })
      ]
    ])
  );
  const mock = createPipelineMock({
    exists: new Set(),
    probeBehavior: new Map([['159900', 'probe_500']])
  });
  const result = await runEtfPcfScheduledRefresh({ env: { FUND_LIMIT_KV: kv }, scheduledTime: SCHEDULED_MS, fetchImpl: mock.fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'universe_discovery_incomplete');
  assert.equal(result.degraded, false);
  assert.equal(result.fallbackStatus, 'kv_universe_unavailable:expired');
  assert.equal(result.total, 0);
  assert.equal(kv.putCalls.length, 0);
});

test('scheduledTime 非法：显式报告 invalid_scheduled_time', async () => {
  const result = await runEtfPcfScheduledRefresh({ env: { FUND_LIMIT_KV: new FakeKV() }, scheduledTime: Number.NaN });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_scheduled_time');
  assert.equal(result.date, null);
});

// ─── index.js cron 分发与 09:00 组合刷新 ──────────────────────────

test('新 cron 0 1 * * * 经 index 分发：先上交所 5 只刷新，再深交所全量', async () => {
  const mock = createCombinedMock({ exists: new Set(['159941']) });
  const kv = new FakeKV();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fetchImpl;
  try {
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    await worker.scheduled({ cron: '0 1 * * *', scheduledTime: SCHEDULED_MS }, { FUND_LIMIT_KV: kv }, ctx);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // SSE 阶段：恰好 5 只各一次外部请求（无探测、无重试），全部带 Referer，并发 ≤2。
  const sseCalls = mock.calls.filter((c) => c.market === 'sse');
  assert.equal(sseCalls.length, 5);
  assert.deepEqual(
    sseCalls.map((c) => c.code).sort(),
    [...SSE_PCF_CODES].sort()
  );
  for (const call of sseCalls) {
    assert.equal(call.init.headers.Referer, SSE_REFERER);
    // Workers 运行时不支持 redirect:'error'，必须传 'manual' 并显式拒绝 3xx。
    assert.equal(call.init.redirect, 'manual');
  }
  assert.ok(mock.maxActiveSse <= 2, 'SSE 并发 max=' + mock.maxActiveSse);

  // SSE 结果：清单日期（TRADING_DAY）入 key，TTL 24h，时间戳来自 scheduledTime。
  for (const code of SSE_PCF_CODES) {
    const puts = kv.putCalls.filter((p) => p.key === 'etf-pcf:' + code + ':20261013');
    assert.equal(puts.length, 1, code);
    assert.equal(puts[0].options.expirationTtl, 86400, code);
    const data = JSON.parse(puts[0].value);
    assert.equal(data.source, 'sse_pcf', code);
    assert.equal(data.tradingDay, '20261013', code);
    assert.equal(data.fetchedAt, new Date(SCHEDULED_MS).toISOString(), code);
  }
  // 513100 口径抽查：仅允许赎回，但累计 2500000 保留，净申购 unlimited。
  const data513100 = JSON.parse(kv.store.get('etf-pcf:513100:20261013'));
  assert.equal(data513100.subscriptionAllowed, false);
  assert.equal(data513100.redemptionAllowed, true);
  assert.equal(data513100.totalSubscribeLimitShares, 2500000);
  assert.equal(data513100.netSubscribeLimitShares, null);
  assert.equal(data513100.netSubscribeLimitKind, 'unlimited');

  // 深交所阶段照常：1000 探测 + 1 文件，结果与名单写入。
  const szseCalls = mock.calls.filter((c) => c.market === 'szse');
  assert.equal(szseCalls.filter((c) => c.method === 'HEAD').length, 1000);
  assert.equal(szseCalls.filter((c) => c.method === 'GET').length, 1);
  const sharesCalls = mock.calls.filter((c) => c.market === 'shares');
  assert.equal(sharesCalls.length, 2);
  assert.equal(new URL(sharesCalls[1].url).searchParams.get('txtEnd'), DATE_KEY);
  assert.ok(Math.max(...szseCalls.map((c) => c.seq)) < Math.min(...sharesCalls.map((c) => c.seq)));
  // +2：上交所 ETF 规模接口取 T-1/T-2 两日 513 份额。
  assert.equal(mock.calls.filter((c) => c.market === 'sse_shares').length, 2);
  assert.equal(mock.calls.length, 1010);
  assert.ok(kv.store.has('etf-pcf:159941:20261013'));
  assert.ok(kv.store.has(ETF_PCF_UNIVERSE_KEY));

  // 阶段顺序：全部 SSE 调用先于任何深交所调用（两阶段不重叠）。
  const maxSseSeq = Math.max(...sseCalls.map((c) => c.seq));
  const minSzseSeq = Math.min(...szseCalls.map((c) => c.seq));
  assert.ok(maxSseSeq < minSzseSeq, 'SSE 阶段必须先于深交所阶段');
});

test('runEtfPcfDailyRefresh：SSE 单项失败隔离、重试记账、分类合计 5；scheduledTime 透传', async () => {
  // 513110 上游 404（不重试）；513300 空响应（瞬态，3 次耗尽 → fetchFailed）；其余成功。
  const mock = createCombinedMock({}, new Map([['513110', 'not_found'], ['513300', 'empty']]));
  const kv = new FakeKV();
  let szseArgs = null;
  const result = await runEtfPcfDailyRefresh({
    env: { FUND_LIMIT_KV: kv },
    // 上海 2026-10-14 09:00，但源站清单 TRADING_DAY 仍是 20261013。
    scheduledTime: Date.UTC(2026, 9, 14, 1, 0, 0),
    sseRefresh: (args) => refreshSsePcfLimitCache({ ...args, fetchImpl: mock.fetchImpl }),
    szseRefresh: async (args) => {
      szseArgs = args;
      return { ok: true };
    }
  });

  assert.equal(result.sse.ok, true);
  const stats = result.sse.stats;
  assert.equal(stats.total, 5);
  assert.equal(stats.success, 3);
  assert.equal(stats.notFound, 1);
  assert.equal(stats.fetchFailed, 1);
  assert.equal(stats.parseFailed, 0);
  assert.equal(stats.kvWriteFailed, 0);
  assert.equal(stats.skippedDeadline, 0);
  assert.equal(
    stats.success + stats.notFound + stats.fetchFailed + stats.parseFailed + stats.kvWriteFailed + stats.skippedDeadline,
    5
  );
  // 404 不重试（1 次），空响应 3 次耗尽；成功 3 只各 1 次。
  assert.equal(stats.attempts, 7);
  assert.equal(stats.retries, 2);
  assert.deepEqual(result.sse.failures, [
    { code: '513300', bucket: 'fetchFailed', reason: 'empty_response', attempts: 3 }
  ]);
  assert.equal(mock.calls.filter((c) => c.market === 'sse' && c.code === '513110').length, 1);
  assert.equal(mock.calls.filter((c) => c.market === 'sse' && c.code === '513300').length, 3);

  // scheduledTime 是上海 10-14，但写入 key 一律用接口清单日 20261013。
  for (const code of ['513100', '513390', '513870']) {
    assert.ok(kv.store.has('etf-pcf:' + code + ':20261013'), code);
  }
  assert.equal(kv.store.has('etf-pcf:513110:20261013'), false);
  assert.equal(kv.store.has('etf-pcf:513300:20261013'), false);
  assert.equal(kv.store.has('etf-pcf:513300:20261014'), false);

  // 深交所阶段收到原样 env 与 scheduledTime。
  assert.equal(szseArgs.scheduledTime, Date.UTC(2026, 9, 14, 1, 0, 0));
  assert.equal(szseArgs.env.FUND_LIMIT_KV, kv);
  // 组合任务时长记账。
  assert.ok(Number.isFinite(result.jobDurationMs));
});

test('阶段异常隔离：SSE 阶段抛错仍执行深交所；深交所阶段抛错不丢已完成 SSE', async () => {
  const kv = new FakeKV();
  const sseBoom = await runEtfPcfDailyRefresh({
    env: { FUND_LIMIT_KV: kv },
    scheduledTime: SCHEDULED_MS,
    sseRefresh: async () => {
      throw new Error('sse stage boom');
    },
    szseRefresh: (args) =>
      runEtfPcfScheduledRefresh({ ...args, fetchImpl: createPipelineMock({ exists: new Set(['159941']) }).fetchImpl })
  });
  assert.equal(sseBoom.sse.ok, false);
  assert.equal(sseBoom.sse.reason, 'sse_stage_error');
  // SSE 抛错不阻断深交所：探测、结果与名单照常写入。
  assert.equal(sseBoom.szse.ok, true);
  assert.ok(kv.store.has('etf-pcf:159941:20261013'));
  assert.ok(kv.store.has(ETF_PCF_UNIVERSE_KEY));

  const kv2 = new FakeKV();
  const szseBoom = await runEtfPcfDailyRefresh({
    env: { FUND_LIMIT_KV: kv2 },
    scheduledTime: SCHEDULED_MS,
    sseRefresh: (args) => refreshSsePcfLimitCache({ ...args, fetchImpl: createCombinedMock().fetchImpl }),
    szseRefresh: async () => {
      throw new Error('szse stage boom');
    }
  });
  assert.equal(szseBoom.szse.ok, false);
  assert.equal(szseBoom.szse.reason, 'szse_stage_error');
  // 深交所抛错不丢失已完成的 SSE 结果。
  assert.equal(szseBoom.sse.ok, true);
  for (const code of SSE_PCF_CODES) {
    assert.ok(kv2.store.has('etf-pcf:' + code + ':20261013'), code);
  }
  assert.ok(Number.isFinite(szseBoom.jobDurationMs));
});

test('SSE 阶段软预算到期：5 只全部 skippedDeadline、无外部请求；深交所照常', async () => {
  const mock = createCombinedMock({ exists: new Set(['159941']) });
  const kv = new FakeKV();
  const result = await runEtfPcfDailyRefresh({
    env: { FUND_LIMIT_KV: kv },
    scheduledTime: SCHEDULED_MS,
    sseDeadlineMs: 0,
    sseRefresh: (args) => refreshSsePcfLimitCache({ ...args, fetchImpl: mock.fetchImpl }),
    szseRefresh: (args) => runEtfPcfScheduledRefresh({ ...args, fetchImpl: mock.fetchImpl })
  });
  const stats = result.sse.stats;
  assert.equal(stats.total, 5);
  assert.equal(stats.skippedDeadline, 5);
  assert.equal(stats.success + stats.notFound + stats.fetchFailed + stats.parseFailed + stats.kvWriteFailed, 0);
  assert.equal(stats.attempts, 0);
  assert.equal(mock.calls.filter((c) => c.market === 'sse').length, 0);
  assert.equal(kv.putCalls.filter((p) => p.key.startsWith('etf-pcf:51')).length, 0);
  // SSE 预算不延长/不影响深交所阶段。
  assert.equal(result.szse.ok, true);
  assert.ok(kv.store.has('etf-pcf:159941:20261013'));
  assert.ok(kv.store.has(ETF_PCF_UNIVERSE_KEY));
});

test('scheduledTime 非法：两阶段均不执行、不产生外部请求或 KV 访问', async () => {
  const mock = createCombinedMock({ exists: new Set(['159941']) });
  const kv = new FakeKV();
  const result = await runEtfPcfDailyRefresh({
    env: { FUND_LIMIT_KV: kv },
    scheduledTime: Number.NaN,
    sseRefresh: (args) => refreshSsePcfLimitCache({ ...args, fetchImpl: mock.fetchImpl }),
    szseRefresh: (args) => runEtfPcfScheduledRefresh({ ...args, fetchImpl: mock.fetchImpl })
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_scheduled_time');
  assert.equal(result.sse.reason, 'invalid_scheduled_time');
  assert.equal(result.szse.reason, 'invalid_scheduled_time');
  assert.equal(mock.calls.length, 0);
  assert.equal(kv.getCalls.length, 0);
  assert.equal(kv.putCalls.length, 0);
});

test('旧 cron 0 12 * * * 保持原顺序：只刷场外限额与 overview，不触发 ETF', async () => {
  const events = [];
  const kv = {
    FUND_LIMIT_KV: {
      get: async (key) => {
        events.push({ type: 'get', key });
        return null;
      },
      put: async (key) => {
        events.push({ type: 'put', key });
        return true;
      }
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    events.push({ type: 'fetch', url: String(url) });
    throw new Error('offline');
  };
  try {
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    await worker.scheduled({ cron: '0 12 * * *', scheduledTime: SCHEDULED_MS }, kv, ctx);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const fetches = events.filter((e) => e.type === 'fetch');
  assert.ok(fetches.length > 0, '旧 cron 应执行场外限额刷新（此处全部离线失败）');
  // 不触发任何深交所 ETF 探测/抓取，也不碰 ETF 的 KV key。
  assert.equal(fetches.filter((e) => e.url.includes('reportdocs.static.szse.cn')).length, 0);
  assert.equal(events.filter((e) => (e.key || '').startsWith('etf-pcf')).length, 0);

  // 顺序保持：所有 overview 写入都发生在最后一场外部请求之后。
  const indexed = events.map((e, i) => ({ ...e, i }));
  const lastFetchIndex = Math.max(...indexed.filter((e) => e.type === 'fetch').map((e) => e.i));
  const overviewPuts = indexed.filter((e) => e.type === 'put' && e.key.startsWith('limit-overview'));
  assert.ok(overviewPuts.length >= 1, 'overview 快照应写入 KV');
  for (const put of overviewPuts) {
    assert.ok(put.i > lastFetchIndex, 'overview 写入必须晚于全部场外限额抓取');
  }
});

test('未识别 cron 不做任何事', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('offline');
  };
  try {
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    const kv = new FakeKV();
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: SCHEDULED_MS }, { FUND_LIMIT_KV: kv }, ctx);
    assert.equal(pending.length, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(kv.getCalls.length, 0);
    assert.equal(kv.putCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('event stage after PCF, successful target collection only; failure isolated from both markets',async()=>{
 const kv=new FakeKV(),order=[];let received;
 const result=await runEtfPcfDailyRefresh({env:{FUND_LIMIT_KV:kv},scheduledTime:SCHEDULED_MS,
  sseRefresh:async()=>{order.push('sse');return {ok:true};},
  szseRefresh:async args=>{order.push('szse');args.onSuccess({code:'159659',date:DATE_KEY});args.onSuccess({code:'513100',date:DATE_KEY});return {ok:true};},
  eventsRefresh:async args=>{order.push('events');received=args;throw Error('synthetic event failure');}});
 assert.deepEqual(order,['sse','szse','events']);assert.deepEqual(received.pcfs,[{code:'159659',date:DATE_KEY}]);assert.equal(received.scheduledTime,SCHEDULED_MS);assert.equal(result.events.reason,'events_stage_error');assert.equal(result.szse.ok,true);assert.equal(result.sse.ok,true);
});
test('onSuccess exceptions cannot change PCF success/TTL; failed PCF puts are not collected',async()=>{
 const kv=new FakeKV(),mock=createPipelineMock({exists:new Set(['159941','159659'])});const collected=[];
 kv.putImpl=async(key,value)=>{if(key.includes('159659'))throw Error('synthetic failed put');kv.store.set(key,value);};
 const r=await refreshEtfPcfLimitCache({env:{FUND_LIMIT_KV:kv},date:DATE_KEY,codes:['159941','159659'],now:new Date(SCHEDULED_MS),fetchImpl:mock.fetchImpl,onSuccess:data=>{collected.push(data);throw Error('synthetic callback');}});
 assert.equal(r.stats.success,1);assert.equal(r.stats.kvWriteFailed,1);assert.equal(collected.length,1);assert.equal(collected[0].code,'159941');assert.equal(kv.putCalls.find(p=>p.key.includes('159941')).options.expirationTtl,86400);
});
