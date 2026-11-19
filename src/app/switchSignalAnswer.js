// 「持仓跟着提醒走」：方案到线后，用户回答「我换了 / 这次不换」。
//  - 我换了：方案的持仓翻到对面（benchmarkCodes / holdingFundCode），提醒随之改盯换回的方向；
//            可选同时往持仓账本记一卖一买（SELL.switchPairId → BUY.id）。
//  - 这次不换：在规则上记一条 quietSignals { pair, rule, date }，worker 当天不再推这个方向。

const FUND_CODE = /^\d{6}$/;
export const MAX_QUIET_SIGNALS = 12;

export function shanghaiToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/** 持有 L 时盯规则 A（价差收窄，L→H），持有 H 时盯规则 B（价差扩大，H→L）。 */
export function signalRuleForSide(holdingSide = 'H') {
  return holdingSide === 'L' ? 'A' : 'B';
}

function code(value) {
  const text = String(value || '').trim();
  return FUND_CODE.test(text) ? text : '';
}

export function normalizeQuietSignals(list = [], today = '') {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const rule = String(item?.rule || '').trim().toUpperCase();
    const date = String(item?.date || '').trim();
    const pair = String(item?.pair || '*').trim();
    if (rule !== 'A' && rule !== 'B') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (today && date < today) continue;
    if (pair !== '*' && !/^\d{6}:\d{6}$/.test(pair)) continue;
    const key = `${pair}|${rule}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pair, rule, date });
    if (out.length >= MAX_QUIET_SIGNALS) break;
  }
  return out;
}

export function normalizeLastSwitch(input = null) {
  if (!input || typeof input !== 'object') return null;
  const fromCode = code(input.fromCode);
  const toCode = code(input.toCode);
  const at = String(input.at || '').trim().slice(0, 40);
  if (!fromCode || !toCode || !at) return null;
  return {
    fromCode,
    toCode,
    at,
    rule: ['A', 'B'].includes(String(input.rule || '')) ? String(input.rule) : '',
    sellTxId: String(input.sellTxId || '').trim().slice(0, 80),
    buyTxId: String(input.buyTxId || '').trim().slice(0, 80)
  };
}

export function isRuleQuietToday(rule = {}, signalRule = '', today = shanghaiToday()) {
  return normalizeQuietSignals(rule.quietSignals, today)
    .some((item) => item.date === today && item.rule === signalRule);
}

export function switchedToday(rule = {}, today = shanghaiToday()) {
  const last = normalizeLastSwitch(rule.lastSwitch);
  return Boolean(last && shanghaiToday(Date.parse(last.at)) === today);
}

/**
 * 方案卡上要不要出「到线了」黄条：
 *  - 当前读数已过线（gauge.triggered），或今天已经推过（hitCount>0），或用户正是从这条提醒点进来；
 *  - 且今天没点过「这次不换」，今天也没刚换过（换过以后方向已经翻了）。
 */
export function resolveSignalPrompt(row = {}, { today = shanghaiToday(), entry = null } = {}) {
  const rule = row.rule || {};
  const holdingSide = row.holdingSide === 'L' ? 'L' : 'H';
  const signalRule = signalRuleForSide(holdingSide);
  const fromEntry = Boolean(entry && matchEntryToRow(entry, row));
  const live = Boolean(row.gauge?.triggered);
  const hit = Number(row.hitCount) > 0;
  if (!row.enabled && !fromEntry) return null;
  if (!live && !hit && !fromEntry) return null;
  if (isRuleQuietToday(rule, signalRule, today)) return null;
  if (switchedToday(rule, today) && !live) return null;
  const pair = pickSwitchPair(row, entry);
  if (!pair.fromCode || !pair.toCode) return null;
  return { ...pair, signalRule, live, hit, fromEntry };
}

/** 当前要换的那一对：从持仓（benchmark）换到对面。提醒落地时以提醒里的代码为准。 */
export function pickSwitchPair(row = {}, entry = null) {
  const rule = row.rule || {};
  const holdingSide = row.holdingSide === 'L' ? 'L' : 'H';
  const sameSide = holdingSide === 'L' ? (row.lowCodes || []) : (row.highCodes || []);
  const otherSide = holdingSide === 'L' ? (row.highCodes || []) : (row.lowCodes || []);
  const entryFrom = code(entry?.notificationCode);
  const entryTo = code(entry?.notificationTargetCode);
  const fromCode = (entryFrom && sameSide.includes(entryFrom) && entryFrom)
    || (code(rule.holdingFundCode) && sameSide.includes(rule.holdingFundCode) && rule.holdingFundCode)
    || (holdingSide === 'L' ? row.lowCode : row.highCode)
    || sameSide[0] || '';
  const toCode = (entryTo && otherSide.includes(entryTo) && entryTo)
    || (holdingSide === 'L' ? row.highCode : row.lowCode)
    || otherSide[0] || '';
  const quotes = [...(row.highQuotes || []), ...(row.lowQuotes || []), row.high, row.low].filter(Boolean);
  const quoteOf = (c) => quotes.find((q) => q?.code === c) || null;
  return {
    fromCode,
    toCode,
    fromName: quoteOf(fromCode)?.name || '',
    toName: quoteOf(toCode)?.name || '',
    fromPrice: finite(quoteOf(fromCode)?.price),
    toPrice: finite(quoteOf(toCode)?.price)
  };
}

export function matchEntryToRow(entry = {}, row = {}) {
  const from = code(entry?.notificationCode);
  const to = code(entry?.notificationTargetCode);
  if (!from || !to) return false;
  const rule = row.rule || {};
  const bench = Array.isArray(rule.benchmarkCodes) ? rule.benchmarkCodes : [];
  const all = [...bench, ...(Array.isArray(rule.enabledCodes) ? rule.enabledCodes : [])];
  return bench.includes(from) && all.includes(to);
}

/** 提醒落地：挑出这条提醒对应的方案（持仓 = 提醒里的卖出方）。 */
export function findRowForEntry(rows = [], entry = null) {
  if (!entry?.fromNotification) return null;
  return (Array.isArray(rows) ? rows : []).find((row) => matchEntryToRow(entry, row)) || null;
}

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 「我换了」后新的规则：持仓翻到对面一侧，记下这次换基。 */
export function buildFlippedRule(rule = {}, { fromCode, toCode, signalRule = '', at = new Date().toISOString(), toName = '', buyShares = null, sellTxId = '', buyTxId = '' } = {}) {
  const premiumClass = rule.premiumClass && typeof rule.premiumClass === 'object' ? rule.premiumClass : {};
  const toClass = premiumClass[toCode];
  const allCodes = Array.from(new Set([...(rule.benchmarkCodes || []), ...(rule.enabledCodes || [])]));
  const benchmarkCodes = allCodes.filter((c) => premiumClass[c] === toClass);
  const enabledCodes = allCodes.filter((c) => !benchmarkCodes.includes(c));
  const quantity = finite(buyShares);
  return {
    ...rule,
    benchmarkCodes,
    enabledCodes,
    candidateFundCodes: enabledCodes,
    holdingFundCode: toCode,
    holdingFundName: String(toName || '').trim(),
    holdingQuantity: quantity && quantity > 0 ? quantity : null,
    holdingNotional: null,
    quietSignals: [],
    lastSwitch: normalizeLastSwitch({ fromCode, toCode, at, rule: signalRule, sellTxId, buyTxId })
  };
}

export function buildQuietRule(rule = {}, { signalRule, today = shanghaiToday(), pair = '*' } = {}) {
  const kept = normalizeQuietSignals(rule.quietSignals, today);
  return { ...rule, quietSignals: normalizeQuietSignals([...kept, { pair, rule: signalRule, date: today }], today) };
}

export function removeQuietToday(rule = {}, { signalRule, today = shanghaiToday() } = {}) {
  return {
    ...rule,
    quietSignals: normalizeQuietSignals(rule.quietSignals, today)
      .filter((item) => !(item.date === today && item.rule === signalRule))
  };
}

// ---- 持仓账本 ----

export function availableShares(transactions = [], fundCode = '') {
  let total = 0;
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    if (String(tx?.code || '') !== fundCode) continue;
    const shares = Number(tx?.shares) || 0;
    if (tx?.type === 'BUY') total += shares;
    else if (tx?.type === 'SELL') total -= shares;
  }
  return Math.max(0, Math.round(total * 10000) / 10000);
}

/** 按卖出金额估算买入份数，场内 ETF 按 100 份一手向下取整。 */
export function estimateBuyShares({ sellPrice, sellShares, buyPrice } = {}) {
  const sp = finite(sellPrice); const ss = finite(sellShares); const bp = finite(buyPrice);
  if (!sp || !ss || !bp || sp <= 0 || ss <= 0 || bp <= 0) return null;
  const lots = Math.floor((sp * ss) / bp / 100);
  return lots > 0 ? lots * 100 : null;
}

export function buildSwitchLedgerDrafts({ fromCode, fromName = '', toCode, toName = '', sellPrice, sellShares, buyPrice, buyShares, date, makeId }) {
  const sellId = makeId('tx');
  const buyId = makeId('tx');
  const note = '换基提醒·我换了';
  return [
    { id: sellId, code: fromCode, name: fromName, kind: 'exchange', type: 'SELL', date, price: sellPrice, shares: sellShares, amount: '', switchPairId: buyId, note, tags: ['exchange'] },
    { id: buyId, code: toCode, name: toName, kind: 'exchange', type: 'BUY', date, price: buyPrice, shares: buyShares, amount: '', switchPairId: sellId, note, tags: ['exchange'] }
  ];
}
