// 深交所 ETF PCF 限额核心模块测试：GBK 解码、纯解析、参数防御、抓取、KV 缓存与 inflight。
// 全部离线：真实 GBK fixture + mock fetch + fake KV，不访问深交所源站。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EtfPcfFormatError,
  isValidEtfPcfCode,
  isWellFormedEtfPcfDateKey,
  shanghaiDateKey,
  validateEtfPcfRequest,
  validateEtfPcfHistoryData,
  validateEtfPcfCachedData,
  buildEtfPcfSourceUrl,
  buildEtfPcfCacheKey,
  decodeEtfPcf,
  parseEtfPcf,
  fetchEtfPcfText,
  readEtfPcfLimitCache,
  fetchEtfPcfLimit,
  clearEtfPcfRuntimeStateForTests
} from '../workers/etf-shares/src/etfPcfLimit.js';

import { handleEtfPcfLimit } from '../workers/etf-shares/src/etfPcfRoutes.js';
import { refreshEtfPcfLimitCache } from '../workers/etf-shares/src/etfPcfUniverse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BYTES = new Uint8Array(
  readFileSync(path.join(__dirname, 'fixtures/etf-pcf/ETF15994120261013.gbk.txt'))
);
// 上海 2026-10-13 10:00：date=2026-10-13 合法且非未来。
// Independent contract: production KV retention is 400 days.
const CACHE_TTL_SECONDS = 400 * 86400;
const NOW = new Date('2026-10-13T02:00:00.000Z');

beforeEach(() => {
  clearEtfPcfRuntimeStateForTests();
});

class FakeKV {
  constructor(initial = new Map()) {
    this.store = initial instanceof Map ? initial : new Map(Object.entries(initial));
    this.getCalls = [];
    this.putCalls = [];
    this.expirations = new Map();
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
    if (options?.expirationTtl) this.expirations.set(key, options.expirationTtl);
    else this.expirations.delete(key);
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
    rawFields: { '当天净申购的基金份额上限': '1300000份' },
    basicRawFields: { '基金名称': '纳指ETF广发' },
    warnings: [],
    sourceUrl: 'https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt',
    fetchedAt: '2026-10-13T01:00:00.000Z',
    expiresAt: new Date(Date.parse('2026-10-13T01:00:00.000Z') + CACHE_TTL_SECONDS * 1000).toISOString(),
    ...overrides
  };
}

function seededKV(data = makeCachedData()) {
  return new FakeKV(new Map([['etf-pcf:159941:20261013', JSON.stringify(data)]]));
}

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

const okBytes = (bytes) => ({ status: 200, arrayBuffer: async () => bytes });
const notFound = () => ({ status: 404 });
const fixtureOk = () => okBytes(FIXTURE_BYTES);

function hangUntilAbort(url, init) {
  return new Promise((resolve, reject) => {
    if (init && init.signal) {
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }
  });
}

// ─── GBK 解码 ─────────────────────────────────────────────────────

test('真实 GBK fixture 在 Node 中解码出正确中文', () => {
  const text = decodeEtfPcf(FIXTURE_BYTES);
  assert.ok(text.includes('纳指ETF广发申购赎回清单'));
  assert.ok(text.includes('基金名称：  纳指ETF广发'));
  assert.ok(text.includes('基金类型：  跨境ETF'));
  assert.ok(text.includes('2026-10-13日 信息内容'));
  assert.ok(text.includes('当天净申购的基金份额上限：  1300000份'));
  assert.ok(text.includes('当天净赎回的基金份额上限：  1000000000份'));
  // 前一交易日段落也存在，防止全文件模糊匹配的测试基底。
  assert.ok(text.includes('2026-10-09日 信息内容'));
});

test('decodeEtfPcf 接受 ArrayBuffer 并拒绝非法 GBK 字节', () => {
  const fromBuffer = decodeEtfPcf(FIXTURE_BYTES.buffer);
  assert.ok(fromBuffer.includes('纳指ETF广发'));
  // 0xFF 不是合法 GBK 首字节；0x81 是双字节首字节但缺少尾字节——fatal 模式都必须抛错。
  // （0x80 是合法单字节 €，不作为负例。）
  assert.throws(() => decodeEtfPcf(new Uint8Array([0xff, 0xff])));
  assert.throws(() => decodeEtfPcf(new Uint8Array([0x81])));
  assert.throws(() => decodeEtfPcf(new Uint8Array([0x81, 0x30])));
  assert.throws(() => decodeEtfPcf('not bytes'), TypeError);
});

// ─── 参数规范化与防御 ──────────────────────────────────────────────

test('code 校验：严格 ^159\\d{3}$ 字符串', () => {
  assert.equal(isValidEtfPcfCode('159941'), true);
  assert.equal(isValidEtfPcfCode('159000'), true);
  for (const bad of [159941, '15994', '1599410', '059941', '15994a', ' 159941', '159941 ', '159941.SZ', '000834', null, undefined, [], {}]) {
    assert.equal(isValidEtfPcfCode(bad), false, String(bad));
  }
});

test('date 校验：真实公历日期 + round-trip', () => {
  assert.equal(isWellFormedEtfPcfDateKey('2026-10-13'), true);
  assert.equal(isWellFormedEtfPcfDateKey('2024-02-29'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '2026/10/13', '20261013', '2026-10-13T00:00:00Z', '2026-10-13 ', '', null, undefined, 20261013, []]) {
    assert.equal(isWellFormedEtfPcfDateKey(bad), false, String(bad));
  }
  // 2026 非闰年。
  assert.equal(isWellFormedEtfPcfDateKey('2026-02-29'), false);
});

test('validateEtfPcfRequest：范围 2000-01-01 至上海当天，跨日按上海时区', () => {
  const ok = validateEtfPcfRequest({ code: '159941', date: '2026-10-13', now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.dateKey, '2026-10-13');
  assert.equal(ok.yyyymmdd, '20261013');

  assert.equal(validateEtfPcfRequest({ code: '159941', date: '1999-12-31', now: NOW }).reason, 'invalid_date');
  assert.equal(validateEtfPcfRequest({ code: '159941', date: '2026-10-14', now: NOW }).reason, 'invalid_date');
  assert.equal(validateEtfPcfRequest({ code: '159941', date: '', now: NOW }).reason, 'invalid_date');
  assert.equal(validateEtfPcfRequest({ code: '159941', date: null, now: NOW }).reason, 'invalid_date');
  assert.equal(validateEtfPcfRequest({ code: '159941', date: '2026-02-30', now: NOW }).reason, 'invalid_date');
  assert.equal(validateEtfPcfRequest({ code: '15941', now: NOW }).reason, 'invalid_code');
  assert.equal(validateEtfPcfRequest({ code: '159941.SZ', now: NOW }).reason, 'invalid_code');
  assert.equal(validateEtfPcfRequest({ code: 159941, now: NOW }).reason, 'invalid_code');

  // date 省略才默认上海当天：UTC 15:59 → 2026-10-13；16:00 → 2026-10-14。
  assert.equal(validateEtfPcfRequest({ code: '159941', now: new Date('2026-10-13T15:59:59.000Z') }).dateKey, '2026-10-13');
  assert.equal(validateEtfPcfRequest({ code: '159941', now: new Date('2026-10-13T16:00:00.000Z') }).dateKey, '2026-10-14');
  // 跨日后当天日期合法（含上海当天）。
  assert.equal(validateEtfPcfRequest({ code: '159941', date: '2026-10-14', now: new Date('2026-10-13T16:00:00.000Z') }).ok, true);
  assert.equal(shanghaiDateKey(new Date('2026-10-13T16:00:00.000Z')), '2026-10-14');
});

test('key/URL 构造器：唯一入口且拒绝原始输入拼接', () => {
  assert.equal(buildEtfPcfCacheKey('159941', '2026-10-13'), 'etf-pcf:159941:20261013');
  assert.equal(
    buildEtfPcfSourceUrl('159941', '2026-10-13'),
    'https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt'
  );
  assert.throws(() => buildEtfPcfCacheKey('15941', '2026-10-13'));
  assert.throws(() => buildEtfPcfCacheKey('159941', '2026-2-30'));
  assert.throws(() => buildEtfPcfSourceUrl('159941.SZ', '2026-10-13'));
  assert.throws(() => buildEtfPcfSourceUrl('159941', '2026/10/13'));
});

// ─── 纯解析：真实 fixture ─────────────────────────────────────────

test('159941 / 2026-10-13 全字段解析：份额、允许状态、现金、rawFields', () => {
  const parsed = parseEtfPcf(decodeEtfPcf(FIXTURE_BYTES), { code: '159941', date: '2026-10-13' });

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.source, 'szse_pcf');
  assert.equal(parsed.code, '159941');
  assert.equal(parsed.date, '2026-10-13');
  assert.equal(parsed.fundName, '纳指ETF广发');
  assert.equal(parsed.fundType, '跨境ETF');
  assert.equal(parsed.fundManager, '广发基金管理有限公司');
  assert.equal(parsed.targetIndexCode, 'NDX');

  // 核心净申赎上限（份额，非人民币金额）。
  assert.equal(parsed.netSubscribeLimitShares, 1300000);
  assert.equal(parsed.netSubscribeLimitKind, 'limited');
  assert.equal(parsed.netRedeemLimitShares, 1000000000);
  assert.equal(parsed.netRedeemLimitKind, 'limited');

  // 账户/累计额度与全基金净额度独立表达。
  assert.equal(parsed.accountNetSubscribeLimitShares, null);
  assert.equal(parsed.accountNetSubscribeLimitKind, 'unlimited');
  assert.equal(parsed.accountNetRedeemLimitShares, null);
  assert.equal(parsed.accountNetRedeemLimitKind, 'unlimited');
  assert.equal(parsed.totalSubscribeLimitShares, null);
  assert.equal(parsed.totalSubscribeLimitKind, 'unlimited');
  assert.equal(parsed.totalRedeemLimitShares, null);
  assert.equal(parsed.totalRedeemLimitKind, 'unlimited');
  assert.equal(parsed.accountTotalSubscribeLimitShares, 1300000);
  assert.equal(parsed.accountTotalSubscribeLimitKind, 'limited');
  assert.equal(parsed.accountTotalRedeemLimitShares, null);
  assert.equal(parsed.accountTotalRedeemLimitKind, 'unlimited');

  assert.equal(parsed.creationRedemptionUnitShares, 1300000);
  assert.equal(parsed.subscriptionAllowed, true);
  assert.equal(parsed.redemptionAllowed, true);
  assert.equal(parsed.estimatedCashDifference, 4275.36);
  assert.equal(parsed.cashSubstitutionRatioLimitPct, 100);
  assert.equal(parsed.iopvRequired, true);
  assert.equal(parsed.unitCashDividend, 0);
  assert.equal(parsed.localBasketSecurityCount, 1);
  assert.equal(parsed.totalBasketSecurityCount, 102);
  assert.deepEqual(parsed.warnings, []);

  // 当日整段全部 label 保留在 rawFields。
  const expectedDayLabels = [
    '预估现金差额',
    '可以现金替代比例上限',
    '是否需要公布IOPV',
    '最小申购、赎回单位',
    '最小申购赎回单位现金红利',
    '本市场申购赎回组合证券只数',
    '全部申购赎回组合证券只数',
    '是否开放申购',
    '是否开放赎回',
    '当天净申购的基金份额上限',
    '当天净赎回的基金份额上限',
    '单个证券账户当天净申购的基金份额上限',
    '单个证券账户当天净赎回的基金份额上限',
    '当天累计可申购的基金份额上限',
    '当天累计可赎回的基金份额上限',
    '单个证券账户当天累计可申购的基金份额上限',
    '单个证券账户当天累计可赎回的基金份额上限'
  ];
  for (const label of expectedDayLabels) {
    assert.ok(parsed.rawFields[label] !== undefined, 'rawFields 缺少 ' + label);
  }
  for (const label of ['基金名称', '基金代码', '基金类型', '基金管理公司名称', '目标指数代码']) {
    assert.ok(parsed.basicRawFields[label] !== undefined, 'basicRawFields 缺少 ' + label);
  }
  assert.equal(parsed.rawFields['全部申购赎回组合证券只数'], '102只(含"159900"证券)');
  // 组合证券明细不解析。
  assert.equal(parsed.rawFields['证券代码'], undefined);
  assert.ok(!Object.keys(parsed.rawFields).includes('AAPL'));
  // fetchedAt/expiresAt 由持久层添加，纯解析结果不含。
  assert.equal(parsed.fetchedAt, undefined);
  assert.equal(parsed.expiresAt, undefined);
  assert.equal(parsed.sourceUrl, undefined);
});

test('前日段不串当天：10-09 字段不进 10-13 结果，请求 10-09 与标题不一致被拒', () => {
  const text = decodeEtfPcf(FIXTURE_BYTES);
  const parsed = parseEtfPcf(text, { code: '159941', date: '2026-10-13' });
  assert.equal(parsed.rawFields['现金差额'], undefined);
  assert.equal(parsed.rawFields['基金份额净值'], undefined);
  assert.equal(parsed.rawFields['最小申购、赎回单位资产净值'], undefined);
  assert.equal(parsed.estimatedCashDifference, 4275.36);

  // 文件标题日期是 2026-10-13，请求 2026-10-09 属身份不符。
  assert.throws(
    () => parseEtfPcf(text, { code: '159941', date: '2026-10-09' }),
    (error) => error instanceof EtfPcfFormatError && error.reason === 'title_date_mismatch'
  );
});

// ─── 纯解析：合成变体 ─────────────────────────────────────────────

function synthPcf({
  code = '159941',
  date = '2026-10-13',
  titleDate = null,
  basic = [],
  day = [],
  sections = [],
  joiner = '\r\n',
  withBom = false,
  omitBasic = false,
  omitBasicHeader = false
} = {}) {
  const lines = ['测试基金申购赎回清单', `( ${titleDate || date} )`, ''];
  if (!omitBasicHeader) {
    lines.push('基本信息', '---');
    if (!omitBasic) {
      lines.push('基金名称：测试ETF', '基金代码：' + code, '基金类型：股票ETF');
      for (const line of basic) lines.push(line);
    }
  }
  lines.push('---', '');
  for (const section of sections) {
    lines.push(section.date + '日 信息内容', '---');
    for (const line of section.lines) lines.push(line);
    lines.push('---', '');
  }
  lines.push(date + '日 信息内容', '---');
  for (const line of day) lines.push(line);
  lines.push('---');
  let text = lines.join(joiner);
  if (withBom) text = '\uFEFF' + text;
  return text;
}

const FULL_DAY = [
  '当天净申购的基金份额上限：1300000份',
  '当天净赎回的基金份额上限：1000000份',
  '最小申购、赎回单位：1,000,000份',
  '是否开放申购：允许',
  '是否开放赎回：是',
  '预估现金差额：-12.50元',
  '最小申购赎回单位现金红利：0.00元',
  '可以现金替代比例上限：50.00%',
  '是否需要公布IOPV：否',
  '本市场申购赎回组合证券只数：1只',
  '全部申购赎回组合证券只数：2只',
  '单个证券账户当天净申购的基金份额上限：0份',
  '单个证券账户当天净赎回的基金份额上限：不设上限',
  '当天累计可申购的基金份额上限：—',
  '当天累计可赎回的基金份额上限：-',
  '单个证券账户当天累计可申购的基金份额上限：500000份',
  '单个证券账户当天累计可赎回的基金份额上限：600000份'
];

test('变体：LF、BOM、全角冒号、千分位、0、不设上限、横线、负现金、暂停、未知字段保留', () => {
  const day = FULL_DAY.slice();
  day[3] = '是否开放申购：暂停'; // 暂停 → false
  day.push('基金公司测试用未知字段：ABC');
  const text = synthPcf({ day, joiner: '\n', withBom: true, basic: ['基金管理人：测试管理有限公司'] });
  const parsed = parseEtfPcf(text, { code: '159941', date: '2026-10-13' });

  assert.equal(parsed.netSubscribeLimitShares, 1300000);
  assert.equal(parsed.netSubscribeLimitKind, 'limited');
  assert.equal(parsed.subscriptionAllowed, false);
  assert.equal(parsed.redemptionAllowed, true);
  assert.equal(parsed.estimatedCashDifference, -12.5);
  assert.equal(parsed.creationRedemptionUnitShares, 1000000); // 千位分隔符
  assert.equal(parsed.unitCashDividend, 0);
  assert.equal(parsed.cashSubstitutionRatioLimitPct, 50);
  assert.equal(parsed.iopvRequired, false);
  assert.equal(parsed.accountNetSubscribeLimitShares, 0);
  assert.equal(parsed.accountNetSubscribeLimitKind, 'limited'); // 0 保留为 limited
  assert.equal(parsed.accountNetRedeemLimitKind, 'unlimited'); // 不设上限
  assert.equal(parsed.totalSubscribeLimitShares, null);
  assert.equal(parsed.totalSubscribeLimitKind, 'unknown'); // 横线 → unknown
  assert.equal(parsed.totalRedeemLimitKind, 'unknown');
  assert.equal(parsed.accountTotalRedeemLimitShares, 600000);
  assert.equal(parsed.fundManager, '测试管理有限公司'); // 备用 label
  // 未知字段不丢失。
  assert.equal(parsed.rawFields['基金公司测试用未知字段'], 'ABC');
  assert.deepEqual(parsed.warnings, []);
});

test('可选字段缺失记 warning 且补 null，不猜成 0 或允许', () => {
  const day = FULL_DAY.filter((line) => !line.startsWith('可以现金替代比例上限'));
  const parsed = parseEtfPcf(synthPcf({ day }), { code: '159941', date: '2026-10-13' });
  assert.equal(parsed.cashSubstitutionRatioLimitPct, null);
  assert.ok(parsed.warnings.some((w) => w.includes('可以现金替代比例上限')));
  // 非核心份额上限缺失 → null + unknown，同样有 warning。
  const day2 = FULL_DAY.filter((line) => !line.startsWith('单个证券账户当天累计可赎回'));
  const parsed2 = parseEtfPcf(synthPcf({ day: day2 }), { code: '159941', date: '2026-10-13' });
  assert.equal(parsed2.accountTotalRedeemLimitShares, null);
  assert.equal(parsed2.accountTotalRedeemLimitKind, 'unknown');
  assert.ok(parsed2.warnings.length > 0);
});

test('同值重复容忍，冲突拒绝；负现金红利不合规记 warning', () => {
  const day = FULL_DAY.concat(['当天净申购的基金份额上限：1300000份']); // 同名同值
  assert.doesNotThrow(() => parseEtfPcf(synthPcf({ day }), { code: '159941', date: '2026-10-13' }));

  const conflict = FULL_DAY.concat(['当天净赎回的基金份额上限：999份']);
  assert.throws(
    () => parseEtfPcf(synthPcf({ day: conflict }), { code: '159941', date: '2026-10-13' }),
    (error) => error instanceof EtfPcfFormatError && error.reason === 'duplicate_field_conflict'
  );

  const day3 = FULL_DAY.map((line) => (line.startsWith('最小申购赎回单位现金红利') ? '最小申购赎回单位现金红利：-5.00元' : line));
  const parsed3 = parseEtfPcf(synthPcf({ day: day3 }), { code: '159941', date: '2026-10-13' });
  assert.equal(parsed3.unitCashDividend, null); // 现金红利不接受负值
  assert.ok(parsed3.warnings.some((w) => w.includes('最小申购赎回单位现金红利')));
});

test('解析拒绝：非法参数、空文本、HTML 错误页、缺失段落与基础信息', () => {
  const fullText = synthPcf({ day: FULL_DAY });

  assert.throws(() => parseEtfPcf(fullText, { code: '15941', date: '2026-10-13' }), EtfPcfFormatError);
  assert.throws(() => parseEtfPcf(fullText, { code: '159941', date: '2026-13-01' }), EtfPcfFormatError);
  assert.throws(() => parseEtfPcf('', { code: '159941', date: '2026-10-13' }), EtfPcfFormatError);
  assert.throws(() => parseEtfPcf('   \r\n \n', { code: '159941', date: '2026-10-13' }), EtfPcfFormatError);

  // 200 的 HTML 错误页伪装。
  assert.throws(
    () => parseEtfPcf('<html><head><title>Error</title></head><body>Not Found</body></html>', { code: '159941', date: '2026-10-13' }),
    (error) => error instanceof EtfPcfFormatError && error.reason === 'missing_title_date'
  );

  const missingSection = synthPcf({ date: '2026-10-09', titleDate: '2026-10-13', day: ['现金差额：1.00元'] });
  assert.throws(
    () => parseEtfPcf(missingSection, { code: '159941', date: '2026-10-13' }),
    (error) => error instanceof EtfPcfFormatError && error.reason === 'missing_day_section'
  );

  assert.throws(
    () => parseEtfPcf(synthPcf({ day: FULL_DAY, omitBasic: true }), { code: '159941', date: '2026-10-13' }),
    (error) => error.reason === 'missing_fund_name'
  );
  assert.throws(
    () => parseEtfPcf(synthPcf({ day: FULL_DAY, omitBasicHeader: true }), { code: '159941', date: '2026-10-13' }),
    (error) => error.reason === 'missing_basic_info'
  );
  assert.throws(
    () => parseEtfPcf(synthPcf({ day: [], basic: [] }), { code: '159941', date: '2026-10-13' }),
    (error) => error.reason === 'missing_core_field'
  );
  assert.throws(
    () => parseEtfPcf(synthPcf({ titleDate: '2026-13-01', day: FULL_DAY }), { code: '159941', date: '2026-10-13' }),
    (error) => error.reason === 'title_date_invalid'
  );
  assert.throws(
    () => parseEtfPcf(synthPcf({ day: FULL_DAY, sections: [{ date: '2026-99-01', lines: [] }] }), { code: '159941', date: '2026-10-13' }),
    (error) => error.reason === 'segment_date_invalid'
  );
});

test('解析拒绝：正文代码不符、核心字段损坏、非法日期段落标题', () => {
  const text = synthPcf({ code: '159941', day: FULL_DAY });
  assert.throws(
    () => parseEtfPcf(text, { code: '159001', date: '2026-10-13' }),
    (error) => error.reason === 'code_mismatch'
  );

  const decimal = FULL_DAY.map((l) => (l.startsWith('当天净申购') ? '当天净申购的基金份额上限：1300000.5份' : l));
  assert.throws(
    () => parseEtfPcf(synthPcf({ day: decimal }), { code: '159941', date: '2026-10-13' }),
    (error) => error.reason === 'corrupt_core_field'
  );

  const unsafe = FULL_DAY.map((l) => (l.startsWith('当天净申购') ? '当天净申购的基金份额上限：99999999999999999999份' : l));
  assert.throws(
    () => parseEtfPcf(synthPcf({ day: unsafe }), { code: '159941', date: '2026-10-13' }),
    (error) => error.reason === 'corrupt_core_field'
  );

  const optionalCorrupt = FULL_DAY.map((l) => (l.startsWith('单个证券账户当天净申购') ? '单个证券账户当天净申购的基金份额上限：abc份' : l));
  const parsed = parseEtfPcf(synthPcf({ day: optionalCorrupt }), { code: '159941', date: '2026-10-13' });
  assert.equal(parsed.accountNetSubscribeLimitShares, null);
  assert.equal(parsed.accountNetSubscribeLimitKind, 'unknown');
  assert.ok(parsed.warnings.some((w) => w.includes('单个证券账户当天净申购的基金份额上限')));
});

// ─── fetchEtfPcfText：单次外部请求 ─────────────────────────────────

test('fetchEtfPcfText：404/HTTP 错误/网络异常分类', async () => {
  const kv404 = await fetchEtfPcfText({ code: '159941', date: '2026-10-13', fetchImpl: mockFetch(() => notFound()) });
  assert.equal(kv404.ok, false);
  assert.equal(kv404.reason, 'upstream_not_found');
  assert.equal(kv404.status, 404);

  const http500 = await fetchEtfPcfText({ code: '159941', date: '2026-10-13', fetchImpl: mockFetch(() => ({ status: 500 })) });
  assert.equal(http500.ok, false);
  assert.equal(http500.reason, 'http_error');
  assert.equal(http500.status, 502);
  assert.equal(http500.httpStatus, 500);

  const networkFail = await fetchEtfPcfText({ code: '159941', date: '2026-10-13', fetchImpl: mockFetch(() => { throw new Error('network down'); }) });
  assert.equal(networkFail.ok, false);
  assert.equal(networkFail.reason, 'fetch_failed');
  assert.equal(networkFail.status, 502);

  const invalid = await fetchEtfPcfText({ code: '15941', date: '2026-10-13', fetchImpl: mockFetch(() => { throw new Error('must not fetch'); }) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.reason, 'invalid_params');
  assert.equal(invalid.sourceUrl, undefined);
});

test('fetchEtfPcfText：5 秒全程超时与外部 abort → 504，拒绝跳转', async () => {
  const fetchFn = mockFetch(hangUntilAbort);
  const timedOut = await fetchEtfPcfText({ code: '159941', date: '2026-10-13', fetchImpl: fetchFn, timeoutMs: 25 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'timeout');
  assert.equal(timedOut.status, 504);
  // Workers 运行时不支持 redirect:'error'（调用即抛 TypeError），必须传 'manual'。
  assert.equal(fetchFn.calls[0].init.redirect, 'manual');

  const external = new AbortController();
  setTimeout(() => external.abort(), 10);
  const aborted = await fetchEtfPcfText({
    code: '159941',
    date: '2026-10-13',
    fetchImpl: fetchFn,
    signal: external.signal,
    timeoutMs: 5000
  });
  assert.equal(aborted.reason, 'aborted');
  assert.equal(aborted.status, 504);
});

test('fetchEtfPcfText：Workers 运行时兼容（redirect 绝不传 error）与 3xx 拒绝', async () => {
  // 复刻 Cloudflare Workers 行为：redirect:'error' 在调用时直接抛 TypeError。
  const workersStrictFetch = mockFetch((url, init = {}) => {
    if (init.redirect === 'error') {
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    }
    return fixtureOk();
  });
  const ok = await fetchEtfPcfText({ code: '159941', date: '2026-10-13', fetchImpl: workersStrictFetch });
  assert.equal(ok.ok, true);
  assert.equal(workersStrictFetch.calls[0].init.redirect, 'manual');

  // 3xx 必须被拒绝且不跟随（单次调用），归为 http_error（非瞬态，不重试）。
  const redirectFetch = mockFetch(() => ({ status: 302, headers: { get: () => 'https://example.invalid/x' } }));
  const redirected = await fetchEtfPcfText({ code: '159941', date: '2026-10-13', fetchImpl: redirectFetch });
  assert.equal(redirected.ok, false);
  assert.equal(redirected.reason, 'http_error');
  assert.equal(redirected.httpStatus, 302);
  assert.equal(redirectFetch.calls.length, 1);
});

test('fetchEtfPcfText：超限（content-length 与实际 body）拒绝且不返回正文', async () => {
  let bodyRead = false;
  const bigLength = await fetchEtfPcfText({
    code: '159941',
    date: '2026-10-13',
    fetchImpl: mockFetch(() => ({ status: 200, headers: { get: (name) => (name === 'content-length' ? String(1024 * 1024 + 1) : null) }, arrayBuffer: async () => { bodyRead = true; return new Uint8Array(0); } }))
  });
  assert.equal(bigLength.ok, false);
  assert.equal(bigLength.reason, 'fetch_failed');
  assert.equal(bigLength.status, 502);
  assert.equal(bodyRead, false);

  const bigBody = await fetchEtfPcfText({
    code: '159941',
    date: '2026-10-13',
    fetchImpl: mockFetch(() => okBytes(new Uint8Array(1024 * 1024 + 1)))
  });
  assert.equal(bigBody.ok, false);
  assert.equal(bigBody.status, 502);
});

test('fetchEtfPcfText：成功返回真实 fixture 字节与 sourceUrl', async () => {
  const fetchFn = mockFetch(() => fixtureOk());
  const result = await fetchEtfPcfText({ code: '159941', date: '2026-10-13', fetchImpl: fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.sourceUrl, 'https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt');
  assert.equal(result.bytes.byteLength, FIXTURE_BYTES.byteLength);
  assert.equal(fetchFn.calls[0].method, 'GET');
  assert.equal(decodeEtfPcf(result.bytes).includes('纳指ETF广发'), true);
});

// ─── readEtfPcfLimitCache：只读 memory/KV，绝不访问外部源 ──────────

test('缓存读取：缺 binding 503、非法参数 400 且不碰 KV', async () => {
  const noKv = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: {} });
  assert.equal(noKv.status, 503);
  assert.equal(noKv.reason, 'kv_unavailable');

  const kv = new FakeKV();
  const invalid = await readEtfPcfLimitCache({ code: '15941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, now: NOW });
  assert.equal(invalid.status, 400);
  assert.equal(kv.getCalls.length, 0);
  const invalidDate = await readEtfPcfLimitCache({ code: '159941', date: '2026-02-30', env: { FUND_LIMIT_KV: kv }, now: NOW });
  assert.equal(invalidDate.status, 400);
  assert.equal(kv.getCalls.length, 0);
});

test('缓存读取：miss 404、命中 200、memory 命中不再读 KV', async () => {
  const kv = new FakeKV();
  const miss = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, now: NOW });
  assert.equal(miss.status, 404);
  assert.equal(miss.reason, 'cache_miss');

  const seeded = seededKV();
  const hit = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: seeded }, now: NOW });
  assert.equal(hit.status, 200);
  assert.equal(hit.data.cached, true);
  assert.equal(hit.data.fundName, '纳指ETF广发');
  assert.equal(seeded.getCalls.length, 1);

  // 首次读 KV 后进入 memory；此时即使 KV get 抛错也应从 memory 命中。
  seeded.getImpl = () => {
    throw new Error('kv down');
  };
  const fromMemory = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: seeded }, now: NOW });
  assert.equal(fromMemory.status, 200);
  assert.equal(fromMemory.data.cached, true);
  assert.equal(seeded.getCalls.length, 1);
});

test('缓存读取：过期/未来时间/身份不符/损坏 JSON/source/schema 异常均视为 miss', async () => {
  const cases = [
    { overrides: { expiresAt: '2026-10-13T01:30:00.000Z' }, reason: 'expired' },
    { overrides: { fetchedAt: '2026-10-13T03:00:00.000Z' }, reason: 'future_fetched_at' },
    { overrides: { expiresAt: new Date(Date.parse('2026-10-13T01:00:00.000Z') + CACHE_TTL_SECONDS * 1000 + 60001).toISOString() }, reason: 'ttl_anomaly' },
    { overrides: { expiresAt: '2026-10-13T01:00:00.000Z' }, reason: 'expiry_range' },
    { overrides: { code: '159001' }, reason: 'identity' },
    { overrides: { date: '2026-10-12' }, reason: 'identity' },
    { overrides: { source: 'eastmoney' }, reason: 'source' },
    { overrides: { schemaVersion: 2 }, reason: 'schema_version' },
    { overrides: { fundName: '' }, reason: 'fund_name' },
    { overrides: { fundType: null }, reason: 'fund_type' },
    { overrides: { netSubscribeLimitKind: 'limited', netSubscribeLimitShares: null }, reason: 'netSubscribeLimitShares' },
    { overrides: { netRedeemLimitKind: 'maybe' }, reason: 'netRedeemLimitKind' },
    { overrides: { estimatedCashDifference: 'NaN' }, reason: 'estimatedCashDifference' },
    { overrides: { cashSubstitutionRatioLimitPct: 120 }, reason: 'cash_substitution_ratio' },
    { overrides: { creationRedemptionUnitShares: 0 }, reason: 'creation_unit' },
    { overrides: { subscriptionAllowed: 'yes' }, reason: 'subscriptionAllowed' },
    { overrides: { totalBasketSecurityCount: -1 }, reason: 'totalBasketSecurityCount' },
    { overrides: { rawFields: { x: 1 } }, reason: 'raw_fields' },
    { overrides: { basicRawFields: null }, reason: 'basic_raw_fields' },
    { overrides: { warnings: 'ok' }, reason: 'warnings' },
    { overrides: { fetchedAt: 'not-a-date' }, reason: 'timestamps' },
    { overrides: { accountTotalRedeemLimitShares: 1.5 }, reason: 'accountTotalRedeemLimitShares' }
  ];
  for (const { overrides } of cases) {
    const kv = seededKV(makeCachedData(overrides));
    const result = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, now: NOW });
    assert.equal(result.status, 404, JSON.stringify(overrides));
    assert.equal(result.reason, 'cache_miss', JSON.stringify(overrides));
  }

  const corruptKV = new FakeKV(new Map([['etf-pcf:159941:20261013', '{"code":broken']]));
  const corrupt = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: corruptKV }, now: NOW });
  assert.equal(corrupt.status, 404);
  assert.equal(corrupt.reason, 'cache_miss');
});

test('缓存读取：KV 服务异常 503，inflight 刷新可被只读请求等待', async () => {
  const failing = seededKV();
  failing.getImpl = () => {
    throw new Error('kv read down');
  };
  const result = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: failing }, now: NOW });
  assert.equal(result.status, 503);
  assert.equal(result.reason, 'kv_read_failed');

  // inflight：同 key 刷新进行中时，只读请求等待其结果而不是打上游。
  const fetchFn = mockFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return fixtureOk();
  });
  const kv = new FakeKV();
  const refreshing = fetchEtfPcfLimit({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, forceRefresh: true, now: NOW, fetchImpl: fetchFn });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const joined = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, now: NOW });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.cached, true);
  assert.equal(fetchFn.calls.length, 1);
  const refreshed = await refreshing;
  assert.equal(refreshed.ok, true);
});

// ─── fetchEtfPcfLimit：缓存优先 + 抓取/解析/写 KV ───────────────────

test('fetchEtfPcfLimit：非法参数与缺 binding 不触发外部请求', async () => {
  const kv = new FakeKV();
  const fetchFn = mockFetch(() => { throw new Error('must not fetch'); });
  const invalid = await fetchEtfPcfLimit({ code: '15941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, now: NOW, fetchImpl: fetchFn });
  assert.equal(invalid.status, 400);
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(kv.getCalls.length, 0);

  const noKv = await fetchEtfPcfLimit({ code: '159941', date: '2026-10-13', env: {}, now: NOW, fetchImpl: fetchFn });
  assert.equal(noKv.status, 503);
  assert.equal(noKv.reason, 'kv_unavailable');
  assert.equal(fetchFn.calls.length, 0);
});

test('fetchEtfPcfLimit：默认缓存优先，forceRefresh 才绕过缓存抓取', async () => {
  const kv = seededKV();
  const fetchFn = mockFetch(() => fixtureOk());
  const cached = await fetchEtfPcfLimit({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, now: NOW, fetchImpl: fetchFn });
  assert.equal(cached.ok, true);
  assert.equal(cached.data.cached, true);
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(kv.putCalls.length, 0);

  const fresh = await fetchEtfPcfLimit({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, forceRefresh: true, now: NOW, fetchImpl: fetchFn });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.data.cached, false);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(kv.putCalls.length, 1);
  assert.equal(kv.putCalls[0].key, 'etf-pcf:159941:20261013');
  assert.equal(kv.putCalls[0].options.expirationTtl, CACHE_TTL_SECONDS);
  const persisted = JSON.parse(kv.putCalls[0].value);
  assert.equal(persisted.code, '159941');
  assert.equal(persisted.date, '2026-10-13');
  assert.equal(persisted.fetchedAt, '2026-10-13T02:00:00.000Z');
  assert.equal(persisted.expiresAt, new Date(+NOW + CACHE_TTL_SECONDS * 1000).toISOString());
  assert.equal('cached' in persisted, false); // cached 标记不进持久化
  assert.equal(persisted.netSubscribeLimitShares, 1300000);
  assert.equal(persisted.netRedeemLimitShares, 1000000000);
  assert.equal(persisted.fundName, '纳指ETF广发');
  assert.equal(fresh.data.netSubscribeLimitShares, 1300000);
  assert.equal(fresh.data.subscriptionAllowed, true);
  assert.equal(fresh.data.estimatedCashDifference, 4275.36);

  // 写入后读缓存 round-trip。
  const reread = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, now: NOW });
  assert.equal(reread.status, 200);
  assert.equal(reread.data.cached, true);
  assert.equal(reread.data.sourceUrl, 'https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt');
});

test('fetchEtfPcfLimit：KV 写失败返回 503，不冒充已缓存', async () => {
  const kv = new FakeKV();
  kv.putImpl = () => {
    throw new Error('kv write down');
  };
  const result = await fetchEtfPcfLimit({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, forceRefresh: true, now: NOW, fetchImpl: mockFetch(() => fixtureOk()) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.reason, 'kv_write_failed');
  // 写失败后 memory 也未写入。
  const reread = await readEtfPcfLimitCache({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, now: NOW });
  assert.equal(reread.status, 404);
});

test('fetchEtfPcfLimit：上游 404 不覆盖同日有效旧值，不返回其它日期', async () => {
  const original = makeCachedData();
  const kv = seededKV(original);
  const result = await fetchEtfPcfLimit({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, forceRefresh: true, now: NOW, fetchImpl: mockFetch(() => notFound()) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.reason, 'upstream_not_found');
  assert.equal(kv.putCalls.length, 0);
  const still = JSON.parse(kv.store.get('etf-pcf:159941:20261013'));
  assert.equal(still.fetchedAt, original.fetchedAt);
  assert.equal(still.date, '2026-10-13');
});

test('fetchEtfPcfLimit：GBK 非法字节与正文代码不符分别返回 decode/parse 502', async () => {
  const decodeFail = await fetchEtfPcfLimit({
    code: '159941',
    date: '2026-10-13',
    env: { FUND_LIMIT_KV: new FakeKV() },
    forceRefresh: true,
    now: NOW,
    fetchImpl: mockFetch(() => okBytes(new Uint8Array([0xff, 0xfe, 0xff])))
  });
  assert.equal(decodeFail.status, 502);
  assert.equal(decodeFail.reason, 'decode_failed');

  // 把 fixture 的正文代码改成 159001 后按 159941 请求 → 身份不符。
  const wrongCodeBytes = fixtureForCode('159001');
  const parseFail = await fetchEtfPcfLimit({
    code: '159941',
    date: '2026-10-13',
    env: { FUND_LIMIT_KV: new FakeKV() },
    forceRefresh: true,
    now: NOW,
    fetchImpl: mockFetch(() => okBytes(wrongCodeBytes))
  });
  assert.equal(parseFail.status, 502);
  assert.equal(parseFail.reason, 'parse_failed');
});

test('fetchEtfPcfLimit：同 key 并发 inflight 去重且完成后清理', async () => {
  const fetchFn = mockFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return fixtureOk();
  });
  const kv = new FakeKV();
  const [a, b] = await Promise.all([
    fetchEtfPcfLimit({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, forceRefresh: true, now: NOW, fetchImpl: fetchFn }),
    fetchEtfPcfLimit({ code: '159941', date: '2026-10-13', env: { FUND_LIMIT_KV: kv }, forceRefresh: true, now: NOW, fetchImpl: fetchFn })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(fetchFn.calls.length, 1); // inflight 合并，只抓一次
  assert.equal(a.data.fetchedAt, b.data.fetchedAt);

  // inflight 完成后清理：下一次失败不会拿到上一次的缓存任务结果。
  const failed = await fetchEtfPcfLimit({
    code: '159941',
    date: '2026-10-13',
    env: { FUND_LIMIT_KV: kv },
    forceRefresh: true,
    now: NOW,
    fetchImpl: mockFetch(() => notFound())
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'upstream_not_found');
});

// fixture 中的正文代码「159941」是纯 ASCII 字节；前置空格保证 GBK 双字节对齐
//（0x20 不可能是 GBK 尾字节），因此可安全地按字节替换为其它 6 位代码，
// 用于构造「探测到但正文身份不符」等负例，不需要 GBK 编码器。
function fixtureForCode(code) {
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
  assert.ok(replaced >= 1, 'fixture 中的代码标记未找到');
  return out;
}

// 历史样本来自留存 backfill；期望值独立抄自 CSV，不能由被测结果推导。
const HISTORY_NOW = new Date('2026-10-13T16:00:00.000Z');
const HISTORY_VALUES = {159501: 5000000, 159509: 8000000, 159513: null, 159632: null,
  159659: null, 159660: 500000, 159696: 1000000, 159941: 1300000};
function historyFixture(code = '159941', date = '2026-10-13') {
  return JSON.parse(readFileSync(path.join(__dirname, 'fixtures/etf-pcf-history',
    `ETF${code}${date.replaceAll('-', '')}.backfill.json`), 'utf8'));
}
function historyCheck(data, options = {}) {
  return validateEtfPcfHistoryData(data, {code: '159941', date: '2026-10-13', now: HISTORY_NOW, ...options});
}
async function routeGet(kv, code, date, now = HISTORY_NOW) {
  const query = new URLSearchParams({code, refresh: '1', force: '1'});
  if (date !== undefined) query.set('date', date);
  return handleEtfPcfLimit(new Request('https://local/api/etf-pcf-limit?' + query),
    {FUND_LIMIT_KV: kv}, {}, query, now);
}

test('历史八只真实 CSV 净申购值：次日归档和完整当日缓存均可读', async () => {
  for (const [code, shares] of Object.entries(HISTORY_VALUES)) {
    const data = historyFixture(code);
    const kind = shares === null ? 'unlimited' : 'limited';
    assert.equal(data.netSubscribeLimitShares, shares);
    assert.equal(data.netSubscribeLimitKind, kind);
    assert.equal(historyCheck(data, {code}).ok, true);
    for (const field of ['rawFields', 'fetchedAt', 'expiresAt', 'sourceUrl']) assert.equal(field in data, false);
    const kv = new FakeKV(new Map([[buildEtfPcfCacheKey(code, data.date), JSON.stringify(data)]]));
    const hit = await readEtfPcfLimitCache({code, date: data.date, env: {FUND_LIMIT_KV: kv}, now: HISTORY_NOW});
    assert.equal(hit.data.cached, true);
    clearEtfPcfRuntimeStateForTests();
    // 当日完整缓存为派生测试对象，不声称恢复了真实原文或采集时间。
    const full = {...data, rawFields: {}, fetchedAt: NOW.toISOString(),
      expiresAt: new Date(+NOW + CACHE_TTL_SECONDS * 1000).toISOString(), sourceUrl: buildEtfPcfSourceUrl(code, data.date)};
    kv.store.set(buildEtfPcfCacheKey(code, data.date), JSON.stringify(full));
    const today = await readEtfPcfLimitCache({code, date: data.date, env: {FUND_LIMIT_KV: kv}, now: NOW});
    assert.equal(today.data.netSubscribeLimitShares, shares);
    assert.equal(today.data.netSubscribeLimitKind, kind);
    assert.equal(kv.putCalls.length, 0);
    clearEtfPcfRuntimeStateForTests();
  }
});

test('历史 validator：身份、必填/可选 shape 和时间规则', () => {
  const data = historyFixture();
  assert.deepEqual(historyCheck(data), {ok: true});
  assert.equal(historyCheck(makeCachedData({expiresAt: '2026-10-12T00:00:00Z'})).ok, true);
  assert.equal(historyCheck(parseEtfPcf(decodeEtfPcf(FIXTURE_BYTES), {code: data.code, date: data.date})).ok, true);
  for (const bad of [null, [], 'x', {...data, schemaVersion: 2}, {...data, source: 'sse_pcf'},
    {...data, code: '159501'}, {...data, date: '2025-10-13'}, {...data, fundName: ''}, {...data, fundType: null}]) {
    assert.equal(historyCheck(bad).ok, false);
  }
  for (const field of ['basicRawFields', 'rawFields']) {
    for (const value of [null, [], {x: 1}]) assert.equal(historyCheck({...data, [field]: value}).ok, false);
  }
  assert.equal(historyCheck({...data, basicRawFields: undefined}).ok, false);
  for (const warnings of [undefined, null, {}, [1]]) assert.equal(historyCheck({...data, warnings}).ok, false);
  for (const field of ['fetchedAt', 'expiresAt']) {
    for (const value of [null, 123, 'bad', '2026-10-12']) assert.equal(historyCheck({...data, [field]: value}).ok, false);
  }
  assert.equal(historyCheck({...data, fetchedAt: '2026-10-13T16:00:01Z'}).ok, false);
  assert.equal(historyCheck({...data, sourceUrl: 'https://example.com'}).ok, false);
  for (const options of [{code: '513100'}, {date: '2026-02-30'}, {date: '1999-12-31'},
    {date: '2026-10-14'}, {now: NOW}]) assert.equal(historyCheck(data, options).ok, false);
});

test('历史 validator：八组配对逐一验证以及数值布尔边界', () => {
  const data = historyFixture();
  for (const prefix of ['netSubscribe', 'netRedeem', 'accountNetSubscribe', 'accountNetRedeem',
    'totalSubscribe', 'totalRedeem', 'accountTotalSubscribe', 'accountTotalRedeem']) {
    const shares = prefix + 'LimitShares', kind = prefix + 'LimitKind';
    for (const value of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      assert.equal(historyCheck({...data, [kind]: 'limited', [shares]: value}).ok, false, prefix);
    }
    assert.equal(historyCheck({...data, [kind]: 'limited', [shares]: 0}).ok, true);
    assert.equal(historyCheck({...data, [kind]: 'bad'}).ok, false);
    for (const k of ['unlimited', 'unknown']) {
      assert.equal(historyCheck({...data, [kind]: k, [shares]: null}).ok, true);
      for (const value of [0, 1, undefined]) assert.equal(historyCheck({...data, [kind]: k, [shares]: value}).ok, false);
    }
  }
  const badFields = {creationRedemptionUnitShares: [0, -1, 1.5, '1'],
    estimatedCashDifference: [Infinity, NaN, '1'], unitCashDividend: [Infinity, '0'],
    cashSubstitutionRatioLimitPct: [-1, 101, Infinity, '50'],
    localBasketSecurityCount: [-1, 1.5, '1'], totalBasketSecurityCount: [-1, Number.MAX_SAFE_INTEGER + 1],
    subscriptionAllowed: ['true', 1], redemptionAllowed: ['false'], iopvRequired: ['yes'],
    fundManager: [1], targetIndexCode: [1]};
  for (const [field, values] of Object.entries(badFields)) {
    for (const value of values) assert.equal(historyCheck({...data, [field]: value}).ok, false, field);
    assert.equal(historyCheck({...data, [field]: null}).ok, true, field);
  }
  for (const value of [0, 100]) assert.equal(historyCheck({...data, cashSubstitutionRatioLimitPct: value}).ok, true);
});

test('GET 历史真实首日/memory/损坏/miss 都只读；午夜前精简末日必须 miss', async (t) => {
  const fetchFn = mockFetch(() => {throw new Error('GET must never fetch');});
  t.mock.method(globalThis, 'fetch', fetchFn);
  const first = historyFixture('159941', '2025-10-13');
  const key = buildEtfPcfCacheKey(first.code, first.date);
  const kv = new FakeKV(new Map([[key, JSON.stringify(first)]]));
  for (let i = 0; i < 2; i++) {
    const response = await routeGet(kv, first.code, first.date);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.netSubscribeLimitShares, 6500000);
    assert.equal(body.netSubscribeLimitKind, 'limited');
    assert.equal(body.cached, true);
    assert.equal(body.source, 'szse_pcf');
    assert.equal(body.date, first.date);
  }
  assert.deepEqual(kv.getCalls, [key]);
  clearEtfPcfRuntimeStateForTests();
  for (const raw of [undefined, '{bad', JSON.stringify({...first, code: '159501'}),
    JSON.stringify({...first, warnings: undefined})]) {
    kv.store.clear();
    if (raw !== undefined) kv.store.set(key, raw);
    const response = await routeGet(kv, first.code, first.date);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).reason, 'cache_miss');
  }
  const last = historyFixture();
  kv.store.set(buildEtfPcfCacheKey(last.code, last.date), JSON.stringify(last));
  assert.equal((await routeGet(kv, last.code, last.date, new Date('2026-10-13T15:59:59Z'))).status, 404);
  assert.equal((await routeGet(kv, last.code, last.date)).status, 200);
  // 同一 memory 在不同业务时刻仍需重新校验，不可绕过严格分支。
  assert.equal((await routeGet(kv, last.code, last.date, NOW)).status, 404);
  assert.equal((await routeGet(kv, last.code, undefined)).status, 404);
  kv.getImpl = () => {throw new Error('down');};
  assert.equal((await routeGet(kv, first.code, first.date)).status, 503);
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(kv.putCalls.length, 0);
});

test('历史 POST 强制覆盖：永久/旧 TTL 都移除 TTL，重复修正保留完整来源', async (t) => {
  const fetchFn = mockFetch(fixtureOk);
  t.mock.method(globalThis, 'fetch', fetchFn);
  for (const oldTtl of [undefined, 86400]) {
    clearEtfPcfRuntimeStateForTests();
    const kv = seededKV(historyFixture());
    if (oldTtl) kv.expirations.set('etf-pcf:159941:20261013', oldTtl);
    for (let i = 0; i < 2; i++) {
      const response = await handleEtfPcfLimit(new Request('https://local/api/etf-pcf-limit', {
        method: 'POST', body: JSON.stringify({code: '159941', date: '2026-10-13'})}),
      {FUND_LIMIT_KV: kv}, {}, new URLSearchParams(), HISTORY_NOW);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.cached, false);
      assert.equal(body.fetchedAt, HISTORY_NOW.toISOString());
      assert.equal(body.netSubscribeLimitShares, 1300000);
      assert.ok(Object.keys(body.rawFields).length > 10);
      assert.equal('expiresAt' in body, false);
      const put = kv.putCalls.at(-1);
      assert.equal(put.key, 'etf-pcf:159941:20261013');
      assert.equal(put.options, undefined);
      assert.equal('expiresAt' in JSON.parse(put.value), false);
      assert.equal(kv.expirations.has(put.key), false);
    }
  }
  for (const call of fetchFn.calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.url, buildEtfPcfSourceUrl('159941', '2026-10-13'));
  }
});

test('历史 POST 失败保留旧值；等待 inflight 失败读旧 KV；写失败不更新 memory', async () => {
  for (const status of [404, 302, 500]) {
    clearEtfPcfRuntimeStateForTests();
    const original = JSON.stringify(historyFixture());
    const kv = seededKV(historyFixture());
    let release;
    const fetchFn = mockFetch(() => new Promise(resolve => {release = () => resolve({status});}));
    const refresh = fetchEtfPcfLimit({code: '159941', date: '2026-10-13', env: {FUND_LIMIT_KV: kv},
      now: HISTORY_NOW, forceRefresh: true, fetchImpl: fetchFn});
    const read = readEtfPcfLimitCache({code: '159941', date: '2026-10-13', env: {FUND_LIMIT_KV: kv}, now: HISTORY_NOW});
    release();
    assert.equal((await refresh).ok, false);
    assert.equal((await read).data.cached, true);
    assert.equal(kv.putCalls.length, 0);
    assert.equal(kv.store.get('etf-pcf:159941:20261013'), original);
  }
  clearEtfPcfRuntimeStateForTests();
  const kv = new FakeKV();
  kv.putImpl = () => {throw new Error('down');};
  const args = {code: '159941', date: '2026-10-13', env: {FUND_LIMIT_KV: kv}, now: HISTORY_NOW,
    forceRefresh: true, fetchImpl: mockFetch(fixtureOk)};
  assert.equal((await fetchEtfPcfLimit(args)).reason, 'kv_write_failed');
  assert.equal((await readEtfPcfLimitCache(args)).status, 404);
  kv.putImpl = undefined;
  assert.equal((await fetchEtfPcfLimit(args)).ok, true);
});

test('历史 inflight 合并、成功重校验调用 now、不同日期不串 key', async () => {
  const kv = new FakeKV();
  let release;
  const fetchFn = mockFetch(() => new Promise(resolve => {release = () => resolve(fixtureOk());}));
  const args = {code: '159941', date: '2026-10-13', env: {FUND_LIMIT_KV: kv}, now: HISTORY_NOW,
    forceRefresh: true, fetchImpl: fetchFn};
  const a = fetchEtfPcfLimit(args), b = fetchEtfPcfLimit(args);
  const read = readEtfPcfLimitCache(args);
  // 刷新结果 fetchedAt 晚于这个 GET 的 now，等待成功仍必须拒绝。
  const earlier = readEtfPcfLimitCache({...args, now: NOW});
  const other = await readEtfPcfLimitCache({...args, date: '2026-10-12'});
  assert.equal(other.reason, 'cache_miss');
  release();
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
  assert.equal((await read).data.cached, true);
  assert.equal((await earlier).reason, 'cache_miss');
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(kv.putCalls.length, 1);
});

test('cron 单标的当日刷新不修改历史永久 key，TTL 保持 400 天', async () => {
  const history = historyFixture('159941', '2025-10-13');
  const key = buildEtfPcfCacheKey(history.code, history.date);
  const original = JSON.stringify(history);
  const kv = new FakeKV(new Map([[key, original]]));
  await refreshEtfPcfLimitCache({codes: ['159941'], date: '2026-10-13', env: {FUND_LIMIT_KV: kv},
    now: NOW, fetchImpl: mockFetch(fixtureOk)});
  assert.equal(kv.store.get(key), original);
  assert.equal(kv.expirations.has(key), false);
  assert.equal(kv.putCalls.length, 1);
  assert.equal(kv.putCalls[0].key, 'etf-pcf:159941:20261013');
  assert.equal(kv.putCalls[0].options.expirationTtl, CACHE_TTL_SECONDS);
});

test('P 日真实数值与原始净值精度，T 日现金不串段', () => {
  const p = parseEtfPcf(decodeEtfPcf(FIXTURE_BYTES), { code: '159941', date: '2026-10-13' });
  assert.equal(p.prevDayDate, '2026-10-09');
  assert.equal(p.prevDayCashDifference, 5388);
  assert.equal(p.prevDayUnitNav, 2014903.94);
  assert.equal(p.prevDayNav, 1.5499);
  assert.equal(p.estimatedCashDifference, 4275.36);
});

test('P 日缺失、不可识别静默；最近较早日期与标签优先级和变体', () => {
  const parse = (sections) => parseEtfPcf(synthPcf({ day: FULL_DAY, sections }), { code: '159941', date: '2026-10-13' });
  const empty = parse([]);
  for (const key of ['prevDayDate', 'prevDayCashDifference', 'prevDayUnitNav', 'prevDayNav']) assert.equal(empty[key], null);
  const p = parse([
    { date: '2026-10-08', lines: ['现金差额：999'] },
    { date: '2026-10-14', lines: ['现金差额：888'] },
    { date: '2026-10-09', lines: ['现金差额：无法识别', '最小申购、赎回单位的现金差额：123', '基金份额净值：1.5499'] }
  ]);
  assert.equal(p.prevDayDate, '2026-10-09');
  assert.equal(p.prevDayCashDifference, null);
  assert.equal(p.prevDayUnitNav, null);
  assert.equal(p.prevDayNav, 1.5499);
  assert.deepEqual(p.warnings, empty.warnings);
  const variant = parse([{ date: '2026-10-12', lines: ['最小申购、赎回单位的现金差额：-8933.50', '最小申购、赎回单位净值：12345.67', '基金份额净值：坏值'] }]);
  assert.equal(variant.prevDayCashDifference, -8933.5);
  assert.equal(variant.prevDayUnitNav, 12345.67);
  assert.equal(variant.prevDayNav, null);
  const preferred = parse([{ date: '2026-10-12', lines: ['现金差额：1', '最小申购、赎回单位的现金差额：2', '最小申购、赎回单位资产净值：3', '最小申购、赎回单位净值：4'] }]);
  assert.equal(preferred.prevDayCashDifference, 1);
  assert.equal(preferred.prevDayUnitNav, 3);
});

test('P 日缓存与历史形态校验兼容旧对象，拒绝非法日期和非有限数值', () => {
  const checks = [
    (data) => validateEtfPcfCachedData(data, { code: data.code, date: data.date, now: NOW }),
    (data) => validateEtfPcfHistoryData(data, { code: data.code, date: data.date, now: new Date('2026-10-14T02:00:00Z') })
  ];
  for (const check of checks) {
    assert.equal(check(makeCachedData()).ok, true);
    assert.equal(check(makeCachedData({ prevDayDate: null, prevDayNav: null })).ok, true);
    assert.equal(check(makeCachedData({ prevDayDate: '2026-10-09', prevDayNav: 1.5499, prevDayCashDifference: -12 })).ok, true);
    for (const value of ['2026-02-30', '20261009', 123]) assert.equal(check(makeCachedData({ prevDayDate: value })).ok, false);
    for (const key of ['prevDayCashDifference', 'prevDayUnitNav', 'prevDayNav']) {
      for (const value of ['1', Infinity, NaN, {}]) assert.equal(check(makeCachedData({ [key]: value })).ok, false);
    }
  }
});
