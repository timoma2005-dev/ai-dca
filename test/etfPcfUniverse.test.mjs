// universe 发现与名单维护测试：159000–159999 全量探测、HEAD/GET 分类、KV 名单 diff、
// 连续消失移除、骤降保护、失败降级与校验。全部使用 mock fetch + fake KV，离线运行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ETF_PCF_UNIVERSE_KEY,
  createEtfPcfRequestBudget,
  listEtfPcfCandidateCodes,
  discoverEtfPcfUniverse,
  loadEtfPcfUniverse,
  validateEtfPcfUniverseEntry
} from '../workers/ocr-proxy/src/etfPcfUniverse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BYTES = new Uint8Array(
  readFileSync(path.join(__dirname, 'fixtures/etf-pcf/ETF15994120261013.gbk.txt'))
);
const NOW = new Date('2026-10-13T02:00:00.000Z');
const DATE_KEY = '2026-10-13';

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

// fixture 正文代码「159941」为纯 ASCII 且前置空格保证 GBK 对齐（0x20 不可能是尾字节），
// 按字节替换成其它 159xxx 代码即可为探测存在的 code 生成身份匹配的文件内容。
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

// 探测 mock：HEAD 优先；exists 集合决定 200/404；behavior 定义瞬态/持续故障与挂起。
function createProbeMock({ exists = new Set(), behavior = new Map(), headUnsupported = false } = {}) {
  const calls = [];
  let cancelled = 0;
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, code: (/ETF(159\d{3})\d{8}\.txt$/.exec(url) || [])[1] });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const code = calls[calls.length - 1].code;
      const mode = behavior.get(code);
      if (mode === 'timeout') {
        return await new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (mode === '500_once') {
        behavior.set(code, 'ok');
        return { status: 500 };
      }
      if (mode === '429') return { status: 429 };
      if (method === 'HEAD') {
        if (headUnsupported) return { status: 405 };
        return { status: exists.has(code) ? 200 : 404 };
      }
      // GET：HEAD 不支持时的探测替代，或文件抓取。
      if (exists.has(code) || mode === 'ok') {
        return {
          status: 200,
          arrayBuffer: async () => fixtureBytesForCode(code),
          body: { cancel: async () => { cancelled += 1; } }
        };
      }
      return { status: 404, body: { cancel: async () => { cancelled += 1; } } };
    } finally {
      active -= 1;
    }
  };
  return { fetchImpl, calls, get cancelled() { return cancelled; }, get maxActive() { return maxActive; } };
}

function makeUniverseEntry(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'szse_pcf_probe',
    codes: ['159001', '159002'],
    total: 2,
    fetchedAt: new Date(NOW.getTime() - 3600 * 1000).toISOString(),
    lastProbeDate: '2026-10-12',
    entries: {
      '159001': { lastSeenDate: '2026-10-12', missingCount: 0 },
      '159002': { lastSeenDate: '2026-10-10', missingCount: 1 }
    },
    ...overrides
  };
}

function seededUniverseKV(entry = makeUniverseEntry()) {
  return new FakeKV(new Map([[ETF_PCF_UNIVERSE_KEY, JSON.stringify(entry)]]));
}

// ─── 候选枚举 ─────────────────────────────────────────────────────

test('候选枚举恰好覆盖 159000–159999 共 1000 个合法代码', () => {
  const codes = listEtfPcfCandidateCodes();
  assert.equal(codes.length, 1000);
  assert.equal(codes[0], '159000');
  assert.equal(codes[999], '159999');
  assert.ok(codes.every((code) => /^159\d{3}$/.test(code)));
  for (let i = 1; i < codes.length; i += 1) {
    assert.ok(codes[i - 1] < codes[i], '候选必须严格升序去重');
  }
});

// ─── 每日发现 ─────────────────────────────────────────────────────

test('冷启动完整发现：探测统计合计 1000，clist 遗漏品种被覆盖，成功写名单', async () => {
  const mock = createProbeMock({ exists: new Set(['159941', '159632', '159659']) });
  const kv = new FakeKV();
  const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, now: NOW, fetchImpl: mock.fetchImpl });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.complete, true);
  assert.deepEqual(outcome.codes, ['159632', '159659', '159941']);
  // 159941/159632/159659 是 eastmoney clist 遗漏的品种，探测方式必须覆盖。
  for (const code of ['159941', '159632', '159659']) {
    assert.ok(outcome.codes.includes(code), code);
  }
  assert.equal(outcome.stats.probeTotal, 1000);
  assert.equal(outcome.stats.probeExists, 3);
  assert.equal(outcome.stats.probeNotFound, 997);
  assert.equal(outcome.stats.probeFailed, 0);
  assert.equal(outcome.stats.probeSkippedDeadline, 0);
  assert.equal(outcome.stats.probeExists + outcome.stats.probeNotFound + outcome.stats.probeFailed + outcome.stats.probeSkippedDeadline, 1000);

  assert.equal(outcome.universeWrite, 'updated');
  assert.equal(outcome.calibration.status, 'updated');
  assert.deepEqual(outcome.calibration.addedCodes, ['159632', '159659', '159941']);
  assert.deepEqual(outcome.calibration.missingCodes, []);
  assert.deepEqual(outcome.calibration.removedCodes, []);

  assert.equal(kv.putCalls.length, 1);
  assert.equal(kv.putCalls[0].key, ETF_PCF_UNIVERSE_KEY);
  assert.equal(kv.putCalls[0].options.expirationTtl, 7 * 86400);
  const entry = JSON.parse(kv.putCalls[0].value);
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.source, 'szse_pcf_probe');
  assert.deepEqual(entry.codes, ['159632', '159659', '159941']);
  assert.equal(entry.total, 3);
  assert.equal(entry.lastProbeDate, DATE_KEY);
  assert.equal(entry.fetchedAt, NOW.toISOString());
  assert.deepEqual(entry.entries['159941'], { lastSeenDate: DATE_KEY, missingCount: 0 });
});

test('探测失败分类：429/超时计入 probeFailed，瞬态 500 重试成功；未完成不写完整名单', async () => {
  const mock = createProbeMock({
    exists: new Set(['159941', '159632']),
    behavior: new Map([
      ['159632', '500_once'], // 第一次 500，重试后 200
      ['159659', '429'],       // 持续 429：重试一次后仍失败
      ['159900', 'timeout']   // 挂起：超时后失败
    ])
  });
  const kv = new FakeKV();
  const outcome = await discoverEtfPcfUniverse({
    env: { FUND_LIMIT_KV: kv },
    date: DATE_KEY,
    now: NOW,
    fetchImpl: mock.fetchImpl,
    timeoutMs: 20
  });

  assert.equal(outcome.complete, false);
  assert.equal(outcome.stats.probeExists, 2);
  assert.equal(outcome.stats.probeFailed, 2);
  assert.equal(outcome.stats.probeNotFound, 996);
  assert.equal(outcome.stats.probeExists + outcome.stats.probeNotFound + outcome.stats.probeFailed, 1000);
  // 部分结果不冒充完整名单。
  assert.equal(outcome.universeWrite, 'incomplete');
  assert.equal(outcome.calibration.status, 'incomplete');
  assert.equal(kv.putCalls.length, 0);

  // 瞬态错误各重试一次。
  assert.equal(mock.calls.filter((c) => c.code === '159632').length, 2);
  assert.equal(mock.calls.filter((c) => c.code === '159659').length, 2);
  assert.equal(mock.calls.filter((c) => c.code === '159900').length, 2);
});

test('HEAD 不支持（405）时有限 GET 替代，后续直接 GET，响应体被取消', async () => {
  const mock = createProbeMock({ exists: new Set(['159941']), headUnsupported: true });
  const kv = new FakeKV();
  const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, now: NOW, fetchImpl: mock.fetchImpl });

  assert.equal(outcome.complete, true);
  assert.equal(outcome.stats.probeExists, 1);
  assert.equal(outcome.stats.probeNotFound, 999);
  // 并发 5：第一批 5 个候选各发一次 HEAD(405) 后翻转 preferGet，其余 995 个直接 GET，
  // 5 个候选再各补一次 GET 替代 —— 不再对每个 code 双探测。
  assert.equal(mock.calls.filter((c) => c.method === 'HEAD').length, 5);
  assert.equal(mock.calls.filter((c) => c.method === 'GET').length, 1000);
  assert.equal(mock.calls.length, 1005);
  // GET 探测的响应体必须消费/取消。
  assert.ok(mock.cancelled >= 999);
  assert.equal(kv.putCalls.length, 1);
});

test('名单 diff：新增与消失分开记录，消失保留原 lastSeenDate 并推进计数', async () => {
  const mock = createProbeMock({ exists: new Set(['159001', '159003', '159004']) });
  const kv = seededUniverseKV();
  const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, now: NOW, fetchImpl: mock.fetchImpl });

  assert.equal(outcome.complete, true);
  assert.deepEqual(outcome.calibration.addedCodes, ['159003', '159004']);
  assert.deepEqual(outcome.calibration.missingCodes, ['159002']);
  assert.deepEqual(outcome.calibration.removedCodes, []);
  assert.equal(outcome.universeWrite, 'updated');

  const entry = JSON.parse(kv.putCalls[0].value);
  assert.deepEqual(entry.codes, ['159001', '159002', '159003', '159004']);
  assert.equal(entry.total, 4);
  // 159002 连续消失第 2 个探测日，但未到 5 天阈值，保留并清点。
  assert.deepEqual(entry.entries['159002'], { lastSeenDate: '2026-10-10', missingCount: 2 });
  assert.deepEqual(entry.entries['159004'], { lastSeenDate: DATE_KEY, missingCount: 0 });
});

test('连续 5 个有效校准日消失才从名单移除', async () => {
  // 6 只旧名单只丢 1 只（约 17% < 20% 骤降阈值），才能正常推进消失计数。
  const oldCodes = ['159001', '159002', '159003', '159004', '159005', '159006'];
  const entries = {};
  for (const code of oldCodes) entries[code] = { lastSeenDate: '2026-10-13', missingCount: 0 };
  const kv = seededUniverseKV(makeUniverseEntry({ codes: oldCodes, total: 6, entries }));
  const mock = createProbeMock({ exists: new Set(['159001', '159003', '159004', '159005', '159006']) });

  for (let day = 1; day <= 5; day += 1) {
    const dateKey = `2026-10-${String(13 + day).padStart(2, '0')}`;
    const now = new Date(Date.UTC(2026, 9, 13 + day, 2, 0, 0));
    const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: dateKey, now, fetchImpl: mock.fetchImpl });
    assert.equal(outcome.complete, true);
    assert.deepEqual(outcome.calibration.missingCodes, ['159002'], `day ${day}`);
    const entry = JSON.parse(kv.putCalls[kv.putCalls.length - 1].value);
    if (day < 5) {
      assert.equal(entry.codes.length, 6, `day ${day}`);
      assert.equal(entry.entries['159002'].missingCount, day, `day ${day}`);
      assert.deepEqual(outcome.calibration.removedCodes, [], `day ${day}`);
    } else {
      assert.deepEqual(outcome.calibration.removedCodes, ['159002'], '第 5 个有效校准日移除');
      assert.deepEqual(entry.codes, ['159001', '159003', '159004', '159005', '159006']);
      assert.equal(entry.entries['159002'], undefined);
    }
  }
});

test('消失后重新出现即恢复并清零计数', async () => {
  const kv = seededUniverseKV(
    makeUniverseEntry({
      entries: {
        '159001': { lastSeenDate: '2026-10-13', missingCount: 0 },
        '159002': { lastSeenDate: '2026-10-10', missingCount: 3 }
      }
    })
  );
  const mock = createProbeMock({ exists: new Set(['159001', '159002']) });
  const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, now: NOW, fetchImpl: mock.fetchImpl });
  assert.equal(outcome.complete, true);
  assert.deepEqual(outcome.calibration.missingCodes, []);
  const entry = JSON.parse(kv.putCalls[0].value);
  assert.deepEqual(entry.entries['159002'], { lastSeenDate: DATE_KEY, missingCount: 0 });
});

test('相较旧名单骤降超过 20% 视为异常：保留名单且不推进消失计数', async () => {
  const oldCodes = Array.from({ length: 10 }, (_, i) => '15900' + i);
  const entries = {};
  for (const code of oldCodes) entries[code] = { lastSeenDate: '2026-10-12', missingCount: 0 };
  const kv = seededUniverseKV(makeUniverseEntry({ codes: oldCodes, total: 10, entries }));
  // 10 个旧 code 只剩 5 个存在 → 5 < 10 × 0.8 → 骤降保护。
  const mock = createProbeMock({ exists: new Set(['159001', '159002', '159003', '159004', '159005']) });
  const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, now: NOW, fetchImpl: mock.fetchImpl });

  assert.equal(outcome.complete, true);
  assert.equal(outcome.universeWrite, 'kept_anomaly');
  assert.equal(outcome.calibration.status, 'kept_anomaly');
  assert.deepEqual(outcome.calibration.missingCodes, []);
  assert.deepEqual(outcome.calibration.removedCodes, []);
  assert.equal(kv.putCalls.length, 0);
  // 旧名单原样保留。
  const kept = JSON.parse(kv.store.get(ETF_PCF_UNIVERSE_KEY));
  assert.deepEqual(kept.codes, oldCodes);
});

test('全量 404（非交易日/未发布）同样走骤降保护，不写空名单', async () => {
  const mock = createProbeMock({ exists: new Set() });
  const kv = new FakeKV();
  const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, now: NOW, fetchImpl: mock.fetchImpl });
  assert.equal(outcome.complete, true);
  assert.equal(outcome.stats.probeExists, 0);
  assert.equal(outcome.stats.probeNotFound, 1000);
  assert.equal(outcome.universeWrite, 'kept_anomaly');
  assert.equal(kv.putCalls.length, 0);
});

test('KV 写失败明确报告 kv_write_failed，不冒充成功', async () => {
  const mock = createProbeMock({ exists: new Set(['159941']) });
  const kv = new FakeKV();
  kv.putImpl = () => {
    throw new Error('kv write down');
  };
  const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, now: NOW, fetchImpl: mock.fetchImpl });
  assert.equal(outcome.complete, true);
  assert.equal(outcome.universeWrite, 'kv_write_failed');
  assert.equal(kv.putCalls.length, 1);
});

test('预算耗尽：跳过计入 probeSkippedDeadline，合计仍为 1000，不写名单', async () => {
  const mock = createProbeMock({ exists: new Set() });
  const kv = new FakeKV();
  const budget = createEtfPcfRequestBudget(3);
  const outcome = await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: kv }, date: DATE_KEY, now: NOW, fetchImpl: mock.fetchImpl, budget });

  assert.equal(outcome.complete, false);
  assert.equal(outcome.stats.probeNotFound, 3);
  assert.equal(outcome.stats.probeSkippedDeadline, 997);
  assert.equal(outcome.stats.probeExists + outcome.stats.probeNotFound + outcome.stats.probeFailed + outcome.stats.probeSkippedDeadline, 1000);
  assert.equal(budget.requestCount, 3);
  assert.equal(kv.putCalls.length, 0);
});

test('软 deadline 到期：全部探测跳过且不做降级校准', async () => {
  const mock = createProbeMock({ exists: new Set(['159941']) });
  const kv = new FakeKV();
  const outcome = await discoverEtfPcfUniverse({
    env: { FUND_LIMIT_KV: kv },
    date: DATE_KEY,
    now: NOW,
    fetchImpl: mock.fetchImpl,
    deadlineAt: Date.now()
  });
  assert.equal(outcome.complete, false);
  assert.equal(outcome.stats.probeSkippedDeadline, 1000);
  assert.equal(mock.calls.length, 0);
  assert.equal(kv.putCalls.length, 0);
});

test('探测并发受 mapLimit 限制：默认不超过 5，可显式收紧', async () => {
  const mockDefault = createProbeMock({ exists: new Set() });
  await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: new FakeKV() }, date: DATE_KEY, now: NOW, fetchImpl: mockDefault.fetchImpl });
  assert.ok(mockDefault.maxActive <= 5, 'maxActive=' + mockDefault.maxActive);

  const mockTwo = createProbeMock({ exists: new Set() });
  await discoverEtfPcfUniverse({ env: { FUND_LIMIT_KV: new FakeKV() }, date: DATE_KEY, now: NOW, fetchImpl: mockTwo.fetchImpl, concurrency: 2 });
  assert.ok(mockTwo.maxActive <= 2, 'maxActive=' + mockTwo.maxActive);
});

// ─── 名单读取与校验 ───────────────────────────────────────────────

test('validateEtfPcfUniverseEntry：身份/形态/时间/计数逐项校验', () => {
  const ok = validateEtfPcfUniverseEntry(makeUniverseEntry(), { now: NOW });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.codes, ['159001', '159002']);
  assert.ok(Math.abs(ok.ageMs - 3600 * 1000) < 1000);

  const cases = [
    [{ schemaVersion: 2 }, 'schema_version'],
    [{ source: 'eastmoney' }, 'source'],
    [{ codes: 'x' }, 'codes'],
    [{ codes: ['15a001', '159002'] }, 'code_format'],
    [{ codes: ['159002', '159001'], total: 2 }, 'codes_order'],
    [{ codes: ['159001', '159001'], total: 2 }, 'codes_order'],
    [{ total: 3 }, 'total'],
    [{ entries: null }, 'entries'],
    [{ entries: {} }, 'entries_count'],
    [{ entries: { '159001': { lastSeenDate: '2026-10-12', missingCount: 0 }, '159003': { lastSeenDate: '2026-10-10', missingCount: 1 } } }, 'entries_identity'],
    [{ entries: { '159001': { lastSeenDate: '2026-10-12', missingCount: -1 }, '159002': { lastSeenDate: '2026-10-10', missingCount: 1 } } }, 'entries_shape'],
    [{ entries: { '159001': { lastSeenDate: '2026-10-12', missingCount: 5 }, '159002': { lastSeenDate: '2026-10-10', missingCount: 1 } } }, 'entries_shape'],
    [{ entries: { '159001': { lastSeenDate: '2026-13-01', missingCount: 0 }, '159002': { lastSeenDate: '2026-10-10', missingCount: 1 } } }, 'entries_shape'],
    [{ fetchedAt: 'not-a-date' }, 'fetched_at'],
    [{ fetchedAt: new Date(NOW.getTime() + 2 * 3600 * 1000).toISOString() }, 'future_fetched_at'],
    [{ fetchedAt: new Date(NOW.getTime() - 8 * 86400 * 1000).toISOString() }, 'expired'],
    [{ lastProbeDate: '2026/10/13' }, 'last_probe_date'],
    [null, 'shape'],
    ['x', 'shape']
  ];
  for (const [overrides, reason] of cases) {
    // 非对象用例（null/'x'）原样传入，对象用例合并进合法基底。
    const entry = overrides !== null && typeof overrides === 'object' ? makeUniverseEntry(overrides) : overrides;
    const result = validateEtfPcfUniverseEntry(entry, { now: NOW });
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.reason, reason, JSON.stringify(overrides));
  }
});

test('loadEtfPcfUniverse：命中/损坏/缺失/服务异常/超龄分类', async () => {
  const loaded = await loadEtfPcfUniverse({ env: { FUND_LIMIT_KV: seededUniverseKV() }, now: NOW });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, 'kv_universe');
  assert.deepEqual(loaded.codes, ['159001', '159002']);
  assert.equal(loaded.fetchedAt, new Date(NOW.getTime() - 3600 * 1000).toISOString());

  const corrupt = await loadEtfPcfUniverse({ env: { FUND_LIMIT_KV: new FakeKV(new Map([[ETF_PCF_UNIVERSE_KEY, '{"broken']])) }, now: NOW });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reason, 'corrupt');

  const missing = await loadEtfPcfUniverse({ env: { FUND_LIMIT_KV: new FakeKV() }, now: NOW });
  assert.equal(missing.reason, 'missing');

  const unavailable = await loadEtfPcfUniverse({ env: {}, now: NOW });
  assert.equal(unavailable.reason, 'kv_unavailable');

  const failing = seededUniverseKV();
  failing.getImpl = () => {
    throw new Error('kv down');
  };
  const readFail = await loadEtfPcfUniverse({ env: { FUND_LIMIT_KV: failing }, now: NOW });
  assert.equal(readFail.reason, 'kv_read_failed');

  const aged = await loadEtfPcfUniverse({
    env: {
      FUND_LIMIT_KV: seededUniverseKV(
        makeUniverseEntry({ fetchedAt: new Date(NOW.getTime() - 8 * 86400 * 1000).toISOString() })
      )
    },
    now: NOW
  });
  assert.equal(aged.reason, 'expired');
});
