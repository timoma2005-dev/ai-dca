// /api/etf-pcf-limit 路由测试：GET 只读缓存（任何 refresh/force 开关都不触发外部请求）、
// POST 单 code 手动刷新、code 前缀分发（159xxx 深交所 / 冻结名单 51xxxx 上交所 /
// 名单外 51xxxx → 404 / 其余 400）、全状态码与参数防御。
// 全部使用 mock fetch + fake KV，离线运行。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleEtfPcfLimit } from '../workers/ocr-proxy/src/etfPcfRoutes.js';
import { clearEtfPcfRuntimeStateForTests } from '../workers/ocr-proxy/src/etfPcfLimit.js';
import { SSE_PCF_CODES, clearSsePcfRuntimeStateForTests } from '../workers/ocr-proxy/src/ssePcfLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BYTES = new Uint8Array(
  readFileSync(path.join(__dirname, 'fixtures/etf-pcf/ETF15994120261013.gbk.txt'))
);
// 上海 2026-10-13 10:00：默认日期为 2026-10-13，2026-10-14 属未来日期。
const NOW = new Date('2026-10-13T02:00:00.000Z');

// 上交所 2026-10-13 五只真实脱敏 fixture（纯 JSON，解析器兼容 callback 包裹）。
const SSE_FIXTURES = new Map();
for (const code of SSE_PCF_CODES) {
  SSE_FIXTURES.set(
    code,
    readFileSync(path.join(__dirname, 'fixtures/etf-pcf-sse', `SSE${code}20261013.json`), 'utf8')
  );
}
const SSE_URL = (code) =>
  'https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=' +
  code +
  '&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C';

beforeEach(() => {
  clearEtfPcfRuntimeStateForTests();
  clearSsePcfRuntimeStateForTests();
});

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

function makeCachedData(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'szse_pcf',
    code: '159941',
    date: '2026-10-13',
    fundName: '纳指ETF广发',
    fundType: '跨境ETF',
    fundManager: '广发基金管理有限公司',
    targetIndexCode: 'NDX',
    netSubscribeLimitShares: 1300000,
    netSubscribeLimitKind: 'limited',
    netRedeemLimitShares: 1000000000,
    netRedeemLimitKind: 'limited',
    accountNetSubscribeLimitShares: null,
    accountNetSubscribeLimitKind: 'unlimited',
    accountNetRedeemLimitShares: null,
    accountNetRedeemLimitKind: 'unlimited',
    totalSubscribeLimitShares: null,
    totalSubscribeLimitKind: 'unlimited',
    totalRedeemLimitShares: null,
    totalRedeemLimitKind: 'unlimited',
    accountTotalSubscribeLimitShares: 1300000,
    accountTotalSubscribeLimitKind: 'limited',
    accountTotalRedeemLimitShares: null,
    accountTotalRedeemLimitKind: 'unlimited',
    creationRedemptionUnitShares: 1300000,
    subscriptionAllowed: true,
    redemptionAllowed: true,
    estimatedCashDifference: 4275.36,
    cashSubstitutionRatioLimitPct: 100,
    iopvRequired: true,
    unitCashDividend: 0,
    localBasketSecurityCount: 1,
    totalBasketSecurityCount: 102,
    rawFields: {},
    basicRawFields: {},
    warnings: [],
    sourceUrl: 'https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt',
    fetchedAt: '2026-10-13T01:00:00.000Z',
    expiresAt: '2026-10-14T01:00:00.000Z',
    ...overrides
  };
}

function seededKV(data = makeCachedData()) {
  return new FakeKV(new Map([['etf-pcf:159941:20261013', JSON.stringify(data)]]));
}

// 上交所 513300 的有效缓存形态（值来自 2026-10-13 真实 fixture，net 3750000 只进净额）。
function makeSseCachedData(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'sse_pcf',
    code: '513300',
    tradingDay: '20261013',
    date: '2026-10-13',
    fundName: '华夏纳斯达克100交易型开放式指数证券投资基金（QDII）',
    fundManager: '华夏基金管理有限公司',
    creationRedemption: '申购和赎回皆允许',
    subscriptionAllowed: true,
    redemptionAllowed: true,
    totalSubscribeLimitShares: null,
    totalSubscribeLimitKind: 'unlimited',
    netSubscribeLimitShares: 3750000,
    netSubscribeLimitKind: 'limited',
    accountTotalSubscribeLimitShares: null,
    accountTotalSubscribeLimitKind: 'unlimited',
    totalRedeemLimitShares: null,
    totalRedeemLimitKind: 'unlimited',
    netRedeemLimitShares: 100000000,
    netRedeemLimitKind: 'limited',
    accountTotalRedeemLimitShares: null,
    accountTotalRedeemLimitKind: 'unlimited',
    accountNetSubscribeLimitShares: null,
    accountNetSubscribeLimitKind: 'unknown',
    accountNetRedeemLimitShares: null,
    accountNetRedeemLimitKind: 'unknown',
    creationRedemptionUnitShares: 750000,
    estimatedCashDifference: 818.37,
    cashSubstitutionRatioLimitPct: 100,
    iopvRequired: true,
    navPerCreationUnit: 1929361.85,
    nav: 2.5725,
    rawFields: {},
    warnings: [],
    sourceUrl: SSE_URL('513300'),
    fetchedAt: '2026-10-13T01:00:00.000Z',
    expiresAt: '2026-10-14T01:00:00.000Z',
    ...overrides
  };
}

const sseFixtureOk = (code) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(SSE_FIXTURES.get(code)) });

const BASE = 'https://example.test/api/etf-pcf-limit';

function getRoute(t, env, params, now = NOW) {
  const mocked = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('该请求不应触发外部请求');
  });
  const request = new Request(BASE + (params ? '?' + params : ''));
  return {
    fetchMock: mocked,
    response: handleEtfPcfLimit(request, env, {}, params ? new URLSearchParams(params) : new URLSearchParams(), now)
  };
}

function postRoute(t, env, body, fetchImpl, now = NOW) {
  const mocked = t.mock.method(
    globalThis,
    'fetch',
    fetchImpl ||
      (async () => ({
        status: 200,
        arrayBuffer: async () => FIXTURE_BYTES
      }))
  );
  const options = { method: 'POST' };
  if (body !== undefined) options.body = typeof body === 'string' ? body : JSON.stringify(body);
  const request = new Request(BASE, options);
  return {
    fetchMock: mocked,
    response: handleEtfPcfLimit(request, env, {}, new URLSearchParams(), now)
  };
}

// ─── GET：只读缓存 ────────────────────────────────────────────────

test('GET 命中缓存返回 200 + cached:true，不做外部请求', async (t) => {
  const { fetchMock, response } = getRoute(t, { FUND_LIMIT_KV: seededKV() }, 'code=159941');
  const result = await response;
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.cached, true);
  assert.equal(body.code, '159941');
  assert.equal(body.fundName, '纳指ETF广发');
  assert.equal(body.netSubscribeLimitShares, 1300000);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('GET 缓存缺失/过期返回 404，携带 refresh=1/force=1 也不抓上游', async (t) => {
  const kv = new FakeKV();
  const miss = await getRoute(t, { FUND_LIMIT_KV: kv }, 'code=159941').response;
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).reason, 'cache_miss');

  const withForce = await getRoute(t, { FUND_LIMIT_KV: kv }, 'code=159941&force=1&refresh=1').response;
  assert.equal(withForce.status, 404);
  assert.equal((await withForce.json()).reason, 'cache_miss');

  const expired = await getRoute(
    t,
    { FUND_LIMIT_KV: seededKV(makeCachedData({ expiresAt: '2026-10-13T01:30:00.000Z' })) },
    'code=159941&refresh=1'
  ).response;
  assert.equal(expired.status, 404);
  assert.equal((await expired.json()).reason, 'cache_miss');
});

test('GET 命中时携带 force=1 仍只返回缓存，不刷新', async (t) => {
  const { fetchMock, response } = getRoute(t, { FUND_LIMIT_KV: seededKV() }, 'code=159941&force=1');
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal((await result.json()).cached, true);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('GET 参数防御：缺 code/非法 code/非法日期/未来日期/重复 query 均 400', async (t) => {
  const cases = [
    ['', 'missing_code'],
    ['code=', 'missing_code'],
    ['code=15941', 'invalid_code'],
    ['code=159941.SZ', 'invalid_code'],
    ['code=000834', 'invalid_code'],
    ['code=159941&date=2026-02-30', 'invalid_date'],
    ['code=159941&date=2026/10/13', 'invalid_date'],
    ['code=159941&date=', 'invalid_date'],
    ['code=159941&date=2026-10-14', 'invalid_date'],
    ['code=159941&code=159941', 'duplicate_query_param'],
    ['code=159941&date=2026-10-13&date=2026-10-13', 'duplicate_query_param']
  ];
  for (const [params, reason] of cases) {
    const kv = new FakeKV();
    const { fetchMock, response } = getRoute(t, { FUND_LIMIT_KV: kv }, params);
    const result = await response;
    assert.equal(result.status, 400, params);
    assert.equal((await result.json()).reason, reason, params);
    assert.equal(kv.getCalls.length, 0, params);
    assert.equal(kv.putCalls.length, 0, params);
    assert.equal(fetchMock.mock.calls.length, 0, params);
  }
});

test('GET date 缺省上海当天：UTC 16:00 跨日', async (t) => {
  const beforeMidnight = new FakeKV();
  const at1559 = await getRoute(
    t,
    { FUND_LIMIT_KV: beforeMidnight },
    'code=159941',
    new Date('2026-10-13T15:59:59.000Z')
  ).response;
  assert.equal(at1559.status, 404);
  assert.equal(beforeMidnight.getCalls[0], 'etf-pcf:159941:20261013');

  const afterMidnight = new FakeKV();
  const at1600 = await getRoute(
    t,
    { FUND_LIMIT_KV: afterMidnight },
    'code=159941',
    new Date('2026-10-13T16:00:00.000Z')
  ).response;
  assert.equal(at1600.status, 404);
  assert.equal(afterMidnight.getCalls[0], 'etf-pcf:159941:20261014');
});

test('GET 显式 date 命中对应缓存，KV 服务异常返回 503', async (t) => {
  const hit = await getRoute(
    t,
    { FUND_LIMIT_KV: seededKV(makeCachedData({ code: '159001', date: '2026-10-13' })) },
    'code=159941&date=2026-10-13'
  ).response;
  assert.equal(hit.status, 404); // 身份不符 → miss

  const seeded = seededKV();
  seeded.getImpl = () => {
    throw new Error('kv down');
  };
  const readFail = await getRoute(t, { FUND_LIMIT_KV: seeded }, 'code=159941').response;
  assert.equal(readFail.status, 503);
  assert.equal((await readFail.json()).reason, 'kv_read_failed');

  const noBinding = await getRoute(t, {}, 'code=159941').response;
  assert.equal(noBinding.status, 503);
  assert.equal((await noBinding.json()).reason, 'kv_unavailable');
});

// ─── POST：单 code 手动刷新 ───────────────────────────────────────

test('POST 成功抓取解析并写入精确 key（TTL 86400）后返回 200', async (t) => {
  const kv = new FakeKV();
  const { fetchMock, response } = postRoute(t, { FUND_LIMIT_KV: kv }, { code: '159941', date: '2026-10-13' });
  const result = await response;
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.cached, false);
  assert.equal(body.fundName, '纳指ETF广发');
  assert.equal(body.netSubscribeLimitShares, 1300000);
  assert.equal(body.fetchedAt, '2026-10-13T02:00:00.000Z');
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt');
  assert.equal(kv.putCalls.length, 1);
  assert.equal(kv.putCalls[0].key, 'etf-pcf:159941:20261013');
  assert.equal(kv.putCalls[0].options.expirationTtl, 86400);
});

test('POST date 省略默认上海当天', async (t) => {
  const kv = new FakeKV();
  const result = await postRoute(t, { FUND_LIMIT_KV: kv }, { code: '159941' }).response;
  assert.equal(result.status, 200);
  assert.equal(kv.putCalls.length, 1);
  assert.equal(kv.putCalls[0].key, 'etf-pcf:159941:20261013');

  const crossDay = new FakeKV();
  const nextDay = await postRoute(
    t,
    { FUND_LIMIT_KV: crossDay },
    { code: '159941' },
    async () => ({ status: 200, arrayBuffer: async () => fixtureBytesForDate('2026-10-14') }),
    new Date('2026-10-13T16:00:00.000Z')
  ).response;
  assert.equal(nextDay.status, 200);
  assert.equal(crossDay.putCalls[0].key, 'etf-pcf:159941:20261014');
});

// fixture 中的 ASCII 日期「2026-10-13」（数字与连字符均 < 0x40，不可能是 GBK 尾字节，
// 因此字节匹配必然是 ASCII 对齐）可安全替换为其它同长度日期，构造跨日文件变体。
function fixtureBytesForDate(dateKey) {
  const needle = new TextEncoder().encode('2026-10-13');
  const replacement = new TextEncoder().encode(dateKey);
  assert.equal(needle.length, replacement.length);
  const out = new Uint8Array(FIXTURE_BYTES);
  let replaced = 0;
  for (let i = 0; i + needle.length <= out.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (out[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      for (let j = 0; j < needle.length; j += 1) out[i + j] = replacement[j];
      replaced += 1;
      i += needle.length - 1;
    }
  }
  // 标题日期 + 当日段落标题，至少 2 处。
  assert.ok(replaced >= 2, 'fixture 中的日期标记未找齐');
  return out;
}

test('POST 上游 404 → 404 upstream_not_found；HTTP 500 → 502；GBK 非法字节 → 502', async (t) => {
  const notFound = await postRoute(
    t,
    { FUND_LIMIT_KV: new FakeKV() },
    { code: '159941', date: '2026-10-13' },
    async () => ({ status: 404 })
  ).response;
  assert.equal(notFound.status, 404);
  const notFoundBody = await notFound.json();
  assert.equal(notFoundBody.reason, 'upstream_not_found');
  assert.equal(notFoundBody.code, '159941');

  const httpError = await postRoute(
    t,
    { FUND_LIMIT_KV: new FakeKV() },
    { code: '159941', date: '2026-10-13' },
    async () => ({ status: 500 })
  ).response;
  assert.equal(httpError.status, 502);
  assert.equal((await httpError.json()).reason, 'http_error');

  const decodeFail = await postRoute(
    t,
    { FUND_LIMIT_KV: new FakeKV() },
    { code: '159941', date: '2026-10-13' },
    async () => ({ status: 200, arrayBuffer: async () => new Uint8Array([0x81]) })
  ).response;
  assert.equal(decodeFail.status, 502);
  assert.equal((await decodeFail.json()).reason, 'decode_failed');
});

test('POST 上游超时 → 504（5 秒全程超时）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started = false;
  const { response } = postRoute(t, { FUND_LIMIT_KV: new FakeKV() }, { code: '159941', date: '2026-10-13' }, async (url, init = {}) => {
    started = true;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  });
  // 等路由推进到 fetch（request.json() 等微任务完成）。
  for (let i = 0; i < 200 && !started; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started, true);
  t.mock.timers.tick(5000);
  const result = await response;
  assert.equal(result.status, 504);
  assert.equal((await result.json()).reason, 'timeout');
});

test('POST KV 写失败/缺 binding → 503，不冒充成功', async (t) => {
  const kv = new FakeKV();
  kv.putImpl = () => {
    throw new Error('kv write down');
  };
  const writeFail = await postRoute(t, { FUND_LIMIT_KV: kv }, { code: '159941', date: '2026-10-13' }).response;
  assert.equal(writeFail.status, 503);
  assert.equal((await writeFail.json()).reason, 'kv_write_failed');

  const { fetchMock, response } = postRoute(t, {}, { code: '159941', date: '2026-10-13' });
  const noBinding = await response;
  assert.equal(noBinding.status, 503);
  assert.equal((await noBinding.json()).reason, 'kv_unavailable');
  // 缺 binding 时不得访问外部源。
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('POST 参数防御：畸形 JSON/非对象/批量/非法参数均 400 且不碰 KV 与上游', async (t) => {
  const cases = [
    ['{broken json', 'invalid_json'],
    ['"just a string"', 'invalid_body'],
    ['[1, 2, 3]', 'invalid_body'],
    ['null', 'invalid_body'],
    [JSON.stringify({ codes: ['159941', '159001'] }), 'batch_unsupported'],
    [JSON.stringify({}), 'invalid_code'],
    [JSON.stringify({ code: null }), 'invalid_code'],
    [JSON.stringify({ code: '15941' }), 'invalid_code'],
    [JSON.stringify({ code: '159941', date: '' }), 'invalid_date'],
    [JSON.stringify({ code: '159941', date: null }), 'invalid_date'],
    [JSON.stringify({ code: '159941', date: '2026-02-30' }), 'invalid_date'],
    [JSON.stringify({ code: '159941', date: '2026-10-14' }), 'invalid_date']
  ];
  for (const [body, reason] of cases) {
    const kv = new FakeKV();
    const { fetchMock, response } = postRoute(t, { FUND_LIMIT_KV: kv }, body);
    const result = await response;
    assert.equal(result.status, 400, body);
    assert.equal((await result.json()).reason, reason, body);
    assert.equal(kv.getCalls.length, 0, body);
    assert.equal(kv.putCalls.length, 0, body);
    assert.equal(fetchMock.mock.calls.length, 0, body);
  }
});

// ─── 其它 method ──────────────────────────────────────────────────

test('PUT/DELETE/PATCH → 405 + Allow: GET, POST, OPTIONS', async (t) => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const { fetchMock, response } = postRoute(t, { FUND_LIMIT_KV: seededKV() }, undefined);
    // postRoute 固定 POST，这里直接构造请求。
    const request = new Request(BASE, { method });
    const result = await handleEtfPcfLimit(request, { FUND_LIMIT_KV: seededKV() }, {}, new URLSearchParams(), NOW);
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.get('allow'), 'GET, POST, OPTIONS', method);
    assert.equal(fetchMock.mock.calls.length, 0, method);
  }
});

// ─── SSE（上交所纳指 ETF）分发 ─────────────────────────────────────

test('GET SSE 命中缓存返回 200；miss/身份不符 404；refresh/force 一律 fetch=0', async (t) => {
  const kv = new FakeKV(new Map([['etf-pcf:513300:20261013', JSON.stringify(makeSseCachedData())]]));
  const { fetchMock, response } = getRoute(t, { FUND_LIMIT_KV: kv }, 'code=513300');
  const result = await response;
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.cached, true);
  assert.equal(body.source, 'sse_pcf');
  assert.equal(body.code, '513300');
  assert.equal(body.netSubscribeLimitShares, 3750000);
  assert.equal(body.totalSubscribeLimitShares, null);
  assert.equal(body.totalSubscribeLimitKind, 'unlimited');
  assert.deepEqual(kv.getCalls, ['etf-pcf:513300:20261013']);
  assert.equal(fetchMock.mock.calls.length, 0);

  // force/refresh 不改变 GET 只读语义。
  const forced = await getRoute(t, { FUND_LIMIT_KV: kv }, 'code=513300&force=1&refresh=1').response;
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).cached, true);

  const miss = await getRoute(t, { FUND_LIMIT_KV: new FakeKV() }, 'code=513100&refresh=1').response;
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).reason, 'cache_miss');

  // 深交所缓存（szse_pcf）在 SSE key 下属身份不符 → miss（用本测试未读过的 code，避开 memory 缓存）。
  const wrongSource = new FakeKV(
    new Map([['etf-pcf:513100:20261013', JSON.stringify(makeCachedData({ code: '513100' }))]])
  );
  const mismatch = await getRoute(t, { FUND_LIMIT_KV: wrongSource }, 'code=513100').response;
  assert.equal(mismatch.status, 404);
  assert.equal((await mismatch.json()).reason, 'cache_miss');
});

test('GET 名单外 51xxxx（513500/510300）→ 404 unsupported_code，fetch 与 KV 均为 0', async (t) => {
  for (const code of ['513500', '510300']) {
    const kv = new FakeKV();
    const { fetchMock, response } = getRoute(t, { FUND_LIMIT_KV: kv }, 'code=' + code);
    const result = await response;
    assert.equal(result.status, 404, code);
    const body = await result.json();
    assert.equal(body.reason, 'unsupported_code', code);
    assert.equal(body.code, code);
    assert.equal(kv.getCalls.length, 0, code);
    assert.equal(kv.putCalls.length, 0, code);
    assert.equal(fetchMock.mock.calls.length, 0, code);

    const post = await postRoute(t, { FUND_LIMIT_KV: new FakeKV() }, { code }).response;
    assert.equal(post.status, 404, code);
    assert.equal((await post.json()).reason, 'unsupported_code', code);
  }
});

test('GET SSE 默认上海当天与跨日；显式历史日期只查该 key', async (t) => {
  const at1559 = new FakeKV();
  const beforeMidnight = await getRoute(
    t,
    { FUND_LIMIT_KV: at1559 },
    'code=513300',
    new Date('2026-10-13T15:59:59.000Z')
  ).response;
  assert.equal(beforeMidnight.status, 404);
  assert.equal(at1559.getCalls[0], 'etf-pcf:513300:20261013');

  const afterMidnight = new FakeKV();
  const at1600 = await getRoute(
    t,
    { FUND_LIMIT_KV: afterMidnight },
    'code=513300',
    new Date('2026-10-13T16:00:00.000Z')
  ).response;
  assert.equal(at1600.status, 404);
  assert.equal(afterMidnight.getCalls[0], 'etf-pcf:513300:20261014');

  // 已有有效历史日期缓存：显式 date 命中，不联网验证源站最新清单。
  const historical = new FakeKV(
    new Map([
      [
        'etf-pcf:513300:20261012',
        JSON.stringify(
          makeSseCachedData({
            tradingDay: '20261012',
            date: '2026-10-12',
            fetchedAt: '2026-10-12T12:00:00.000Z',
            expiresAt: '2026-10-13T12:00:00.000Z'
          })
        )
      ]
    ])
  );
  const hit = await getRoute(t, { FUND_LIMIT_KV: historical }, 'code=513300&date=2026-10-12').response;
  assert.equal(hit.status, 200);
  assert.equal((await hit.json()).cached, true);
});

test('POST SSE 缺省 date：用接口 TRADING_DAY 入库，响应日期与写入 key 一致', async (t) => {
  const kv = new FakeKV();
  const { fetchMock, response } = postRoute(t, { FUND_LIMIT_KV: kv }, { code: '513100' }, async (url, init) => {
    assert.equal(url, SSE_URL('513100'));
    assert.equal(init.headers.Referer, 'https://www.sse.com.cn/');
    return sseFixtureOk('513100');
  });
  const result = await response;
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.cached, false);
  assert.equal(body.source, 'sse_pcf');
  assert.equal(body.code, '513100');
  assert.equal(body.date, '2026-10-13');
  assert.equal(body.tradingDay, '20261013');
  // 513100 口径：仅允许赎回，但累计 2500000 保留，净申购 unlimited。
  assert.equal(body.subscriptionAllowed, false);
  assert.equal(body.redemptionAllowed, true);
  assert.equal(body.creationRedemption, '仅允许赎回');
  assert.equal(body.totalSubscribeLimitShares, 2500000);
  assert.equal(body.netSubscribeLimitShares, null);
  assert.equal(body.netSubscribeLimitKind, 'unlimited');
  assert.equal(body.accountTotalSubscribeLimitShares, 500000);
  assert.equal(body.estimatedCashDifference, -9064.44);
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(kv.putCalls.length, 1);
  assert.equal(kv.putCalls[0].key, 'etf-pcf:513100:20261013');
  assert.equal(kv.putCalls[0].options.expirationTtl, 86400);

  // 抓取时间在上海 10-14，但源站 TRADING_DAY 仍是 20261013：只写清单日，不伪造当天。
  const nextDay = new FakeKV();
  const refreshed = await postRoute(
    t,
    { FUND_LIMIT_KV: nextDay },
    { code: '513300' },
    async () => sseFixtureOk('513300'),
    new Date('2026-10-14T02:00:00.000Z')
  ).response;
  assert.equal(refreshed.status, 200);
  const nextDayBody = await refreshed.json();
  assert.equal(nextDayBody.date, '2026-10-13');
  assert.equal(nextDay.putCalls.length, 1);
  assert.equal(nextDay.putCalls[0].key, 'etf-pcf:513300:20261013');
  assert.equal(nextDayBody.fetchedAt, '2026-10-14T02:00:00.000Z');
});

test('POST SSE 指定 date：与 TRADING_DAY 一致成功；不一致 404 且不写 KV', async (t) => {
  const matched = new FakeKV();
  const ok = await postRoute(t, { FUND_LIMIT_KV: matched }, { code: '513300', date: '2026-10-13' }, async () =>
    sseFixtureOk('513300')
  ).response;
  assert.equal(ok.status, 200);
  assert.equal(matched.putCalls.length, 1);
  assert.equal(matched.putCalls[0].key, 'etf-pcf:513300:20261013');

  const mismatched = new FakeKV();
  const { fetchMock, response } = postRoute(
    t,
    { FUND_LIMIT_KV: mismatched },
    { code: '513300', date: '2026-10-12' },
    async () => sseFixtureOk('513300')
  );
  const mismatch = await response;
  assert.equal(mismatch.status, 404);
  const body = await mismatch.json();
  assert.equal(body.reason, 'upstream_not_found');
  assert.equal(body.code, '513300');
  assert.equal(body.date, '2026-10-12');
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(mismatched.putCalls.length, 0);
  assert.equal(mismatched.store.has('etf-pcf:513300:20261013'), false);
});

test('POST SSE 错误分类透传：404→404、空响应耗尽→502、KV 缺失/写失败→503', async (t) => {
  const notFound = await postRoute(t, { FUND_LIMIT_KV: new FakeKV() }, { code: '513100' }, async () => ({
    status: 404
  })).response;
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).reason, 'upstream_not_found');

  // 空正文属瞬态：3 次尝试耗尽后 502 empty_response，不解释为额度 0。
  const empty = new FakeKV();
  const { fetchMock, response: emptyResp } = postRoute(
    t,
    { FUND_LIMIT_KV: empty },
    { code: '513100' },
    async () => ({ status: 200, arrayBuffer: async () => new Uint8Array(0) })
  );
  const emptyResult = await emptyResp;
  assert.equal(emptyResult.status, 502);
  assert.equal((await emptyResult.json()).reason, 'empty_response');
  assert.equal(fetchMock.mock.calls.length, 3);
  assert.equal(empty.putCalls.length, 0);

  const { fetchMock: noBindingFetch, response: noBindingResp } = postRoute(t, {}, { code: '513100' });
  const noBinding = await noBindingResp;
  assert.equal(noBinding.status, 503);
  assert.equal((await noBinding.json()).reason, 'kv_unavailable');
  assert.equal(noBindingFetch.mock.calls.length, 0);

  const kv = new FakeKV();
  kv.putImpl = () => {
    throw new Error('kv write down');
  };
  const writeFail = await postRoute(
    t,
    { FUND_LIMIT_KV: kv },
    { code: '513100' },
    async () => sseFixtureOk('513100')
  ).response;
  assert.equal(writeFail.status, 503);
  assert.equal((await writeFail.json()).reason, 'kv_write_failed');
});

test('SSE 参数防御：重复 query、数字类型 code、空/未来 date、批量均 400 且不碰 KV 与上游', async (t) => {
  const cases = [
    ['GET', 'code=513100&code=513100', 'duplicate_query_param'],
    ['GET', 'code=513100&date=2026-10-12&date=2026-10-13', 'duplicate_query_param'],
    ['GET', 'code=5135000', 'invalid_code'],
    ['POST', JSON.stringify({ code: 513100 }), 'invalid_code'],
    ['POST', JSON.stringify({ code: null }), 'invalid_code'],
    ['POST', JSON.stringify({ code: '513100', date: '' }), 'invalid_date'],
    ['POST', JSON.stringify({ code: '513100', date: '2026-10-14' }), 'invalid_date'],
    ['POST', JSON.stringify({ code: '513100', date: '2026-02-30' }), 'invalid_date'],
    ['POST', JSON.stringify({ codes: ['513100'] }), 'batch_unsupported'],
    ['POST', JSON.stringify({}), 'invalid_code']
  ];
  for (const [method, input, reason] of cases) {
    const kv = new FakeKV();
    let fetchMock;
    let response;
    if (method === 'GET') {
      ({ fetchMock, response } = getRoute(t, { FUND_LIMIT_KV: kv }, input));
    } else {
      ({ fetchMock, response } = postRoute(t, { FUND_LIMIT_KV: kv }, input));
    }
    const result = await response;
    assert.equal(result.status, 400, input);
    assert.equal((await result.json()).reason, reason, input);
    assert.equal(kv.getCalls.length, 0, input);
    assert.equal(kv.putCalls.length, 0, input);
    assert.equal(fetchMock.mock.calls.length, 0, input);
  }
});

test('159941 仍走深交所：POST 抓 szse 固定 URL，不带上交所 Referer', async (t) => {
  const kv = new FakeKV();
  const { fetchMock, response } = postRoute(t, { FUND_LIMIT_KV: kv }, { code: '159941', date: '2026-10-13' });
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt');
  assert.equal(kv.putCalls[0].key, 'etf-pcf:159941:20261013');
  const body = await result.json();
  assert.equal(body.source, 'szse_pcf');
});

test('SSE 前日可选字段解析与缓存形态，真实接口缺字段不造日期', async () => {
  const { mapSsePcfFields, validateSsePcfCachedData } = await import('../workers/ocr-proxy/src/ssePcfLimit.js');
  const row = JSON.parse(SSE_FIXTURES.get('513100')).result[0];
  const parse = (overrides) => mapSsePcfFields({ ...row, ...overrides }, { code: '513100' });
  const missing = parse({});
  assert.equal(missing.prevDayDate, null);
  assert.equal(missing.prevDayCashDifference, null);
  const p = parse({ PRE_CASH_COMPONENT: '￥-8933.50', PRE_TRADING_DAY: '20261012' });
  assert.equal(p.prevDayCashDifference, -8933.5);
  assert.equal(p.prevDayDate, '2026-10-12');
  for (const value of ['20261399', '20260229', '2026101', 20261012]) {
    const invalid = parse({ PRE_TRADING_DAY: value });
    assert.equal(invalid.prevDayDate, null);
    assert.ok(invalid.warnings.some((w) => w.includes('PRE_TRADING_DAY')));
  }
  const cached = { ...p, sourceUrl: SSE_URL('513100'), fetchedAt: '2026-10-13T01:00:00Z', expiresAt: '2026-10-14T01:00:00Z' };
  const check = (data) => validateSsePcfCachedData(data, { code: '513100', date: '2026-10-13', now: NOW });
  assert.equal(check(cached).ok, true);
  const old = { ...cached }; delete old.prevDayDate; delete old.prevDayCashDifference;
  assert.equal(check(old).ok, true);
  for (const prevDayDate of ['2026-02-30', 1]) assert.equal(check({ ...cached, prevDayDate }).ok, false);
  for (const prevDayCashDifference of ['1', Infinity, NaN]) assert.equal(check({ ...cached, prevDayCashDifference }).ok, false);
});
