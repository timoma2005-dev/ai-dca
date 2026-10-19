import { isCompleteSharesCalendar } from './etfPcfTradingCalendar.js';
export const TARGET_CODES = [
  '159501',
  '159509',
  '159513',
  '159632',
  '159659',
  '159660',
  '159696',
  '159941',
  '513100',
  '513110',
  '513300',
  '513390',
  '513870'
];
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

const NAMES = [
  '纳指ETF嘉实',
  '纳指科技ETF景顺',
  '纳斯达克100ETF大成',
  '纳斯达克ETF华安',
  '纳斯达克100ETF招商',
  '纳指ETF汇添富',
  '纳指ETF易方达',
  '纳指ETF广发',
  '纳斯达克100ETF国泰',
  '纳指ETF国泰',
  '纳指ETF广发',
  '纳斯达克100ETF华夏',
  '纳指ETF华宝'
];
export const TTL = 30 * 86400000;
export const SOURCE = 'szse_pcf_shares_projection';
const dateOK = (d) => isWellFormedEtfPcfDateKey(d) && d >= '2000-01-01';
const iso = (s) =>
  typeof s === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString() === s;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
export function sharesKey(date) {
  if (!dateOK(date)) throw Error('invalid_date');
  return `etf-pcf-shares:${date.replaceAll('-', '')}`;
}
// No weekday heuristic: adjacent sessions require an explicit, complete calendar.
export function previousSession(date, calendar) {
  if (
    !isCompleteSharesCalendar(calendar) ||
    calendar.source !== 'verified_trading_calendar' ||
    !Array.isArray(calendar.sessions) ||
    !dateOK(calendar.from) ||
    !dateOK(calendar.to) ||
    calendar.from >= date ||
    calendar.to < date
  )
    return null;
  const sessions = calendar.sessions;
  if (
    !sessions.every(
      (d, i) => dateOK(d) && d >= calendar.from && d <= calendar.to && (!i || sessions[i - 1] < d)
    )
  )
    return null;
  const i = sessions.indexOf(date);
  return i > 0 ? sessions[i - 1] : null;
}
// PCF 状态仅来自同一数据日的快照，未知状态不猜测。
export function normalizeCreationStatus(input) {
  const states = {
    仅允许赎回: [false, true],
    仅允许申购: [true, false],
    申购和赎回皆允许: [true, true],
    申购赎回都允许: [true, true],
    申购和赎回都允许: [true, true]
  };
  const text = typeof input === 'string' ? input : input?.creationRedemption;
  if (typeof text === 'string') {
    const pair = states[text.trim()];
    return { subscriptionAllowed: pair?.[0] ?? null, redemptionAllowed: pair?.[1] ?? null };
  }
  return {
    subscriptionAllowed: typeof input?.subscriptionAllowed === 'boolean' ? input.subscriptionAllowed : null,
    redemptionAllowed: typeof input?.redemptionAllowed === 'boolean' ? input.redemptionAllowed : null
  };
}
function creationFromStatus(status, deltaShares) {
  const { subscriptionAllowed, redemptionAllowed } = normalizeCreationStatus(status);
  if (subscriptionAllowed === false) return { creationShares: 0, creationSharesKind: 'exact' };
  if (subscriptionAllowed === true && deltaShares !== null) {
    if (redemptionAllowed === false && deltaShares >= 0)
      return { creationShares: deltaShares, creationSharesKind: 'exact' };
    if (redemptionAllowed === true) return { creationShares: deltaShares, creationSharesKind: 'estimate' };
  }
  return { creationShares: null, creationSharesKind: null };
}
export function buildSharesProjection({
  date,
  records,
  limits = [],
  creationStatus = {},
  fetchedAt,
  projectedAt = new Date().toISOString(),
  dateEvidence,
  calendar = null
}) {
  const previous = previousSession(date, calendar);
  const rows = TARGET_CODES.map((code, index) => {
    const hasSharesSource = code.startsWith('159');
    const cur = hasSharesSource && records.find((r) => r.code === code && r.date === date);
    const old = previous && records.find((r) => r.code === code && r.date === previous);
    const shares = integer(cur?.shares) ? cur.shares : null;
    const prevShares = shares !== null && integer(old?.shares) && old.unit === cur.unit ? old.shares : null;
    const delta = prevShares === null ? null : shares - prevShares;
    const deltaShares = Number.isSafeInteger(delta) ? delta : null;
    const limit = hasSharesSource && limits.find((r) => r.code === code && r.date === date)?.total;
    const kind = ['limited', 'unlimited', 'unknown'].includes(limit?.kind) ? limit.kind : 'unknown';
    const total = kind === 'limited' && integer(limit.shares) ? limit.shares : null;
    const limitEntry = hasSharesSource && limits.find((r) => r.code === code && r.date === date);
    const creationUnit = integer(limitEntry?.creationUnitShares) ? limitEntry.creationUnitShares : null;
    // 净申购上限：基本没人赎回，净申购上限约等于当日申购上限，优先使用。
    const netLimit = limitEntry?.net;
    const netKind = ['limited', 'unlimited', 'unknown'].includes(netLimit?.kind) ? netLimit.kind : 'unknown';
    const netShares = netKind === 'limited' && integer(netLimit.shares) ? netLimit.shares : null;
    // 生效限额：净申购上限优先（基本没人赎回，约等于当日申购上限），没有则用累计申购上限。
    // net=limited 用净；net=unlimited/unknown 时回退到累计。
    let effKind, effShares, limitSource;
    if (netKind === 'limited') {
      effKind = 'limited'; effShares = netShares; limitSource = 'net';
    } else if (kind === 'limited') {
      effKind = 'limited'; effShares = total; limitSource = 'total';
    } else if (kind === 'unlimited') {
      effKind = 'unlimited'; effShares = null; limitSource = 'total';
    } else {
      effKind = 'unknown'; effShares = null; limitSource = null;
    }
    const usable = deltaShares !== null && effShares > 0;
    // 申赎状态透传到 record，供前端表格直接展示"暂停申购"等状态，无需额外请求。
    const creationStatusNorm = normalizeCreationStatus(creationStatus[code]);
    const reasons = ['missing_dated_nav'];
    if (shares === null) reasons.push('missing_shares');
    if (deltaShares === null)
      reasons.push(previous ? 'missing_previous_shares' : 'unconfirmed_previous_session');
    if (kind === 'unknown') reasons.push('missing_total_limit');
    return {
      code,
      name: cur?.name || NAMES[index],
      date,
      prevDate: prevShares === null ? null : previous,
      shares,
      prevShares,
      deltaShares,
      ...creationFromStatus(creationStatus[code], deltaShares),
      deltaAmountWan: null,
      unit: '份',
      price: null,
      priceDate: null,
      priceKind: null,
      priceSource: null,
      priceEvidence: null,
      totalLimitKind: kind,
      totalLimitShares: total,
      netLimitKind: netKind,
      netLimitShares: netShares,
      // 生效限额（净优先）及来源角标：net=净申购上限，total=累计申购上限。
      effLimitKind: effKind,
      effLimitShares: effShares,
      limitSource,
      limitDate: limit ? date : null,
      creationUnitShares: creationUnit,
      subscriptionAllowed: creationStatusNorm.subscriptionAllowed,
      redemptionAllowed: creationStatusNorm.redemptionAllowed,
      utilization: usable ? deltaShares / effShares : null,
      atLimit: usable ? deltaShares === effShares : null,
      nearTotalLimit: usable ? deltaShares >= 0 && deltaShares / effShares >= 0.9 : null,
      status: shares !== null && deltaShares !== null ? 'complete' : 'partial',
      reasons
    };
  });
  return {
    version: 1,
    source: SOURCE,
    inputSource: 'szse_fund_report',
    date,
    prevDate: rows.some((r) => r.prevDate) ? previous : null,
    fetchedAt,
    projectedAt,
    expiresAt: new Date(Date.parse(fetchedAt) + TTL).toISOString(),
    availableOn: shanghaiDateKey(new Date(fetchedAt)),
    status: rows.every((r) => r.status === 'complete') ? 'complete' : 'partial',
    records: rows,
    dateEvidence,
    calendar
  };
}
export function validateSharesProjection(x, { date = x?.date, now = new Date() } = {}) {
  if (
    !x ||
    x.version !== 1 ||
    x.source !== SOURCE ||
    x.inputSource !== 'szse_fund_report' ||
    x.date !== date ||
    !dateOK(date) ||
    ![x.fetchedAt, x.projectedAt, x.expiresAt].every(iso)
  )
    return false;
  if (
    x.pcfSnapshot != null &&
    (x.pcfSnapshot.source !== 'szse_pcf' ||
      !dateOK(x.pcfSnapshot.date) ||
      x.pcfSnapshot.date < date ||
      x.pcfSnapshot.date > shanghaiDateKey(now) ||
      !Array.isArray(x.pcfSnapshot.codes) ||
      !x.pcfSnapshot.codes.length ||
      !x.pcfSnapshot.codes.every(
        (code) => typeof code === 'string' && code.startsWith('159') && TARGET_CODES.includes(code)
      ) ||
      new Set(x.pcfSnapshot.codes).size !== x.pcfSnapshot.codes.length)
  )
    return false;
  const fetched = Date.parse(x.fetchedAt),
    projected = Date.parse(x.projectedAt);
  if (
    fetched > +now ||
    projected > +now ||
    projected < fetched ||
    Date.parse(x.expiresAt) !== fetched + TTL ||
    +now >= fetched + TTL ||
    x.availableOn !== shanghaiDateKey(new Date(fetched)) ||
    date > x.availableOn ||
    date > shanghaiDateKey(now)
  )
    return false;
  if (
    !x.dateEvidence ||
    x.dateEvidence.source !== 'szse_fund_report' ||
    !(
      (typeof x.dateEvidence.column === 'string' &&
        /^(日期|报表日期|截止日期|报告日期|统计日期|数据日期)$/.test(x.dateEvidence.column) &&
        ['iso_date', 'excel_date'].includes(x.dateEvidence.type)) ||
      (x.dateEvidence.column === null &&
        x.dateEvidence.type === 'inferred_from_fetch_time' &&
        typeof x.dateEvidence.inferredDate === 'string')
    )
  )
    return false;
  if (
    !Array.isArray(x.records) ||
    x.records.length !== TARGET_CODES.length ||
    !x.records.some((r) => integer(r?.shares))
  )
    return false;
  const previous = previousSession(date, x.calendar);
  if (x.prevDate !== (x.records.some((r) => r?.prevDate) ? previous : null)) return false;
  for (const [i, r] of x.records.entries()) {
    if (
      !r ||
      r.code !== TARGET_CODES[i] ||
      r.date !== date ||
      typeof r.name !== 'string' ||
      !r.name ||
      r.name.length > 512 ||
      r.unit !== '份' ||
      !Array.isArray(r.reasons) ||
      !r.reasons.every((v) =>
        [
          'missing_dated_nav',
          'missing_shares',
          'missing_previous_shares',
          'unconfirmed_previous_session',
          'missing_total_limit'
        ].includes(v)
      ) ||
      new Set(r.reasons).size !== r.reasons.length ||
      !r.reasons.includes('missing_dated_nav')
    )
      return false;
    if (
      ![r.deltaAmountWan, r.price, r.priceDate, r.priceKind, r.priceSource, r.priceEvidence].every(
        (v) => v === null
      )
    )
      return false;
    if (r.shares !== null && !integer(r.shares)) return false;
    if (r.creationShares === null) {
      if (r.creationSharesKind !== null) return false;
    } else if (
      !Number.isSafeInteger(r.creationShares) ||
      !['exact', 'estimate'].includes(r.creationSharesKind) ||
      (r.creationSharesKind === 'exact' && r.creationShares < 0) ||
      (r.creationSharesKind === 'estimate' &&
        (r.deltaShares === null || r.creationShares !== r.deltaShares)) ||
      (r.creationSharesKind === 'exact' && r.creationShares !== 0 && r.creationShares !== r.deltaShares)
    )
      return false;
    // 513（沪市）暂无上一期份额来源：prevShares/deltaShares 必须为 null；
    // shares 允许为已验证的整数（沪市份额源已于 2026-10-19 接入），由上方的
    // integer(r.shares) 统一校验。
    if (
      r.code.startsWith('513') &&
      (r.prevShares !== null ||
        r.deltaShares !== null)
    )
      return false;

    if (r.prevShares === null) {
      if (r.prevDate !== null || r.deltaShares !== null) return false;
    } else if (
      !integer(r.prevShares) ||
      r.shares === null ||
      !previous ||
      r.prevDate !== previous ||
      !Number.isSafeInteger(r.deltaShares) ||
      r.deltaShares !== r.shares - r.prevShares
    )
      return false;
    if (
      !['limited', 'unlimited', 'unknown'].includes(r.totalLimitKind) ||
      (r.totalLimitKind === 'limited' ? !integer(r.totalLimitShares) : r.totalLimitShares !== null) ||
      (r.limitDate !== null && !dateOK(r.limitDate)) ||
      (r.totalLimitKind !== 'unknown' && r.limitDate === null) ||
      (r.creationUnitShares !== null && !integer(r.creationUnitShares))
    )
      return false;
    const usable =
      r.deltaShares !== null &&
      r.effLimitKind === 'limited' &&
      r.effLimitShares > 0 &&
      r.limitDate !== null;
    if (
      r.utilization !== (usable ? r.deltaShares / r.effLimitShares : null) ||
      r.atLimit !== (usable ? r.deltaShares === r.effLimitShares : null) ||
      r.nearTotalLimit !== (usable ? r.deltaShares >= 0 && r.utilization >= 0.9 : null)
    )
      return false;
    if (r.status !== (r.shares !== null && r.deltaShares !== null ? 'complete' : 'partial')) return false;
    if (r.totalLimitKind === 'unknown' && !r.reasons.includes('missing_total_limit')) return false;
    if (r.shares === null && !r.reasons.includes('missing_shares')) return false;
    if (
      r.deltaShares === null &&
      !r.reasons.includes(previous ? 'missing_previous_shares' : 'unconfirmed_previous_session')
    )
      return false;
  }
  return x.status === (x.records.every((r) => r.status === 'complete') ? 'complete' : 'partial');
}
export function validSharesPointer(p, now = new Date()) {
  return (
    !!p &&
    p.schemaVersion === 1 &&
    p.source === SOURCE &&
    dateOK(p.date) &&
    p.date <= shanghaiDateKey(now) &&
    p.key === sharesKey(p.date) &&
    iso(p.fetchedAt) &&
    iso(p.expiresAt) &&
    Date.parse(p.fetchedAt) <= +now &&
    p.date <= shanghaiDateKey(new Date(p.fetchedAt)) &&
    Date.parse(p.expiresAt) === Date.parse(p.fetchedAt) + TTL &&
    +now < Date.parse(p.expiresAt)
  );
}
