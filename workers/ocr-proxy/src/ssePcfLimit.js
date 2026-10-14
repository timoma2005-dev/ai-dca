// 上交所纳指 ETF PCF 申赎限额：JSONP 抓取与解析、SSE 专用额度口径、字段映射、
// 缓存读写、单标的服务与固定名单刷新。
//
// 数据仅来自上交所「基金申购赎回清单（公司申购赎回清单基本信息）」接口
// https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=<code>&sqlId=…（必须携带
// Referer: https://www.sse.com.cn/，URL 不带 date：接口只提供最新清单），额度单位是基金份额
// （不是场外基金的人民币申购限额）。与场外 fund-limit 业务互不影响，与深交所 etfPcfLimit.js
// 各自独立：不修改 fundLimit.js / etfPcfLimit.js / etfPcfUniverse.js，仅复用导出的 mapLimit。
//
// 覆盖名单是 worker 内冻结的 5 只纳指 ETF（SSE_PCF_CODES），供服务校验、路由分发判断与
// cron 刷新共同使用，三处不各维护一份；不做 universe 探测，不读写 etf-pcf-universe:v1。
//
// KV：复用 FUND_LIMIT_KV，结果 key 为 etf-pcf:<code>:<yyyymmdd>（51xxxx 与 159xxx 不冲突），
// 固定 TTL 24h；入库身份日期一律取接口 TRADING_DAY（清单日期），绝不使用抓取日期。
import { mapLimit } from './fundLimit.js';

// plan 决策 (b)：worker 内硬编码冻结名单，排序固定，三个入口共用这一份。
export const SSE_PCF_CODES = ['513100', '513110', '513300', '513390', '513870'];
const SSE_PCF_CODE_SET = new Set(SSE_PCF_CODES);

const SSE_PCF_SCHEMA_VERSION = 1;
const SSE_PCF_SOURCE = 'sse_pcf';
const SSE_PCF_SOURCE_URL_BASE =
  'https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=';
const SSE_PCF_SOURCE_SQL_ID = 'COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C';
const SSE_PCF_REFERER = 'https://www.sse.com.cn/';
const SSE_PCF_TTL_SECONDS = 24 * 3600;
const SSE_PCF_TTL_MS = SSE_PCF_TTL_SECONDS * 1000;
const SSE_PCF_FETCH_TIMEOUT_MS = 5000;
const SSE_PCF_MAX_BYTES = 1024 * 1024; // 1 MiB
const SSE_PCF_MIN_DATE_KEY = '2000-01-01';
const SSE_PCF_MEMORY_MAX_ENTRIES = 500;
// 瞬态错误（空响应/超时/网络/429/5xx）最多总计 3 次尝试，退避 200ms / 500ms，
// 重试在原 mapLimit lane 内执行；404、非法 JSONP、损坏字段、日期不匹配不重试。
const SSE_PCF_MAX_ATTEMPTS = 3;
const SSE_PCF_RETRY_BACKOFF_MS = [200, 500];
export const SSE_PCF_REFRESH_CONCURRENCY = 2;

// 请求内 memory 缓存与同 key inflight 刷新去重（isolate 内有效，跨 isolate 无全局锁保证）。
const ssePcfMemory = new Map();
const ssePcfInflight = new Map();

// 解析异常：携带 reason 供上层分类为 parse_failed，拒绝写缓存；
// empty_body / empty_result 是瞬态空响应（上层可重试），其余为确定性损坏。
export class SsePcfFormatError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'SsePcfFormatError';
    this.reason = reason;
  }
}

// ─── 参数规范化与防御 ─────────────────────────────────────────────

export function isValidSsePcfCode(code) {
  return typeof code === 'string' && SSE_PCF_CODE_SET.has(code);
}

// 仅校验格式与真实公历日期（round-trip），不含范围检查。
export function isWellFormedSsePcfDateKey(dateKey) {
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

// SSE 入口校验：code 必须在冻结名单内；date 仅接受 YYYY-MM-DD 字符串
//（undefined 才保留缺省语义，不提前替换为具体日期），范围 2000-01-01 至上海当天（含）。
export function validateSsePcfRequest({ code, date, now = new Date() }) {
  if (!isValidSsePcfCode(code)) {
    return {
      ok: false,
      status: 400,
      reason: 'invalid_code',
      error: '上交所 ETF 代码必须在覆盖名单内：' + SSE_PCF_CODES.join('/') + '。'
    };
  }
  const dateDefaulted = date === undefined;
  let dateKey;
  if (dateDefaulted) {
    dateKey = shanghaiDateKey(now);
  } else {
    if (!isWellFormedSsePcfDateKey(date)) {
      return { ok: false, status: 400, reason: 'invalid_date', error: '日期必须是合法公历日期，格式 YYYY-MM-DD。' };
    }
    dateKey = date;
  }
  const todayKey = shanghaiDateKey(now);
  if (dateKey < SSE_PCF_MIN_DATE_KEY) {
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
    yyyymmdd: dateKey.split('-').join(''),
    dateDefaulted
  };
}

// 唯一的抓取 URL 构造器（进入前再次校验名单，不接受原始输入拼接）。date 不加入 URL。
export function buildSsePcfSourceUrl(code) {
  if (!isValidSsePcfCode(code)) {
    throw new Error('buildSsePcfSourceUrl: 非法的上交所 ETF 代码。');
  }
  return SSE_PCF_SOURCE_URL_BASE + code + '&sqlId=' + SSE_PCF_SOURCE_SQL_ID;
}

// 唯一的结果 key 构造器：etf-pcf:<code>:<yyyymmdd>（与深交所 159xxx 不冲突）。
export function buildSsePcfCacheKey(code, dateKey) {
  if (!isValidSsePcfCode(code) || !isWellFormedSsePcfDateKey(dateKey)) {
    throw new Error('buildSsePcfCacheKey: 非法的 code/date。');
  }
  return 'etf-pcf:' + code + ':' + dateKey.split('-').join('');
}

function isoTime(now) {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString();
}

// ─── SSE 专用额度口径（只用于份额上限字段） ────────────────────────

// trim 后的 ""/"-"/"0" 全部映射为 null + unlimited（未设有限上限），不能生成数值 0 的
// limited，也不能以此推断允许申购；正整数字符串转为正安全整数 + limited；缺字段为
// null + unknown（warning 由调用方记录）；负数、小数、溢出、非数字为损坏（invalid）。
export function parseLimit(rawValue) {
  if (rawValue === undefined || rawValue === null) return { shares: null, kind: 'unknown' };
  if (typeof rawValue === 'number') {
    if (rawValue === 0) return { shares: null, kind: 'unlimited' };
    if (Number.isSafeInteger(rawValue) && rawValue > 0) return { shares: rawValue, kind: 'limited' };
    return { invalid: true };
  }
  if (typeof rawValue !== 'string') return { invalid: true };
  const s = rawValue.trim();
  if (s === '' || s === '-' || s === '0') return { shares: null, kind: 'unlimited' };
  if (/^\d+$/.test(s)) {
    const num = Number(s);
    if (Number.isSafeInteger(num) && num > 0) return { shares: num, kind: 'limited' };
    return { invalid: true }; // 溢出
  }
  return { invalid: true };
}

// ─── JSONP 解析（纯函数，无网络、无 KV，不使用 eval/Function） ─────

// 严格提取一个合法 callback 包裹的 JSON，或源站实际返回的裸 JSON；支持 callback 名变化、
// 两侧空白及可选末尾分号；拒绝额外可执行文本、非法包裹、非法 JSON、错误页、
// 非对象 result[0]；空 result 抛 empty_result（瞬态空响应，由上层重试）。
export function parseSsePcfJsonp(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SsePcfFormatError('上交所清单响应为空。', 'empty_body');
  }
  const trimmed = text.trim();
  let inner = trimmed;
  if (!trimmed.startsWith('{')) {
    const wrapper = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(trimmed);
    if (!wrapper) {
      throw new SsePcfFormatError('上交所清单响应缺少合法 JSONP/JSON 包裹。', 'invalid_wrapper');
    }
    let s = trimmed;
    if (/;\s*$/.test(s)) s = s.replace(/;\s*$/, ''); // 可选末尾分号（仅一个）
    if (!/\)\s*$/.test(s)) {
      throw new SsePcfFormatError('上交所清单响应 JSONP 包裹未闭合。', 'invalid_wrapper');
    }
    s = s.slice(0, s.lastIndexOf(')'));
    inner = s.slice(wrapper[0].length);
  }
  let parsed;
  try {
    parsed = JSON.parse(inner);
  } catch (_e) {
    throw new SsePcfFormatError('上交所清单响应不是合法 JSON。', 'invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SsePcfFormatError('上交所清单响应顶层必须是 JSON 对象。', 'result_shape');
  }
  if (!Array.isArray(parsed.result)) {
    throw new SsePcfFormatError('上交所清单响应缺少 result 数组。', 'result_shape');
  }
  if (parsed.result.length === 0) {
    throw new SsePcfFormatError('上交所清单响应 result 为空。', 'empty_result');
  }
  const row = parsed.result[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new SsePcfFormatError('上交所清单 result[0] 必须是对象。', 'result_row_shape');
  }
  return { row, result: parsed.result };
}

// ─── 字段映射 ─────────────────────────────────────────────────────

// 6 个映射到结构化字段的份额上限（累计/净/单账户累计，申与赎各一组）。
// SSE 的单账户净限额（NET_*_PER_ACCT）不在 plan 映射表内，不映射、不臆造。
const SSE_PCF_LIMIT_FIELD_MAP = [
  ['CREATION_LIMIT', 'totalSubscribeLimitShares', 'totalSubscribeLimitKind'],
  ['NET_CREATION_LIMIT', 'netSubscribeLimitShares', 'netSubscribeLimitKind'],
  ['CREATION_LIMIT_PER_ACCT', 'accountTotalSubscribeLimitShares', 'accountTotalSubscribeLimitKind'],
  ['REDEMPTION_LIMIT', 'totalRedeemLimitShares', 'totalRedeemLimitKind'],
  ['NET_REDEMPTION_LIMIT', 'netRedeemLimitShares', 'netRedeemLimitKind'],
  ['REDEMPTION_LIMIT_PER_ACCT', 'accountTotalRedeemLimitShares', 'accountTotalRedeemLimitKind']
];

// 「申购和赎回皆允许」→ true/true；「仅允许赎回」→ false/true；
// 其它（含缺失）为未知状态 null/null + warning，保留原文，未知状态不等于关闭。
const SSE_PCF_CREATION_REDEMPTION_MAP = {
  申购和赎回皆允许: { subscriptionAllowed: true, redemptionAllowed: true },
  仅允许赎回: { subscriptionAllowed: false, redemptionAllowed: true }
};

// ￥前缀金额：接受负数与数值零，不四舍五入（NAV 有 4 位小数）；空值 → null。
function parseSseMoneyValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s) return { value: null };
  const t = s.replace(/^[￥¥]/, '').replace(/,/g, '').trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const num = Number(t);
    if (Number.isFinite(num)) return { value: num };
  }
  return { unparseable: true };
}

// 现金替代比例上限：只接受明确的百分比表示（真实 fixture 为 "100%"），不猜单位。
function parseCashRatioValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s) return { value: null };
  const m = /^(\d+(?:\.\d+)?)%$/.exec(s);
  if (m) {
    const num = Number(m[1]);
    if (Number.isFinite(num) && num >= 0 && num <= 100) return { value: num };
  }
  return { unparseable: true };
}

// 是否需要公布 IOPV：只接受「是/否」，未知标记不猜。
function parseIopvFlagValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s) return { value: null };
  if (s === '是') return { value: true };
  if (s === '否') return { value: false };
  return { unparseable: true };
}

// 最小申赎单位：正安全整数；不套额度的零哨兵规则（"-"/"0" 不是 unlimited，只是不可用）。
function parseCreationUnitValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s || s === '-') return { value: null };
  if (/^\d+$/.test(s)) {
    const num = Number(s);
    if (Number.isSafeInteger(num) && num > 0) return { value: num };
  }
  return { unparseable: true };
}

function parseCreationRedemptionValue(rawValue) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s) return { value: null };
  const mapped = SSE_PCF_CREATION_REDEMPTION_MAP[s];
  if (mapped) return { value: { ...mapped, creationRedemption: s } };
  return { unparseable: true, creationRedemption: s };
}

// 通用可选字段读取：缺 key 记 warning，无法识别记 warning，值不猜。
function optionalValue(row, key, parseFn, warnings) {
  if (!Object.prototype.hasOwnProperty.call(row, key)) {
    warnings.push('缺少可选字段：' + key);
    return null;
  }
  const parsed = parseFn(row[key]);
  if (parsed && parsed.unparseable) {
    warnings.push('字段值无法识别：' + key);
    return parsed.creationRedemption !== undefined ? parsed.creationRedemption : null;
  }
  return parsed && parsed.value !== undefined ? parsed.value : null;
}

// 验证 TRADE_CODE、8 位 TRADING_DAY 及必要字段，生成结构化对象。
// now 仅为对齐契约签名保留：清单身份日期取 TRADING_DAY，时间戳由持久层添加。
export function mapSsePcfFields(row, { code, now } = {}) {
  if (!isValidSsePcfCode(code)) {
    throw new SsePcfFormatError('上交所 ETF 代码必须在覆盖名单内。', 'invalid_code');
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new SsePcfFormatError('清单行必须是对象。', 'row_shape');
  }
  if (row.TRADE_CODE !== code) {
    throw new SsePcfFormatError('清单 TRADE_CODE 与请求代码不一致。', 'code_mismatch');
  }
  const tradingDay = row.TRADING_DAY;
  if (typeof tradingDay !== 'string' || !/^\d{8}$/.test(tradingDay)) {
    throw new SsePcfFormatError('清单 TRADING_DAY 必须是 8 位日期字符串。', 'trading_day_invalid');
  }
  const dateKey =
    tradingDay.slice(0, 4) + '-' + tradingDay.slice(4, 6) + '-' + tradingDay.slice(6, 8);
  if (!isWellFormedSsePcfDateKey(dateKey)) {
    throw new SsePcfFormatError('清单 TRADING_DAY 不是合法公历日期：' + tradingDay, 'trading_day_invalid');
  }
  if (typeof row.FUND_NAME !== 'string' || !row.FUND_NAME.trim()) {
    throw new SsePcfFormatError('缺少基金名称（FUND_NAME）。', 'missing_fund_name');
  }

  const warnings = [];
  const rawFields = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value == null) continue;
    rawFields[key] = typeof value === 'string' ? value : String(value);
  }

  const result = {
    schemaVersion: SSE_PCF_SCHEMA_VERSION,
    source: SSE_PCF_SOURCE,
    code,
    tradingDay,
    date: dateKey,
    fundName: row.FUND_NAME,
    fundManager: optionalValue(row, 'FUND_COMP_NAME', (v) => {
      const s = String(v == null ? '' : v).trim();
      return s ? { value: s } : { value: null };
    }, warnings)
  };

  // 6 组映射上限：缺字段 null + unknown + warning；损坏值拒绝整条解析。
  for (const [sourceKey, sharesKey, kindKey] of SSE_PCF_LIMIT_FIELD_MAP) {
    let parsed;
    if (!Object.prototype.hasOwnProperty.call(row, sourceKey)) {
      warnings.push('缺少可选字段：' + sourceKey);
      parsed = { shares: null, kind: 'unknown' };
    } else {
      parsed = parseLimit(row[sourceKey]);
      if (parsed.invalid) {
        throw new SsePcfFormatError('额度字段数值损坏：' + sourceKey, 'corrupt_limit_field');
      }
    }
    result[sharesKey] = parsed.shares;
    result[kindKey] = parsed.kind;
  }
  // SSE 映射表不提供单账户净申赎限额：固定 null + unknown，不臆造数值。
  result.accountNetSubscribeLimitShares = null;
  result.accountNetSubscribeLimitKind = 'unknown';
  result.accountNetRedeemLimitShares = null;
  result.accountNetRedeemLimitKind = 'unknown';
  warnings.push('上游未提供单账户净限额字段：NET_CREATION_LIMIT_PER_ACCT');
  warnings.push('上游未提供单账户净限额字段：NET_REDEMPTION_LIMIT_PER_ACCT');

  // 申赎状态：已知短语映射布尔；未知状态 null/null + warning，保留原文（不等于关闭）。
  result.creationRedemption = null;
  result.subscriptionAllowed = null;
  result.redemptionAllowed = null;
  if (!Object.prototype.hasOwnProperty.call(row, 'CREATION_REDEMPTION')) {
    warnings.push('缺少可选字段：CREATION_REDEMPTION');
  } else {
    const parsed = parseCreationRedemptionValue(row.CREATION_REDEMPTION);
    if (parsed.unparseable) {
      warnings.push('字段值无法识别：CREATION_REDEMPTION');
      result.creationRedemption = parsed.creationRedemption;
    } else if (parsed.value) {
      result.creationRedemption = parsed.value.creationRedemption;
      result.subscriptionAllowed = parsed.value.subscriptionAllowed;
      result.redemptionAllowed = parsed.value.redemptionAllowed;
    }
  }

  result.creationRedemptionUnitShares = optionalValue(
    row,
    'CREATION_REDEMPTION_UNIT',
    parseCreationUnitValue,
    warnings
  );
  result.estimatedCashDifference = optionalValue(
    row,
    'ESTIMATED_CASH_COMPONENT',
    parseSseMoneyValue,
    warnings
  );
  result.cashSubstitutionRatioLimitPct = optionalValue(
    row,
    'MAX_CASH_RATIO',
    parseCashRatioValue,
    warnings
  );
  result.iopvRequired = optionalValue(row, 'PUBLISH_IOPV', parseIopvFlagValue, warnings);
  // NAVPERCU / NAV 分别保存，不互相推导或填充。
  result.navPerCreationUnit = optionalValue(row, 'NAVPERCU', parseSseMoneyValue, warnings);
  result.nav = optionalValue(row, 'NAV', parseSseMoneyValue, warnings);
  result.prevDayCashDifference = optionalValue(row, 'PRE_CASH_COMPONENT', parseSseMoneyValue, warnings);
  result.prevDayDate = optionalValue(row, 'PRE_TRADING_DAY', (value) => {
    if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return { unparseable: true };
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    return isWellFormedSsePcfDateKey(date) ? { value: date } : { unparseable: true };
  }, warnings);

  result.prevDayCashDifference = optionalValue(row, 'PRE_CASH_COMPONENT', parseSseMoneyValue, warnings);
  result.prevDayDate = optionalValue(row, 'PRE_TRADING_DAY', (value) => {
    if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return { unparseable: true };
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    return isWellFormedSsePcfDateKey(date) ? { value: date } : { unparseable: true };
  }, warnings);
  result.rawFields = rawFields;
  result.warnings = warnings;
  return result;
}

// ─── 持久化数据校验（读缓存与写缓存共用） ─────────────────────────

const SSE_PCF_LIMIT_KINDS = new Set(['limited', 'unlimited', 'unknown']);
const SSE_PCF_LIMIT_PAIRS = [
  ['totalSubscribeLimitShares', 'totalSubscribeLimitKind'],
  ['netSubscribeLimitShares', 'netSubscribeLimitKind'],
  ['accountTotalSubscribeLimitShares', 'accountTotalSubscribeLimitKind'],
  ['totalRedeemLimitShares', 'totalRedeemLimitKind'],
  ['netRedeemLimitShares', 'netRedeemLimitKind'],
  ['accountTotalRedeemLimitShares', 'accountTotalRedeemLimitKind'],
  ['accountNetSubscribeLimitShares', 'accountNetSubscribeLimitKind'],
  ['accountNetRedeemLimitShares', 'accountNetRedeemLimitKind']
];

function isStringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const k of Object.keys(value)) {
    if (typeof value[k] !== 'string') return false;
  }
  return true;
}

// 身份（code/date/tradingDay 三方一致）、source、schemaVersion、额度与 kind 配对、
// 状态与字段形态、fetchedAt/expiresAt（过期、未来时间、TTL 异常）全部校验，
// 任一失败视为 miss；错误来源（如 szse_pcf）一律视为 miss。
export function validateSsePcfCachedData(data, { code, date, now = new Date() }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'shape' };
  if (data.schemaVersion !== SSE_PCF_SCHEMA_VERSION) return { ok: false, reason: 'schema_version' };
  if (data.source !== SSE_PCF_SOURCE) return { ok: false, reason: 'source' };
  if (data.code !== code || data.date !== date) return { ok: false, reason: 'identity' };
  if (typeof data.tradingDay !== 'string' || !/^\d{8}$/.test(data.tradingDay)) {
    return { ok: false, reason: 'trading_day' };
  }
  if (data.tradingDay !== String(date).split('-').join('')) return { ok: false, reason: 'trading_day' };
  if (typeof data.fundName !== 'string' || !data.fundName) return { ok: false, reason: 'fund_name' };
  if (data.fundManager != null && typeof data.fundManager !== 'string') {
    return { ok: false, reason: 'fund_manager' };
  }
  if (data.creationRedemption != null && typeof data.creationRedemption !== 'string') {
    return { ok: false, reason: 'creation_redemption' };
  }
  for (const [sharesKey, kindKey] of SSE_PCF_LIMIT_PAIRS) {
    if (!SSE_PCF_LIMIT_KINDS.has(data[kindKey])) return { ok: false, reason: kindKey };
    if (data[kindKey] === 'limited') {
      if (!(Number.isSafeInteger(data[sharesKey]) && data[sharesKey] > 0)) {
        return { ok: false, reason: sharesKey };
      }
    } else if (data[sharesKey] != null) {
      return { ok: false, reason: sharesKey };
    }
  }
  if (
    data.creationRedemptionUnitShares != null &&
    !(Number.isSafeInteger(data.creationRedemptionUnitShares) && data.creationRedemptionUnitShares > 0)
  ) {
    return { ok: false, reason: 'creation_unit' };
  }
  for (const key of ['subscriptionAllowed', 'redemptionAllowed', 'iopvRequired']) {
    if (data[key] != null && typeof data[key] !== 'boolean') return { ok: false, reason: key };
  }
  if (data.prevDayDate != null && !isWellFormedSsePcfDateKey(data.prevDayDate)) {
    return { ok: false, reason: 'prev_day_date' };
  }
  for (const key of ['estimatedCashDifference', 'navPerCreationUnit', 'nav', 'prevDayCashDifference']) {
    if (data[key] != null && !(typeof data[key] === 'number' && Number.isFinite(data[key]))) {
      return { ok: false, reason: key };
    }
  }
  if (
    data.cashSubstitutionRatioLimitPct != null &&
    !(
      typeof data.cashSubstitutionRatioLimitPct === 'number' &&
      Number.isFinite(data.cashSubstitutionRatioLimitPct) &&
      data.cashSubstitutionRatioLimitPct >= 0 &&
      data.cashSubstitutionRatioLimitPct <= 100
    )
  ) {
    return { ok: false, reason: 'cash_substitution_ratio' };
  }
  if (!isStringRecord(data.rawFields)) return { ok: false, reason: 'raw_fields' };
  if (!Array.isArray(data.warnings) || data.warnings.some((w) => typeof w !== 'string')) {
    return { ok: false, reason: 'warnings' };
  }
  if (typeof data.sourceUrl !== 'string' || !data.sourceUrl) return { ok: false, reason: 'source_url' };
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
  if (expiresAtMs - fetchedAtMs > SSE_PCF_TTL_MS + 60000) return { ok: false, reason: 'ttl_anomaly' };
  return { ok: true };
}

// ─── 抓取（单次外部请求，5 秒全程超时、abort 清理、拒绝跳转、1 MiB 流式上限） ──

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
    if (u8.byteLength > SSE_PCF_MAX_BYTES) {
      const err = new Error('上交所清单响应超过 1 MiB 上限。');
      err.__ssePcfSizeExceeded = true;
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
      if (total > SSE_PCF_MAX_BYTES) {
        try {
          ctrl.abort();
        } catch (_e) {
          // ignore
        }
        const err = new Error('上交所清单响应超过 1 MiB 上限。');
        err.__ssePcfSizeExceeded = true;
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
    return { ok: false, reason: 'timeout', status: 504, error: '抓取上交所清单超时。', sourceUrl };
  }
  if (externallyAborted) {
    return { ok: false, reason: 'aborted', status: 504, error: '抓取上交所清单被中止。', sourceUrl };
  }
  return { ok: false, reason: 'fetch_failed', status: 502, error: '抓取上交所清单失败。', sourceUrl };
}

// 单次尝试：固定 URL + Referer；404/HTTP 错误先消费或取消 body 再返回；
// 空正文与空 result 都分类为瞬态 empty_response，不解释为额度 0 或暂停申购。
export async function fetchSsePcfJsonp({
  code,
  fetchImpl,
  signal,
  timeoutMs = SSE_PCF_FETCH_TIMEOUT_MS
}) {
  if (!isValidSsePcfCode(code)) {
    return { ok: false, reason: 'invalid_params', status: 400, error: '非法的上交所 ETF 代码。' };
  }
  const sourceUrl = buildSsePcfSourceUrl(code);
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
      // 因此用 'manual' 并在下面显式拒绝 3xx（http_error，非瞬态不重试），跳转永不跟随。
      resp = await fetchFn(sourceUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { Referer: SSE_PCF_REFERER }
      });
    } catch (e) {
      return transportErrorResult(e, { timedOut, externallyAborted, sourceUrl });
    }
    if (!resp || typeof resp.status !== 'number') {
      return { ok: false, reason: 'fetch_failed', status: 502, error: '上游未返回有效响应。', sourceUrl };
    }
    if (resp.status === 404) {
      await cancelResponseBody(resp);
      return { ok: false, reason: 'upstream_not_found', status: 404, error: '上交所清单接口未返回该基金清单。', sourceUrl };
    }
    if (resp.status !== 200) {
      await cancelResponseBody(resp);
      return {
        ok: false,
        reason: 'http_error',
        status: 502,
        error: '上交所清单接口返回 HTTP ' + resp.status + '。',
        httpStatus: resp.status,
        sourceUrl
      };
    }
    const lenHeader =
      resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('content-length') : null;
    if (lenHeader && Number(lenHeader) > SSE_PCF_MAX_BYTES) {
      try {
        ctrl.abort();
      } catch (_e) {
        // ignore
      }
      await cancelResponseBody(resp);
      return { ok: false, reason: 'fetch_failed', status: 502, error: '上交所清单响应超过 1 MiB 上限。', sourceUrl };
    }
    let bytes;
    try {
      bytes = await readBodyWithLimit(resp, ctrl);
    } catch (e) {
      if (e && e.__ssePcfSizeExceeded) {
        return { ok: false, reason: 'fetch_failed', status: 502, error: '上交所清单响应超过 1 MiB 上限。', sourceUrl };
      }
      return transportErrorResult(e, { timedOut, externallyAborted, sourceUrl });
    }
    if (timedOut) {
      return { ok: false, reason: 'timeout', status: 504, error: '抓取上交所清单超时。', sourceUrl };
    }
    let text;
    try {
      // 上交所清单接口为 UTF-8 JSON；fatal 解码拒绝把乱码当正文解析。
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_e) {
      return { ok: false, reason: 'parse_failed', status: 502, error: '上交所清单响应 UTF-8 解码失败。', sourceUrl };
    }
    if (!text || !text.trim()) {
      return { ok: false, reason: 'empty_response', status: 502, error: '上交所清单响应为空。', sourceUrl };
    }
    let parsed;
    try {
      parsed = parseSsePcfJsonp(text);
    } catch (e) {
      if (e instanceof SsePcfFormatError && (e.reason === 'empty_result' || e.reason === 'empty_body')) {
        return { ok: false, reason: 'empty_response', status: 502, error: '上交所清单接口返回空 result。', sourceUrl };
      }
      return {
        ok: false,
        reason: 'parse_failed',
        status: 502,
        error: (e && e.message) || '上交所清单 JSONP 解析失败。',
        sourceUrl
      };
    }
    return { ok: true, row: parsed.row, sourceUrl };
  } finally {
    clearTimeout(timer);
    if (linked && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function isTransientSseResult(result) {
  if (!result) return false;
  if (result.reason === 'empty_response' || result.reason === 'timeout' || result.reason === 'fetch_failed') {
    return true;
  }
  if (result.reason === 'http_error' && (result.httpStatus === 429 || result.httpStatus >= 500)) {
    return true;
  }
  return false;
}

// 退避等待：外部 abort 立即返回 true（不再发起下一次尝试）。
function sleepOrAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve(true);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      resolve(false);
    }, ms);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ─── memory / inflight ─────────────────────────────────────────────

function setSsePcfMemory(key, data) {
  if (ssePcfMemory.size >= SSE_PCF_MEMORY_MAX_ENTRIES) {
    const oldest = ssePcfMemory.keys().next().value;
    if (oldest !== undefined) ssePcfMemory.delete(oldest);
  }
  ssePcfMemory.set(key, { data });
}

// 测试专用：清空模块内 memory 与 inflight 状态。
export function clearSsePcfRuntimeStateForTests() {
  ssePcfMemory.clear();
  ssePcfInflight.clear();
}

// ─── 读缓存（仅 memory/KV，绝不访问外部源） ────────────────────────

export async function readSsePcfLimitCache({ code, date, env, now = new Date() }) {
  const v = validateSsePcfRequest({ code, date, now });
  if (!v.ok) {
    return { ok: false, status: 400, reason: v.reason, error: v.error, code: code ?? null, date: date ?? null };
  }
  if (!env || !env.FUND_LIMIT_KV) {
    return { ok: false, status: 503, reason: 'kv_unavailable', error: 'ETF PCF 缓存 KV 未配置。', code: v.code, date: v.date };
  }
  const key = buildSsePcfCacheKey(v.code, v.date);

  const mem = ssePcfMemory.get(key);
  if (mem) {
    const check = validateSsePcfCachedData(mem.data, { code: v.code, date: v.date, now });
    if (check.ok) {
      return { ok: true, status: 200, data: { ...mem.data, cached: true } };
    }
    ssePcfMemory.delete(key);
  }

  let raw;
  try {
    raw = await env.FUND_LIMIT_KV.get(key);
  } catch (_e) {
    return { ok: false, status: 503, reason: 'kv_read_failed', error: 'ETF PCF 缓存读取失败。', code: v.code, date: v.date };
  }
  if (raw == null) {
    return { ok: false, status: 404, reason: 'cache_miss', error: '当日 PCF 限额缓存未命中。', code: v.code, date: v.date };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_e) {
    return { ok: false, status: 404, reason: 'cache_miss', error: '当日 PCF 限额缓存损坏。', code: v.code, date: v.date };
  }
  const check = validateSsePcfCachedData(data, { code: v.code, date: v.date, now });
  if (!check.ok) {
    return { ok: false, status: 404, reason: 'cache_miss', error: '当日 PCF 限额缓存无效。', code: v.code, date: v.date };
  }
  setSsePcfMemory(key, data);
  return { ok: true, status: 200, data: { ...data, cached: true } };
}

// ─── 单标的服务（默认缓存优先；抓取 → 解析 → 日期核对 → await KV 写入） ──

export async function fetchSsePcfLimit({
  code,
  date,
  env,
  forceRefresh = false,
  now = new Date(),
  fetchImpl,
  signal,
  timeoutMs
}) {
  const v = validateSsePcfRequest({ code, date, now });
  if (!v.ok) {
    return { ok: false, status: 400, reason: v.reason, error: v.error, code: code ?? null, date: date ?? null, attempts: 0 };
  }
  // 缺 KV binding 在访问外部源前直接 503。
  if (!env || !env.FUND_LIMIT_KV) {
    return { ok: false, status: 503, reason: 'kv_unavailable', error: 'ETF PCF 缓存 KV 未配置。', code: v.code, date: v.date, attempts: 0 };
  }
  if (!forceRefresh) {
    const cached = await readSsePcfLimitCache({ code: v.code, date: v.dateKey, env, now });
    if (cached.ok || cached.status === 503) return cached;
  }
  // 无 date 的刷新以 code+latest 做 inflight 去重，指定日期按 code+date 去重；
  // 两者最终都写同一个 code+TRADING_DAY 结果 key，不建立第二套结果缓存。
  const inflightKey = v.dateDefaulted ? v.code + '|latest' : v.code + '|' + v.dateKey;
  const existing = ssePcfInflight.get(inflightKey);
  if (existing) return existing;

  const task = (async () => {
    // 单 code 外部调用同样经过 mapLimit([code], 1, ...)；瞬态重试在原 lane 内执行。
    const [outcome] = await mapLimit([v.code], 1, async () => {
      let attempts = 0;
      let result;
      for (;;) {
        if (signal && signal.aborted) {
          return { ok: false, status: 504, reason: 'aborted', error: '抓取上交所清单被中止。', attempts };
        }
        result = await fetchSsePcfJsonp({ code: v.code, fetchImpl, signal, timeoutMs });
        attempts += 1;
        result.attempts = attempts;
        if (result.ok) return result;
        if (attempts >= SSE_PCF_MAX_ATTEMPTS || !isTransientSseResult(result)) return result;
        const aborted = await sleepOrAbort(SSE_PCF_RETRY_BACKOFF_MS[attempts - 1], signal);
        if (aborted) {
          return { ok: false, status: 504, reason: 'aborted', error: '抓取上交所清单被中止。', attempts };
        }
      }
    });
    if (!outcome || outcome.__error) {
      return {
        ok: false,
        status: 502,
        reason: 'fetch_failed',
        error: '抓取上交所清单失败：' + (outcome && outcome.__error ? outcome.__error : '未知错误'),
        code: v.code,
        date: v.date,
        attempts: 0
      };
    }
    if (!outcome.ok) {
      return {
        ok: false,
        status: outcome.status || 502,
        reason: outcome.reason,
        error: outcome.error,
        httpStatus: outcome.httpStatus,
        code: v.code,
        date: v.date,
        attempts: outcome.attempts || 0
      };
    }
    let structured;
    try {
      structured = mapSsePcfFields(outcome.row, { code: v.code, now });
    } catch (e) {
      return {
        ok: false,
        status: 502,
        reason: 'parse_failed',
        error: (e && e.message) || '上交所清单字段解析失败。',
        code: v.code,
        date: v.date,
        attempts: outcome.attempts || 0
      };
    }
    // 指定 date 是「期望源站返回的清单日期」：与 TRADING_DAY 不一致返回 404，
    // 不写请求日期或任何伪造历史缓存；缺省 date 用接口 TRADING_DAY 入库。
    if (!v.dateDefaulted && structured.tradingDay !== v.yyyymmdd) {
      return {
        ok: false,
        status: 404,
        reason: 'upstream_not_found',
        error: '上交所最新清单日期（' + structured.date + '）与请求日期（' + v.date + '）不一致。',
        code: v.code,
        date: v.date,
        attempts: outcome.attempts || 0
      };
    }
    const fetchedAt = isoTime(now);
    const expiresAt = new Date(
      (now instanceof Date ? now.getTime() : Number(now)) + SSE_PCF_TTL_MS
    ).toISOString();
    const persisted = { ...structured, sourceUrl: outcome.sourceUrl, fetchedAt, expiresAt };
    const check = validateSsePcfCachedData(persisted, { code: v.code, date: structured.date, now });
    if (!check.ok) {
      return {
        ok: false,
        status: 502,
        reason: 'parse_failed',
        error: '解析结果校验失败：' + check.reason,
        code: v.code,
        date: structured.date,
        attempts: outcome.attempts || 0
      };
    }
    // 写前再次核对名单与真实公历日期；成功抓取解析后必须 await 写入，写失败不冒充已缓存。
    const key = buildSsePcfCacheKey(v.code, structured.date);
    try {
      await env.FUND_LIMIT_KV.put(key, JSON.stringify(persisted), { expirationTtl: SSE_PCF_TTL_SECONDS });
    } catch (_e) {
      return {
        ok: false,
        status: 503,
        reason: 'kv_write_failed',
        error: 'ETF PCF 缓存写入失败。',
        code: v.code,
        date: structured.date,
        attempts: outcome.attempts || 0
      };
    }
    setSsePcfMemory(key, persisted);
    return { ok: true, status: 200, data: { ...persisted, cached: false }, attempts: outcome.attempts || 0 };
  })();

  ssePcfInflight.set(inflightKey, task);
  try {
    return await task;
  } finally {
    ssePcfInflight.delete(inflightKey);
  }
}

// ─── 固定名单刷新（mapLimit 并发 2，逐项隔离并分类汇总） ────────────

function classifySseRefreshBucket(result, isDeadlineAborted) {
  if (result && result.ok) return 'success';
  const reason = result && result.reason;
  if (reason === 'upstream_not_found') return 'notFound';
  if (reason === 'parse_failed') return 'parseFailed';
  if (reason === 'kv_write_failed' || reason === 'kv_unavailable') return 'kvWriteFailed';
  if (reason === 'aborted' && isDeadlineAborted()) return 'skippedDeadline';
  return 'fetchFailed'; // timeout / http_error / empty_response / fetch_failed / aborted（外部）
}

export async function refreshSsePcfLimitCache({
  env,
  now = new Date(),
  fetchImpl,
  signal,
  concurrency = SSE_PCF_REFRESH_CONCURRENCY,
  timeoutMs,
  deadlineMs
} = {}) {
  const emptyStats = {
    total: SSE_PCF_CODES.length,
    success: 0,
    notFound: 0,
    fetchFailed: 0,
    parseFailed: 0,
    kvWriteFailed: 0,
    skippedDeadline: 0,
    durationMs: 0,
    attempts: 0,
    retries: 0
  };
  // 缺 KV binding 时 5 只注定 kv_write_failed：提前返回，不访问外部源。
  if (!env || !env.FUND_LIMIT_KV) {
    return {
      ok: false,
      status: 503,
      reason: 'kv_unavailable',
      error: 'ETF PCF 缓存 KV 未配置。',
      stats: { ...emptyStats, kvWriteFailed: SSE_PCF_CODES.length },
      failures: SSE_PCF_CODES.map((code) => ({ code, bucket: 'kvWriteFailed', reason: 'kv_unavailable', attempts: 0 }))
    };
  }
  const startMs = Date.now();
  const hasDeadline = Number.isFinite(deadlineMs) && deadlineMs >= 0;
  const deadlineAt = hasDeadline ? startMs + deadlineMs : undefined;
  let deadlineFired = false;
  const deadlineCtrl = hasDeadline ? new AbortController() : null;
  const deadlineTimer = deadlineCtrl
    ? setTimeout(() => {
        deadlineFired = true;
        try {
          deadlineCtrl.abort();
        } catch (_e) {
          // ignore
        }
      }, deadlineMs)
    : null;
  // 外部 signal 与内部 deadline 合并：任一 abort 都取消进行中的清单请求；
  // 只有 deadline 触发的 abort 才分类为 skippedDeadline。
  let externalListener = null;
  if (signal && deadlineCtrl) {
    if (signal.aborted) {
      try {
        deadlineCtrl.abort();
      } catch (_e) {
        // ignore
      }
    } else if (typeof signal.addEventListener === 'function') {
      externalListener = () => {
        try {
          deadlineCtrl.abort();
        } catch (_e) {
          // ignore
        }
      };
      signal.addEventListener('abort', externalListener);
    }
  }
  const laneSignal = deadlineCtrl ? deadlineCtrl.signal : signal || undefined;

  try {
    const results = await mapLimit(SSE_PCF_CODES, concurrency, async (code) => {
      try {
        // 软预算到期：停止分配新任务并分类跳过（不发起外部请求）。
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
          return { code, bucket: 'skippedDeadline', reason: 'deadline', attempts: 0 };
        }
        const r = await fetchSsePcfLimit({ code, env, forceRefresh: true, now, fetchImpl, signal: laneSignal, timeoutMs });
        return {
          code,
          bucket: classifySseRefreshBucket(r, () => deadlineFired),
          reason: r && r.reason,
          attempts: (r && r.attempts) || 0
        };
      } catch (e) {
        // 单只异常不中断其余基金；此处保留 code 便于汇总。
        return { code, bucket: 'fetchFailed', reason: 'worker_error', error: String((e && e.message) || e), attempts: 0 };
      }
    });

    const stats = { ...emptyStats, durationMs: Date.now() - startMs };
    const failures = [];
    for (const r of results) {
      // mapLimit 的 __error 兜底（正常路径不会出现，worker 内已捕获）。
      const item = r && r.__error ? { code: 'unknown', bucket: 'fetchFailed', reason: 'worker_error', attempts: 0 } : r;
      stats[item.bucket] += 1;
      stats.attempts += item.attempts || 0;
      if ((item.attempts || 0) > 1) stats.retries += item.attempts - 1;
      if (item.bucket !== 'success' && item.bucket !== 'notFound') {
        failures.push({ code: item.code, bucket: item.bucket, reason: item.reason, attempts: item.attempts || 0 });
      }
    }
    const accounted =
      stats.success + stats.notFound + stats.fetchFailed + stats.parseFailed + stats.kvWriteFailed + stats.skippedDeadline;
    if (accounted !== stats.total) {
      return { ok: false, status: 500, reason: 'refresh_accounting_mismatch', error: '刷新分类统计不等于 total。', stats, failures };
    }
    console.log(
      '[etf-pcf][sse] refresh success=' +
        stats.success +
        '/' +
        stats.total +
        ' notFound=' +
        stats.notFound +
        ' fetchFailed=' +
        stats.fetchFailed +
        ' parseFailed=' +
        stats.parseFailed +
        ' kvWriteFailed=' +
        stats.kvWriteFailed +
        ' skipped=' +
        stats.skippedDeadline +
        ' attempts=' +
        stats.attempts +
        ' retries=' +
        stats.retries +
        ' durationMs=' +
        stats.durationMs +
        (failures.length ? ' failures=' + failures.map((f) => f.code + ':' + f.reason).join(',') : '')
    );
    return { ok: true, stats, failures };
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    if (externalListener && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', externalListener);
    }
  }
}
