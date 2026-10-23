// 深交所 ETF PCF 申赎限额：单一权威源抓取、GBK 解码、当日字段解析、KV 缓存与单标的刷新。
//
// 数据仅来自深交所 PCF 文本 https://reportdocs.static.szse.cn/files/text/etf/ETF<code><yyyymmdd>.txt，
// 额度单位是基金份额（不是场外基金的人民币申购限额）。仅解析基本信息与请求日期对应的整段信息，
// 不解析组合证券明细。与场外 fund-limit 业务互不影响，仅复用 fundLimit.js 导出的 mapLimit。
//
// KV：复用 FUND_LIMIT_KV，结果 key 为 etf-pcf:<code>:<yyyymmdd>；当日写入固定 TTL 24h，
//     历史日期（早于上海当天）的 POST 修正写入不带过期选项，永久归档；
//     universe 名单 key（etf-pcf-universe:v1）由 etfPcfUniverse.js 维护。
import { mapLimit } from './util.js';

const ETF_PCF_SCHEMA_VERSION = 1;
const ETF_PCF_SOURCE = 'szse_pcf';
const ETF_PCF_SOURCE_URL_BASE = 'https://reportdocs.static.szse.cn/files/text/etf/';
const ETF_PCF_TTL_SECONDS = 400 * 86400;
const ETF_PCF_TTL_MS = ETF_PCF_TTL_SECONDS * 1000;
const ETF_PCF_FETCH_TIMEOUT_MS = 5000;
const ETF_PCF_MAX_BYTES = 1024 * 1024; // 1 MiB
const ETF_PCF_MIN_DATE_KEY = '2000-01-01';
const ETF_PCF_MEMORY_MAX_ENTRIES = 500;

// 请求内 memory 缓存与同 key inflight 刷新去重（isolate 内有效，跨 isolate 无全局锁保证）。
const etfPcfMemory = new Map();
const etfPcfInflight = new Map();

// 解析异常：携带 reason 供上层分类为 parse_failed，拒绝写缓存。
export class EtfPcfFormatError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'EtfPcfFormatError';
    this.reason = reason;
  }
}

// ─── 参数规范化与防御 ─────────────────────────────────────────────

export function isValidEtfPcfCode(code) {
  return typeof code === 'string' && /^159\d{3}$/.test(code);
}

// 仅校验格式与真实公历日期（round-trip），不含范围检查。
export function isWellFormedEtfPcfDateKey(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Asia/Shanghai 固定 UTC+8、无夏令时，直接加 8 小时取 ISO 日期。
export function shanghaiDateKey(now = new Date()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 路由 / 单标的服务 / 批量写入共用的入口校验：code 严格 ^159\d{3}$，
// date 仅接受 YYYY-MM-DD 字符串（undefined 才默认上海当天），范围 2000-01-01 至上海当天（含）。
export function validateEtfPcfRequest({ code, date, now = new Date() }) {
  if (!isValidEtfPcfCode(code)) {
    return { ok: false, status: 400, reason: 'invalid_code', error: 'ETF 代码必须是 159 开头的 6 位数字字符串。' };
  }
  let dateKey;
  if (date === undefined) {
    dateKey = shanghaiDateKey(now);
  } else {
    if (!isWellFormedEtfPcfDateKey(date)) {
      return { ok: false, status: 400, reason: 'invalid_date', error: '日期必须是合法公历日期，格式 YYYY-MM-DD。' };
    }
    dateKey = date;
  }
  const todayKey = shanghaiDateKey(now);
  if (dateKey < ETF_PCF_MIN_DATE_KEY) {
    return { ok: false, status: 400, reason: 'invalid_date', error: '日期不能早于 2000-01-01。' };
  }
  if (dateKey > todayKey) {
    return { ok: false, status: 400, reason: 'invalid_date', error: '日期不能晚于上海当天。' };
  }
  return {
    ok: true,
    code,
    date: dateKey,
    dateKey,
    yyyymmdd: dateKey.split('-').join('')
  };
}

// 唯一的抓取 URL 构造器（进入前再次校验格式，不接受原始输入拼接）。
export function buildEtfPcfSourceUrl(code, dateKey) {
  if (!isValidEtfPcfCode(code) || !isWellFormedEtfPcfDateKey(dateKey)) {
    throw new Error('buildEtfPcfSourceUrl: 非法的 code/date。');
  }
  return ETF_PCF_SOURCE_URL_BASE + 'ETF' + code + dateKey.split('-').join('') + '.txt';
}

// 唯一的结果 key 构造器：etf-pcf:<code>:<yyyymmdd>。
export function buildEtfPcfCacheKey(code, dateKey) {
  if (!isValidEtfPcfCode(code) || !isWellFormedEtfPcfDateKey(dateKey)) {
    throw new Error('buildEtfPcfCacheKey: 非法的 code/date。');
  }
  return 'etf-pcf:' + code + ':' + dateKey.split('-').join('');
}

function isoTime(now) {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString();
}

// ─── GBK 解码 ──────────────────────────────────────────────────────

export function decodeEtfPcf(bytes) {
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (!(u8 instanceof Uint8Array)) {
    throw new TypeError('decodeEtfPcf: 输入必须是 ArrayBuffer/Uint8Array。');
  }
  // fatal: true —— 遇到非法字节直接抛错，拒绝把乱码当正文解析。
  return new TextDecoder('gbk', { fatal: true }).decode(u8);
}

// ─── 文本解析 ──────────────────────────────────────────────────────

const PCF_TITLE_DATE_PATTERN = /^\(\s*(\d{4}-\d{2}-\d{2})\s*\)$/;
const PCF_SEGMENT_HEADER_PATTERN = /^(\d{4}-\d{2}-\d{2})日\s*信息内容$/;
const PCF_DASH_LINE_PATTERN = /^-{3,}$/;
const PCF_UNKNOWN_VALUE_PATTERN = /^[-—–―\s]*$/;

const PCF_BASIC_LABELS = {
  fundName: '基金名称',
  fundCode: '基金代码',
  fundType: '基金类型',
  fundManager: '基金管理公司名称',
  fundManagerAlt: '基金管理人',
  targetIndexCode: '目标指数代码'
};

const PCF_DAY_LABELS = {
  netSubscribe: '当天净申购的基金份额上限',
  netRedeem: '当天净赎回的基金份额上限',
  accountNetSubscribe: '单个证券账户当天净申购的基金份额上限',
  accountNetRedeem: '单个证券账户当天净赎回的基金份额上限',
  totalSubscribe: '当天累计可申购的基金份额上限',
  totalRedeem: '当天累计可赎回的基金份额上限',
  accountTotalSubscribe: '单个证券账户当天累计可申购的基金份额上限',
  accountTotalRedeem: '单个证券账户当天累计可赎回的基金份额上限',
  creationUnit: '最小申购、赎回单位',
  subscribeAllowed: '是否开放申购',
  redeemAllowed: '是否开放赎回',
  estimatedCash: '预估现金差额',
  cashSubPct: '可以现金替代比例上限',
  iopv: '是否需要公布IOPV',
  unitCashDividend: '最小申购赎回单位现金红利',
  localBasketCount: '本市场申购赎回组合证券只数',
  totalBasketCount: '全部申购赎回组合证券只数'
};

// 全部 8 个份额上限字段与其 LimitKind 配对（净申赎 + 单账户 + 累计 + 单账户累计）。
const PCF_SHARE_LIMIT_FIELDS = [
  ['netSubscribeLimitShares', 'netSubscribeLimitKind', 'netSubscribe'],
  ['netRedeemLimitShares', 'netRedeemLimitKind', 'netRedeem'],
  ['accountNetSubscribeLimitShares', 'accountNetSubscribeLimitKind', 'accountNetSubscribe'],
  ['accountNetRedeemLimitShares', 'accountNetRedeemLimitKind', 'accountNetRedeem'],
  ['totalSubscribeLimitShares', 'totalSubscribeLimitKind', 'totalSubscribe'],
  ['totalRedeemLimitShares', 'totalRedeemLimitKind', 'totalRedeem'],
  ['accountTotalSubscribeLimitShares', 'accountTotalSubscribeLimitKind', 'accountTotalSubscribe'],
  ['accountTotalRedeemLimitShares', 'accountTotalRedeemLimitKind', 'accountTotalRedeem']
];

function splitPcfLabelValue(line) {
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '：' || ch === ':') {
      const label = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (!label) return null;
      return { label, value };
    }
  }
  return null;
}

// 份额上限值：0 保留；「不设上限/不限」→ null + unlimited；空值/横线 → null + unknown；
// 千位分隔符与「份」单位可接受；小数或超安全整数视为损坏。
function parseShareLimitValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s || PCF_UNKNOWN_VALUE_PATTERN.test(s)) return { shares: null, kind: 'unknown' };
  if (/不设上限|无上限|不限/.test(s)) return { shares: null, kind: 'unlimited' };
  const t = s.replace(/,/g, '').replace(/份$/, '').trim();
  if (/^\d+$/.test(t)) {
    const num = Number(t);
    if (Number.isSafeInteger(num) && num >= 0) return { shares: num, kind: 'limited' };
  }
  return { invalid: true };
}

function parseMoneyValue(rawValue, { allowNegative, preservePrecision = false }) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s || PCF_UNKNOWN_VALUE_PATTERN.test(s)) return { value: null };
  const t = s.replace(/,/g, '').replace(/元$/, '').trim();
  const pattern = allowNegative ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/;
  if (pattern.test(t)) {
    const num = Number(t);
    if (Number.isFinite(num)) return { value: preservePrecision ? num : Math.round(num * 100) / 100 };
  }
  return { invalid: true };
}

function parsePctValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s || PCF_UNKNOWN_VALUE_PATTERN.test(s)) return { value: null };
  const t = s.replace(/,/g, '').replace(/%$/, '').trim();
  if (/^\d+(\.\d+)?$/.test(t)) {
    const num = Number(t);
    if (Number.isFinite(num) && num >= 0 && num <= 100) return { value: num };
  }
  return { invalid: true };
}

function parseCreationUnitValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s || PCF_UNKNOWN_VALUE_PATTERN.test(s)) return { value: null };
  const t = s.replace(/,/g, '').replace(/份$/, '').trim();
  if (/^\d+$/.test(t)) {
    const num = Number(t);
    if (Number.isSafeInteger(num) && num > 0) return { value: num };
  }
  return { invalid: true };
}

// 允许/是/开放/正常 → true；不允许/否/暂停/停止/关闭 → false；明确空值或未知文本 → null。
function parseAllowedValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (s === '允许' || s === '是' || s === '开放' || s === '正常') return { value: true };
  if (s === '不允许' || s === '否' || s === '暂停' || s === '停止' || s === '关闭') return { value: false };
  if (!s || PCF_UNKNOWN_VALUE_PATTERN.test(s)) return { value: null };
  return { invalid: true };
}

function parseIopvValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (s === '是') return { value: true };
  if (s === '否') return { value: false };
  if (!s || PCF_UNKNOWN_VALUE_PATTERN.test(s)) return { value: null };
  return { invalid: true };
}

function parseBasketCountValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s || PCF_UNKNOWN_VALUE_PATTERN.test(s)) return { value: null };
  const m = /^(\d+)/.exec(s.replace(/,/g, ''));
  if (m) {
    const num = Number(m[1]);
    if (Number.isSafeInteger(num) && num >= 0) return { value: num };
  }
  return { invalid: true };
}

// 纯解析：无网络、无 KV。校验代码与日期，识别「基本信息」与请求 date 对应的
// 「YYYY-MM-DD日 信息内容」段落（到下一个日期标题或「组合信息内容」结束），
// 不做全文件模糊匹配，不解析组合证券明细。
export function parseEtfPcf(text, { code, date } = {}) {
  if (!isValidEtfPcfCode(code)) {
    throw new EtfPcfFormatError('ETF 代码必须是 159 开头的 6 位数字字符串。', 'invalid_code');
  }
  if (!isWellFormedEtfPcfDateKey(date)) {
    throw new EtfPcfFormatError('日期必须是合法公历日期，格式 YYYY-MM-DD。', 'invalid_date');
  }
  const dateKey = date;
  if (typeof text !== 'string' || !text.trim()) {
    throw new EtfPcfFormatError('PCF 文本为空。', 'empty_text');
  }

  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  let titleDate = null;
  let basicSection = null;
  let current = null;
  const segments = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || PCF_DASH_LINE_PATTERN.test(line)) continue;
    const titleMatch = PCF_TITLE_DATE_PATTERN.exec(line);
    if (titleMatch) {
      if (!isWellFormedEtfPcfDateKey(titleMatch[1])) {
        throw new EtfPcfFormatError('文件标题日期非法：' + titleMatch[1], 'title_date_invalid');
      }
      titleDate = titleMatch[1];
      continue;
    }
    if (line === '基本信息') {
      basicSection = { fields: new Map() };
      current = basicSection;
      continue;
    }
    if (line === '组合信息内容') {
      current = { type: 'basket' };
      continue;
    }
    const segmentMatch = PCF_SEGMENT_HEADER_PATTERN.exec(line);
    if (segmentMatch) {
      const segmentDate = segmentMatch[1];
      if (!isWellFormedEtfPcfDateKey(segmentDate)) {
        throw new EtfPcfFormatError('段落日期非法：' + segmentDate, 'segment_date_invalid');
      }
      if (segments.has(segmentDate)) {
        throw new EtfPcfFormatError('重复的日期段落：' + segmentDate, 'duplicate_day_section');
      }
      const section = { fields: new Map() };
      segments.set(segmentDate, section);
      current = section;
      continue;
    }
    if (!current || current.type === 'basket') continue;
    const pair = splitPcfLabelValue(line);
    if (!pair) continue; // 标题等无冒号行
    const prev = current.fields.get(pair.label);
    if (prev !== undefined) {
      // 同名同值容忍，同值不同文冲突拒绝写缓存。
      if (prev !== pair.value) {
        throw new EtfPcfFormatError('同名字段值冲突：' + pair.label, 'duplicate_field_conflict');
      }
      continue;
    }
    current.fields.set(pair.label, pair.value);
  }

  if (!titleDate) {
    throw new EtfPcfFormatError('缺少文件标题日期。', 'missing_title_date');
  }
  if (titleDate !== dateKey) {
    throw new EtfPcfFormatError('文件标题日期与请求日期不一致。', 'title_date_mismatch');
  }
  if (!basicSection) {
    throw new EtfPcfFormatError('缺少「基本信息」段落。', 'missing_basic_info');
  }
  const fundName = basicSection.fields.get(PCF_BASIC_LABELS.fundName);
  if (!fundName) {
    throw new EtfPcfFormatError('缺少基金名称。', 'missing_fund_name');
  }
  const fileCode = basicSection.fields.get(PCF_BASIC_LABELS.fundCode);
  if (fileCode !== code) {
    throw new EtfPcfFormatError('正文基金代码与请求代码不一致。', 'code_mismatch');
  }
  const fundType = basicSection.fields.get(PCF_BASIC_LABELS.fundType);
  if (!fundType) {
    throw new EtfPcfFormatError('缺少基金类型。', 'missing_fund_type');
  }
  const segment = segments.get(dateKey);
  if (!segment) {
    throw new EtfPcfFormatError('缺少请求日期的信息段落：' + dateKey, 'missing_day_section');
  }

  const warnings = [];
  const rawFields = {};
  for (const [k, v] of segment.fields) rawFields[k] = v;
  const basicRawFields = {};
  for (const [k, v] of basicSection.fields) basicRawFields[k] = v;

  function requireCoreShare(label) {
    const raw = segment.fields.get(label);
    if (raw === undefined) {
      throw new EtfPcfFormatError('缺少核心字段：' + label, 'missing_core_field');
    }
    const parsed = parseShareLimitValue(raw);
    if (parsed.invalid) {
      throw new EtfPcfFormatError('核心字段数值损坏：' + label, 'corrupt_core_field');
    }
    return parsed;
  }

  function optionalShare(label) {
    const raw = segment.fields.get(label);
    if (raw === undefined) {
      warnings.push('缺少可选字段：' + label);
      return { shares: null, kind: 'unknown' };
    }
    const parsed = parseShareLimitValue(raw);
    if (parsed.invalid) {
      warnings.push('字段值无法识别：' + label);
      return { shares: null, kind: 'unknown' };
    }
    return parsed;
  }

  function optionalValue(label, parseFn) {
    const raw = segment.fields.get(label);
    if (raw === undefined) {
      warnings.push('缺少可选字段：' + label);
      return null;
    }
    const parsed = parseFn(raw);
    if (parsed.invalid) {
      warnings.push('字段值无法识别：' + label);
      return null;
    }
    return parsed.value;
  }

  const result = {
    schemaVersion: ETF_PCF_SCHEMA_VERSION,
    source: ETF_PCF_SOURCE,
    code,
    date: dateKey,
    fundName,
    fundType,
    fundManager:
      basicSection.fields.get(PCF_BASIC_LABELS.fundManager) ||
      basicSection.fields.get(PCF_BASIC_LABELS.fundManagerAlt) ||
      null,
    targetIndexCode: basicSection.fields.get(PCF_BASIC_LABELS.targetIndexCode) || null
  };

  // 8 个份额上限字段：净申赎为核心（label 缺失或数字损坏即格式错误），其余可选。
  for (const [sharesKey, kindKey, labelKey] of PCF_SHARE_LIMIT_FIELDS) {
    const label = PCF_DAY_LABELS[labelKey];
    const parsed = labelKey === 'netSubscribe' || labelKey === 'netRedeem'
      ? requireCoreShare(label)
      : optionalShare(label);
    result[sharesKey] = parsed.shares;
    result[kindKey] = parsed.kind;
  }

  result.creationRedemptionUnitShares = optionalValue(
    PCF_DAY_LABELS.creationUnit,
    parseCreationUnitValue
  );
  result.subscriptionAllowed = optionalValue(PCF_DAY_LABELS.subscribeAllowed, parseAllowedValue);
  result.redemptionAllowed = optionalValue(PCF_DAY_LABELS.redeemAllowed, parseAllowedValue);
  result.estimatedCashDifference = optionalValue(PCF_DAY_LABELS.estimatedCash, (raw) =>
    parseMoneyValue(raw, { allowNegative: true })
  );
  result.cashSubstitutionRatioLimitPct = optionalValue(PCF_DAY_LABELS.cashSubPct, parsePctValue);
  result.iopvRequired = optionalValue(PCF_DAY_LABELS.iopv, parseIopvValue);
  result.unitCashDividend = optionalValue(PCF_DAY_LABELS.unitCashDividend, (raw) =>
    parseMoneyValue(raw, { allowNegative: false })
  );
  result.localBasketSecurityCount = optionalValue(PCF_DAY_LABELS.localBasketCount, parseBasketCountValue);
  result.totalBasketSecurityCount = optionalValue(PCF_DAY_LABELS.totalBasketCount, parseBasketCountValue);
  // P 日只取严格早于请求日期的最近段落，缺失或损坏静默留空。
  const prevDayDate = [...segments.keys()].filter((key) => key < dateKey).sort().at(-1) || null;
  const prevFields = segments.get(prevDayDate)?.fields;
  const previousMoney = (labels, options) => {
    const label = labels.find((key) => prevFields?.has(key));
    return label ? parseMoneyValue(prevFields.get(label), options).value ?? null : null;
  };
  result.prevDayDate = prevDayDate;
  result.prevDayCashDifference = previousMoney(
    ['现金差额', '最小申购、赎回单位的现金差额'], { allowNegative: true }
  );
  result.prevDayUnitNav = previousMoney(
    ['最小申购、赎回单位资产净值', '最小申购、赎回单位净值'], { allowNegative: false }
  );
  result.prevDayNav = previousMoney(['基金份额净值'], { allowNegative: false, preservePrecision: true });
  result.rawFields = rawFields;
  result.basicRawFields = basicRawFields;
  result.warnings = warnings;
  return result;
}

// ─── 持久化数据校验（读缓存与写缓存共用） ──────────────────────────

const ETF_PCF_LIMIT_KINDS = new Set(['limited', 'unlimited', 'unknown']);

function isStringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const k of Object.keys(value)) {
    if (typeof value[k] !== 'string') return false;
  }
  return true;
}

function isSafeNonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

// 身份、source、schemaVersion、数据形态、fetchedAt/expiresAt（含未来时间异常）全部校验，
// 任一失败视为 miss，不进入 memory。
export function validateEtfPcfCachedData(data, { code, date, now = new Date() }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'shape' };
  }
  if (data.schemaVersion !== ETF_PCF_SCHEMA_VERSION) return { ok: false, reason: 'schema_version' };
  if (data.source !== ETF_PCF_SOURCE) return { ok: false, reason: 'source' };
  if (data.code !== code || data.date !== date) return { ok: false, reason: 'identity' };
  if (typeof data.fundName !== 'string' || !data.fundName) return { ok: false, reason: 'fund_name' };
  if (typeof data.fundType !== 'string' || !data.fundType) return { ok: false, reason: 'fund_type' };
  if (data.fundManager != null && typeof data.fundManager !== 'string') return { ok: false, reason: 'fund_manager' };
  if (data.targetIndexCode != null && typeof data.targetIndexCode !== 'string') {
    return { ok: false, reason: 'target_index_code' };
  }
  for (const [sharesKey, kindKey] of PCF_SHARE_LIMIT_FIELDS) {
    if (!ETF_PCF_LIMIT_KINDS.has(data[kindKey])) return { ok: false, reason: kindKey };
    if (data[sharesKey] != null && !isSafeNonNegInt(data[sharesKey])) {
      return { ok: false, reason: sharesKey };
    }
    if (data[kindKey] === 'limited' && data[sharesKey] == null) {
      return { ok: false, reason: sharesKey };
    }
  }
  if (data.creationRedemptionUnitShares != null &&
    !(Number.isSafeInteger(data.creationRedemptionUnitShares) && data.creationRedemptionUnitShares > 0)) {
    return { ok: false, reason: 'creation_unit' };
  }
  for (const key of ['subscriptionAllowed', 'redemptionAllowed', 'iopvRequired']) {
    if (data[key] != null && typeof data[key] !== 'boolean') return { ok: false, reason: key };
  }
  if (data.prevDayDate != null && !isWellFormedEtfPcfDateKey(data.prevDayDate)) {
    return { ok: false, reason: 'prev_day_date' };
  }
  for (const key of ['estimatedCashDifference', 'unitCashDividend', 'prevDayCashDifference', 'prevDayUnitNav', 'prevDayNav']) {
    if (data[key] != null && !(typeof data[key] === 'number' && Number.isFinite(data[key]))) {
      return { ok: false, reason: key };
    }
  }
  if (data.cashSubstitutionRatioLimitPct != null &&
    !(typeof data.cashSubstitutionRatioLimitPct === 'number' &&
      Number.isFinite(data.cashSubstitutionRatioLimitPct) &&
      data.cashSubstitutionRatioLimitPct >= 0 &&
      data.cashSubstitutionRatioLimitPct <= 100)) {
    return { ok: false, reason: 'cash_substitution_ratio' };
  }
  for (const key of ['localBasketSecurityCount', 'totalBasketSecurityCount']) {
    if (data[key] != null && !isSafeNonNegInt(data[key])) return { ok: false, reason: key };
  }
  if (!isStringRecord(data.rawFields)) return { ok: false, reason: 'raw_fields' };
  if (!isStringRecord(data.basicRawFields)) return { ok: false, reason: 'basic_raw_fields' };
  if (!Array.isArray(data.warnings) || data.warnings.some((w) => typeof w !== 'string')) {
    return { ok: false, reason: 'warnings' };
  }
  if (typeof data.fetchedAt !== 'string' || typeof data.expiresAt !== 'string') {
    return { ok: false, reason: 'timestamps' };
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const fetchedAtMs = Date.parse(data.fetchedAt);
  const expiresAtMs = Date.parse(data.expiresAt);
  if (!Number.isFinite(fetchedAtMs) || !Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: 'timestamps' };
  }
  if (fetchedAtMs > nowMs) return { ok: false, reason: 'future_fetched_at' };
  if (expiresAtMs <= nowMs) return { ok: false, reason: 'expired' };
  if (expiresAtMs <= fetchedAtMs) return { ok: false, reason: 'expiry_range' };
  if (expiresAtMs - fetchedAtMs > ETF_PCF_TTL_MS + 60000) return { ok: false, reason: 'ttl_anomaly' };
  return { ok: true };
}

// ─── 历史日期读取校验 ──────────────────────────────────────────────

// 历史分类唯一规则：规范化后的 dateKey 严格早于注入 now 的上海当天。合法 YYYY-MM-DD
// 可直接按字符串比较；必须在 validateEtfPcfRequest 通过后调用，禁止用原始 query 比较。
function isEtfPcfHistoryDate(dateKey, now) {
  return dateKey < shanghaiDateKey(now);
}

function isPcfIsoTimestamp(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

// 历史日期（早于上海当天）的缓存 value 校验：身份、source、schemaVersion 与业务 shape
// 损坏必拒绝，但不检查有效期——历史数据没有业务过期概念，兼容曾以短 TTL 写入但仍存在的
// 旧日期对象（expiresAt 已过期也可读）。backfill 精简对象缺 rawFields/fetchedAt/expiresAt/
// sourceUrl 时仍可读取；可选字段存在才校验形态。unlimited/unknown 的 shares 必须为 null，
// 拒绝非空数值的矛盾配对（parser 正常输出即为 null）。自身防御非法 code/date 与非历史日期，
// 不能单独拿它校验当天对象。
export function validateEtfPcfHistoryData(data, { code, date, now = new Date() }) {
  if (!isValidEtfPcfCode(code)) return { ok: false, reason: 'invalid_code' };
  if (!isWellFormedEtfPcfDateKey(date) || date < ETF_PCF_MIN_DATE_KEY) return { ok: false, reason: 'invalid_date' };
  if (!isEtfPcfHistoryDate(date, now)) return { ok: false, reason: 'not_historical_date' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'shape' };
  }
  if (data.schemaVersion !== ETF_PCF_SCHEMA_VERSION) return { ok: false, reason: 'schema_version' };
  if (data.source !== ETF_PCF_SOURCE) return { ok: false, reason: 'source' };
  if (data.code !== code || data.date !== date) return { ok: false, reason: 'identity' };
  if (typeof data.fundName !== 'string' || !data.fundName) return { ok: false, reason: 'fund_name' };
  if (typeof data.fundType !== 'string' || !data.fundType) return { ok: false, reason: 'fund_type' };
  if (data.fundManager != null && typeof data.fundManager !== 'string') return { ok: false, reason: 'fund_manager' };
  if (data.targetIndexCode != null && typeof data.targetIndexCode !== 'string') {
    return { ok: false, reason: 'target_index_code' };
  }
  for (const [sharesKey, kindKey] of PCF_SHARE_LIMIT_FIELDS) {
    if (!ETF_PCF_LIMIT_KINDS.has(data[kindKey])) return { ok: false, reason: kindKey };
    if (data[kindKey] === 'limited') {
      if (!isSafeNonNegInt(data[sharesKey])) return { ok: false, reason: sharesKey };
    } else if (data[sharesKey] !== null) {
      return { ok: false, reason: sharesKey };
    }
  }
  if (data.creationRedemptionUnitShares != null &&
    !(Number.isSafeInteger(data.creationRedemptionUnitShares) && data.creationRedemptionUnitShares > 0)) {
    return { ok: false, reason: 'creation_unit' };
  }
  for (const key of ['subscriptionAllowed', 'redemptionAllowed', 'iopvRequired']) {
    if (data[key] != null && typeof data[key] !== 'boolean') return { ok: false, reason: key };
  }
  if (data.prevDayDate != null && !isWellFormedEtfPcfDateKey(data.prevDayDate)) {
    return { ok: false, reason: 'prev_day_date' };
  }
  for (const key of ['estimatedCashDifference', 'unitCashDividend', 'prevDayCashDifference', 'prevDayUnitNav', 'prevDayNav']) {
    if (data[key] != null && !(typeof data[key] === 'number' && Number.isFinite(data[key]))) {
      return { ok: false, reason: key };
    }
  }
  if (data.cashSubstitutionRatioLimitPct != null &&
    !(typeof data.cashSubstitutionRatioLimitPct === 'number' &&
      Number.isFinite(data.cashSubstitutionRatioLimitPct) &&
      data.cashSubstitutionRatioLimitPct >= 0 &&
      data.cashSubstitutionRatioLimitPct <= 100)) {
    return { ok: false, reason: 'cash_substitution_ratio' };
  }
  for (const key of ['localBasketSecurityCount', 'totalBasketSecurityCount']) {
    if (data[key] != null && !isSafeNonNegInt(data[key])) return { ok: false, reason: key };
  }
  if (!isStringRecord(data.basicRawFields)) return { ok: false, reason: 'basic_raw_fields' };
  if (!Array.isArray(data.warnings) || data.warnings.some((w) => typeof w !== 'string')) {
    return { ok: false, reason: 'warnings' };
  }
  // rawFields 回填时已删除：允许缺失，存在则必须是 string record。
  if (data.rawFields !== undefined && !isStringRecord(data.rawFields)) {
    return { ok: false, reason: 'raw_fields' };
  }
  // fetchedAt/expiresAt/sourceUrl 全部可选：存在才校验形态，不做过期判断。
  if (data.fetchedAt !== undefined) {
    if (!isPcfIsoTimestamp(data.fetchedAt)) return { ok: false, reason: 'fetched_at' };
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const fetchedAtMs = Date.parse(data.fetchedAt);
    if (!Number.isFinite(fetchedAtMs)) return { ok: false, reason: 'fetched_at' };
    if (fetchedAtMs > nowMs) return { ok: false, reason: 'future_fetched_at' };
  }
  if (data.expiresAt !== undefined) {
    if (!isPcfIsoTimestamp(data.expiresAt)) {
      return { ok: false, reason: 'expires_at' };
    }
  }
  if (data.sourceUrl !== undefined && data.sourceUrl !== buildEtfPcfSourceUrl(code, date)) {
    return { ok: false, reason: 'source_url' };
  }
  return { ok: true };
}

// ─── 抓取（单次外部请求，5 秒全程超时、拒绝跳转、1 MiB 流式上限） ──

async function cancelResponseBody(resp) {
  try {
    const body = resp && resp.body;
    if (body && typeof body.cancel === 'function') await body.cancel();
  } catch (_e) {
    // 取消失败不影响分类结果
  }
}

async function readBodyWithLimit(resp, ctrl) {
  const body = resp.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = await resp.arrayBuffer();
    const u8 = new Uint8Array(buf);
    if (u8.byteLength > ETF_PCF_MAX_BYTES) {
      const err = new Error('PCF 文件超过 1 MiB 上限。');
      err.__etfPcfSizeExceeded = true;
      throw err;
    }
    return u8;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > ETF_PCF_MAX_BYTES) {
        try {
          ctrl.abort();
        } catch (_e) {
          // ignore
        }
        const err = new Error('PCF 文件超过 1 MiB 上限。');
        err.__etfPcfSizeExceeded = true;
        throw err;
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch (_e) {
      // ignore
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function transportErrorResult(error, { timedOut, externallyAborted, sourceUrl }) {
  if (timedOut) {
    return { ok: false, reason: 'timeout', status: 504, error: '下载 PCF 文件超时。', sourceUrl };
  }
  if (externallyAborted) {
    return { ok: false, reason: 'aborted', status: 504, error: '下载 PCF 文件被中止。', sourceUrl };
  }
  return { ok: false, reason: 'fetch_failed', status: 502, error: '抓取 PCF 文件失败。', sourceUrl };
}

export async function fetchEtfPcfText({
  code,
  date,
  fetchImpl,
  signal,
  timeoutMs = ETF_PCF_FETCH_TIMEOUT_MS
}) {
  if (!isValidEtfPcfCode(code) || !isWellFormedEtfPcfDateKey(date)) {
    return { ok: false, reason: 'invalid_params', status: 400, error: '非法的 ETF 代码或日期。' };
  }
  const sourceUrl = buildEtfPcfSourceUrl(code, date);
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'fetch_unavailable', status: 502, error: '运行时无可用 fetch。', sourceUrl };
  }
  const ctrl = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    externallyAborted = true;
    ctrl.abort();
  };
  let linked = false;
  if (signal) {
    if (signal.aborted) {
      externallyAborted = true;
      ctrl.abort();
    } else if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onExternalAbort);
      linked = true;
    }
  }
  try {
    let resp;
    try {
      // 注意：Workers 运行时不支持 redirect:'error'（调用即抛 TypeError），
      // 因此用 'manual' 并在下面显式拒绝 3xx（http_error），跳转永不跟随。
      resp = await fetchFn(sourceUrl, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    } catch (e) {
      return transportErrorResult(e, { timedOut, externallyAborted, sourceUrl });
    }
    if (!resp || typeof resp.status !== 'number') {
      return { ok: false, reason: 'fetch_failed', status: 502, error: '上游未返回有效响应。', sourceUrl };
    }
    if (resp.status === 404) {
      await cancelResponseBody(resp);
      return { ok: false, reason: 'upstream_not_found', status: 404, error: '深交所当日 PCF 文件不存在。', sourceUrl };
    }
    if (resp.status !== 200) {
      await cancelResponseBody(resp);
      return {
        ok: false,
        reason: 'http_error',
        status: 502,
        error: '深交所返回 HTTP ' + resp.status + '。',
        httpStatus: resp.status,
        sourceUrl
      };
    }
    const lenHeader = resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('content-length') : null;
    if (lenHeader && Number(lenHeader) > ETF_PCF_MAX_BYTES) {
      try {
        ctrl.abort();
      } catch (_e) {
        // ignore
      }
      await cancelResponseBody(resp);
      return { ok: false, reason: 'fetch_failed', status: 502, error: 'PCF 文件超过 1 MiB 上限。', sourceUrl };
    }
    let bytes;
    try {
      bytes = await readBodyWithLimit(resp, ctrl);
    } catch (e) {
      if (e && e.__etfPcfSizeExceeded) {
        return { ok: false, reason: 'fetch_failed', status: 502, error: 'PCF 文件超过 1 MiB 上限。', sourceUrl };
      }
      return transportErrorResult(e, { timedOut, externallyAborted, sourceUrl });
    }
    if (timedOut) {
      return { ok: false, reason: 'timeout', status: 504, error: '下载 PCF 文件超时。', sourceUrl };
    }
    return { ok: true, bytes, sourceUrl };
  } finally {
    clearTimeout(timer);
    if (linked && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ─── memory / inflight ─────────────────────────────────────────────

function setEtfPcfMemory(key, data) {
  if (etfPcfMemory.size >= ETF_PCF_MEMORY_MAX_ENTRIES) {
    const oldest = etfPcfMemory.keys().next().value;
    if (oldest !== undefined) etfPcfMemory.delete(oldest);
  }
  etfPcfMemory.set(key, { data });
}

// 测试专用：清空模块内 memory 与 inflight 状态。
export function clearEtfPcfRuntimeStateForTests() {
  etfPcfMemory.clear();
  etfPcfInflight.clear();
}

// ─── 读缓存（仅 memory/inflight/KV，绝不访问外部源） ────────────────

export async function readEtfPcfLimitCache({ code, date, env, now = new Date() }) {
  const v = validateEtfPcfRequest({ code, date, now });
  if (!v.ok) {
    return { ok: false, status: 400, reason: v.reason, error: v.error, code: code ?? null, date: date ?? null };
  }
  if (!env || !env.FUND_LIMIT_KV) {
    return { ok: false, status: 503, reason: 'kv_unavailable', error: 'ETF PCF 缓存 KV 未配置。', code: v.code, date: v.date };
  }
  const key = buildEtfPcfCacheKey(v.code, v.date);
  // 显式日期分支：早于上海当天用历史校验（无有效期概念），当日（含无 date）仍走严格校验，
  // 不做「严格失败再回退历史」；一次调用使用同一个注入 now。
  const historical = isEtfPcfHistoryDate(v.date, now);
  const validateData = historical ? validateEtfPcfHistoryData : validateEtfPcfCachedData;
  const scopeError = historical ? '指定日期' : '当日';

  const mem = etfPcfMemory.get(key);
  if (mem) {
    const check = validateData(mem.data, { code: v.code, date: v.date, now });
    if (check.ok) {
      return { ok: true, status: 200, data: { ...mem.data, cached: true } };
    }
    etfPcfMemory.delete(key);
  }

  const inflight = etfPcfInflight.get(key);
  if (inflight) {
    try {
      const settled = await inflight;
      if (settled && settled.ok) {
        // 等待中的刷新结果同样按本次调用的分支校验身份与形态，
        // 不保留绕过校验的快捷成功路径；失败或不合规则继续读 KV。
        const check = validateData(settled.data, { code: v.code, date: v.date, now });
        if (check.ok) {
          return { ok: true, status: 200, data: { ...settled.data, cached: true } };
        }
      }
    } catch (_e) {
      // 刷新失败 → 继续读 KV（可能仍有同日有效旧值）
    }
  }

  let raw;
  try {
    raw = await env.FUND_LIMIT_KV.get(key);
  } catch (_e) {
    return { ok: false, status: 503, reason: 'kv_read_failed', error: 'ETF PCF 缓存读取失败。', code: v.code, date: v.date };
  }
  if (raw == null) {
    return { ok: false, status: 404, reason: 'cache_miss', error: scopeError + ' PCF 限额缓存未命中。', code: v.code, date: v.date };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_e) {
    return { ok: false, status: 404, reason: 'cache_miss', error: scopeError + ' PCF 限额缓存损坏。', code: v.code, date: v.date };
  }
  const check = validateData(data, { code: v.code, date: v.date, now });
  if (!check.ok) {
    return { ok: false, status: 404, reason: 'cache_miss', error: scopeError + ' PCF 限额缓存无效。', code: v.code, date: v.date };
  }
  setEtfPcfMemory(key, data);
  return { ok: true, status: 200, data: { ...data, cached: true } };
}

// ─── 单标的服务（默认缓存优先；抓取 → 解码 → 解析 → 校验 → await KV 写入） ──

export async function fetchEtfPcfLimit({
  code,
  date,
  env,
  forceRefresh = false,
  now = new Date(),
  fetchImpl,
  signal,
  timeoutMs
}) {
  const v = validateEtfPcfRequest({ code, date, now });
  if (!v.ok) {
    return { ok: false, status: 400, reason: v.reason, error: v.error, code: code ?? null, date: date ?? null };
  }
  // 缺 KV binding 在访问外部源前直接 503。
  if (!env || !env.FUND_LIMIT_KV) {
    return { ok: false, status: 503, reason: 'kv_unavailable', error: 'ETF PCF 缓存 KV 未配置。', code: v.code, date: v.date };
  }
  if (!forceRefresh) {
    const cached = await readEtfPcfLimitCache({ code: v.code, date: v.date, env, now });
    if (cached.ok || cached.status === 503) return cached;
  }
  // 历史分类与读取使用同一 date/now 规则：历史日期修正写永久归档（无过期），
  // 当日（含无 date）保持 24h TTL 与严格校验。
  const historical = isEtfPcfHistoryDate(v.date, now);
  const key = buildEtfPcfCacheKey(v.code, v.date);
  const existing = etfPcfInflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    // 单 code 外部调用同样经过 mapLimit([code], 1, ...)。
    const [outcome] = await mapLimit([v.code], 1, () =>
      fetchEtfPcfText({ code: v.code, date: v.date, fetchImpl, signal, timeoutMs })
    );
    const fetchResult =
      outcome && outcome.__error
        ? { ok: false, reason: 'fetch_failed', status: 502, error: '抓取 PCF 文件失败：' + outcome.__error }
        : outcome;
    if (!fetchResult || !fetchResult.ok) {
      return {
        ok: false,
        status: fetchResult ? fetchResult.status || 502 : 502,
        reason: (fetchResult && fetchResult.reason) || 'fetch_failed',
        error: (fetchResult && fetchResult.error) || '抓取 PCF 文件失败。',
        // 透传上游 HTTP 状态：批量刷新据 httpStatus 判定 5xx/429 是否瞬态可重试。
        httpStatus: fetchResult && fetchResult.httpStatus,
        code: v.code,
        date: v.date
      };
    }
    let text;
    try {
      text = decodeEtfPcf(fetchResult.bytes);
    } catch (_e) {
      return { ok: false, status: 502, reason: 'decode_failed', error: 'PCF 文件 GBK 解码失败。', code: v.code, date: v.date };
    }
    let parsed;
    try {
      parsed = parseEtfPcf(text, { code: v.code, date: v.date });
    } catch (e) {
      return {
        ok: false,
        status: 502,
        reason: 'parse_failed',
        error: (e && e.message) || 'PCF 解析失败。',
        code: v.code,
        date: v.date
      };
    }
    const fetchedAt = isoTime(now);
    let persisted;
    let check;
    if (historical) {
      // 历史修正：保留真实 fetchedAt、sourceUrl 与 parser 全部输出，省略 expiresAt，
      // 不从旧 backfill merge 缺失业务字段；上游身份异常一律拒绝写入。
      persisted = { ...parsed, sourceUrl: fetchResult.sourceUrl, fetchedAt };
      check = validateEtfPcfHistoryData(persisted, { code: v.code, date: v.date, now });
    } else {
      const expiresAt = new Date(
        (now instanceof Date ? now.getTime() : Number(now)) + ETF_PCF_TTL_MS
      ).toISOString();
      persisted = { ...parsed, sourceUrl: fetchResult.sourceUrl, fetchedAt, expiresAt };
      check = validateEtfPcfCachedData(persisted, { code: v.code, date: v.date, now });
    }
    if (!check.ok) {
      return {
        ok: false,
        status: 502,
        reason: 'parse_failed',
        error: '解析结果校验失败：' + check.reason,
        code: v.code,
        date: v.date
      };
    }
    // 成功抓取解析后必须 await 写入，写失败不冒充已缓存。
    // 历史覆盖写不带任何过期选项（KV 覆盖语义同时移除旧 TTL），当日写固定 24h TTL。
    try {
      if (historical) {
        await env.FUND_LIMIT_KV.put(key, JSON.stringify(persisted));
      } else {
        // PCF 原始数据永久保存（不设 KV TTL）；对象内 expiresAt 只表示「当日缓存」新鲜度，历史读取不看它。
        await env.FUND_LIMIT_KV.put(key, JSON.stringify(persisted));
      }
    } catch (_e) {
      return { ok: false, status: 503, reason: 'kv_write_failed', error: 'ETF PCF 缓存写入失败。', code: v.code, date: v.date };
    }
    setEtfPcfMemory(key, persisted);
    return { ok: true, status: 200, data: { ...persisted, cached: false } };
  })();

  etfPcfInflight.set(key, task);
  try {
    return await task;
  } finally {
    etfPcfInflight.delete(key);
  }
}
