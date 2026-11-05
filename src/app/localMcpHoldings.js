// 从本机 tzzb-mcp（同花顺投资账本）读取股票/场内基金持仓，并与本站持仓对账生成调整流水。
// 只读：只调用 tzzb_account_list / tzzb_positions / tzzb_trade_history，不调用任何交易类工具。
import { createLocalMcpClient } from './localMcpClient.js';

const CODE_RE = /^\d{6}$/;

function toNumber(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function round(value, digits = 4) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// tzzb_account_list → [{ key, label, args }]
export function listTzzbAccounts(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const out = [];
  const seen = new Set();
  const push = (key, label, args) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, label, args });
  };
  for (const acc of Array.isArray(data.common) ? data.common : []) {
    const fundKey = String(acc?.fund_key ?? '').trim();
    if (fundKey) push(`common:${fundKey}`, acc.brokername || acc.manualname || `券商账户 ${fundKey}`, { fund_key: fundKey });
  }
  for (const acc of Array.isArray(data.rzrq) ? data.rzrq : []) {
    const key = String(acc?.rzrq_fund_key ?? acc?.fund_key ?? '').trim();
    if (key) push(`rzrq:${key}`, `${acc.brokername || '融资融券'}（两融）`, { rzrq_fund_key: key });
  }
  for (const acc of Array.isArray(data.manual) ? data.manual : []) {
    const manualId = String(acc?.manual_id ?? '').trim();
    if (manualId) push(`manual:${manualId}`, acc.manualname || `手工账户 ${manualId}`, { manual_id: manualId });
  }
  return out;
}

// tzzb_positions → [{ code, name, shares, price }]
export function parseTzzbPositions(payload) {
  const stock = payload && typeof payload === 'object' ? (payload.stock ?? payload) : {};
  const list = Array.isArray(stock?.position) ? stock.position : (Array.isArray(stock?.positions) ? stock.positions : []);
  const rows = [];
  for (const item of list) {
    const code = String(item?.code ?? item?.zqdm ?? '').trim();
    const shares = toNumber(item?.count ?? item?.shares ?? item?.amount);
    if (!CODE_RE.test(code) || !(shares > 0)) continue;
    let price = toNumber(item?.price ?? item?.xianjia);
    const value = toNumber(item?.value);
    if (!(price > 0) && value > 0) price = value / shares;
    rows.push({ code, name: String(item?.name ?? '').trim(), shares, price: round(price, 4) });
  }
  return rows;
}

export function mergePositionsByCode(lists = []) {
  const map = new Map();
  for (const rows of lists) {
    for (const row of rows || []) {
      const prev = map.get(row.code);
      if (!prev) {
        map.set(row.code, { ...row });
      } else {
        prev.shares = round(prev.shares + row.shares, 4);
        if (!(prev.price > 0) && row.price > 0) prev.price = row.price;
        if (!prev.name && row.name) prev.name = row.name;
      }
    }
  }
  return [...map.values()];
}

export async function fetchTzzbHoldings(url, { selectedKeys = null, fetchImpl, history = null } = {}) {
  // 登录可能要用户在弹出的 Chrome 里手动操作，超时放宽到 3 分钟。
  const client = createLocalMcpClient(url, { fetchImpl, timeoutMs: 180000 });
  try {
    const login = await client.callTool('tzzb_login_status', {});
    if (login && typeof login === 'object' && login.logged_in === false) {
      await client.callTool('tzzb_login', {});
    }
  } catch (error) {
    // 连接类错误直接抛出；工具缺失（非 tzzb-mcp 或旧版）继续尝试读账户。
    if (/连不上|超时/.test(String(error?.message || ''))) throw error;
  }
  const accountPayload = await client.callTool('tzzb_account_list', {});
  if (accountPayload && typeof accountPayload === 'object' && accountPayload.error) {
    throw new Error(String(accountPayload.error));
  }
  const accounts = listTzzbAccounts(accountPayload);
  if (!accounts.length) throw new Error('投资账本里没有读到账户，请先在本机完成 tzzb_login 登录。');
  const targets = selectedKeys && selectedKeys.length
    ? accounts.filter((acc) => selectedKeys.includes(acc.key))
    : accounts;
  const perAccount = [];
  let historyError = '';
  // tzzb-mcp 底层共用一个 Chrome CDP 连接，必须串行调用。
  for (const acc of targets) {
    const payload = await client.callTool('tzzb_positions', acc.args);
    const entry = { ...acc, positions: parseTzzbPositions(payload), trades: [] };
    if (history && !historyError) {
      try {
        for (const range of splitDateRange(history.startDate, history.endDate)) {
          const tradePayload = await client.callTool('tzzb_trade_history', { ...acc.args, start_date: range.start, end_date: range.end });
          if (tradePayload && typeof tradePayload === 'object' && !Array.isArray(tradePayload) && tradePayload.error) {
            throw new Error(String(tradePayload.error));
          }
          entry.trades.push(...parseTzzbTradeHistory(tradePayload, acc.key));
        }
      } catch (error) {
        if (/连不上|超时/.test(String(error?.message || ''))) throw error;
        historyError = /not found|unknown tool|未知|不存在/i.test(String(error?.message || ''))
          ? '本机 tzzb-mcp 没有 tzzb_trade_history 工具，请更新到带历史成交的版本。'
          : `读取历史成交失败：${error?.message || '未知错误'}`;
        entry.trades = [];
      }
    }
    perAccount.push(entry);
  }
  const trades = historyError ? [] : perAccount.flatMap((acc) => acc.trades);
  trades.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || String(a.transNo).localeCompare(String(b.transNo)));
  return {
    url: client.url,
    accounts,
    perAccount,
    positions: mergePositionsByCode(perAccount.map((acc) => acc.positions)),
    trades,
    historyError
  };
}

// ---------- 历史成交（tzzb_trade_history）→ 逐笔交易记录 ----------

function isoDate(value) {
  const raw = String(value ?? '').trim();
  const m = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 按自然月切片（每段一次调用，工具内部自动翻页）。
export function splitDateRange(startDate, endDate) {
  const start = isoDate(startDate);
  const end = isoDate(endDate) || start;
  if (!start || !end || start > end) return start ? [{ start, end: start }] : [];
  const out = [];
  let cursor = start;
  while (cursor <= end && out.length < 240) {
    const next = new Date(`${cursor.slice(0, 7)}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const lastOfMonth = addDays(next.toISOString().slice(0, 10), -1);
    const segEnd = lastOfMonth < end ? lastOfMonth : end;
    out.push({ start: cursor, end: segEnd });
    cursor = addDays(segEnd, 1);
  }
  return out;
}

function findRecordArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['records', 'list', 'trades', 'data', 'items', 'result']) {
    const v = payload[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const inner = findRecordArray(v);
      if (inner.length) return inner;
    }
  }
  for (const v of Object.values(payload)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && ('entry_date' in v[0] || 'code' in v[0])) return v;
  }
  return [];
}

// op: 1=买入，2=卖出；其他（分红、转托管等）跳过。
export function parseTzzbTradeHistory(payload, accountKey = '') {
  const out = [];
  for (const item of findRecordArray(payload)) {
    const code = String(item?.code ?? item?.zqdm ?? '').trim();
    if (!CODE_RE.test(code)) continue;
    const op = String(item?.op ?? '').trim();
    const opName = String(item?.op_name ?? '');
    const type = op === '1' || /买入/.test(opName) ? 'BUY' : op === '2' || /卖出/.test(opName) ? 'SELL' : '';
    if (!type) continue;
    const shares = toNumber(item?.entry_count ?? item?.cjsl);
    const price = toNumber(item?.entry_price ?? item?.cjjg);
    const date = isoDate(item?.entry_date);
    if (!(shares > 0) || !date) continue;
    const money = toNumber(item?.entry_money);
    const fee = round(toNumber(item?.commission) + toNumber(item?.transfer_fee) + toNumber(item?.stamp_tax ?? item?.tax), 2);
    out.push({
      accountKey,
      transNo: String(item?.trans_no ?? '').trim(),
      date,
      time: String(item?.entry_time ?? '').trim(),
      code,
      name: String(item?.name ?? '').trim(),
      type,
      price: round(price, 4),
      shares: round(shares, 4),
      money: round(money > 0 ? money : price * shares, 2),
      fee,
      marketCode: String(item?.market_code ?? '').trim()
    });
  }
  return out;
}

function hashKey(value) {
  let h = 0x811c9dc5;
  for (const ch of String(value)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// 每笔成交的稳定 id：同一笔重复导入会命中同一 id。
export function tradeRecordId(trade) {
  // trans_no 是委托号：同一委托分多笔成交时编号相同，必须带上时间 / 份额 / 价格区分。
  const base = `${trade.accountKey}|${trade.transNo}|${trade.date}|${trade.time}|${trade.code}|${trade.type}|${trade.shares}|${trade.price}`;
  return `tzzb-${hashKey(base)}-${trade.transNo || hashKey(`${base}#`)}`;
}

// 与本站已有记录去重：先按 id；再按 日期+代码+方向+份额+价格 匹配（手工 / Excel 录入过的同一笔），每条已有记录只抵消一次。
export function dedupeTrades(trades = [], transactions = []) {
  const ids = new Set();
  const loose = new Map();
  for (const tx of transactions || []) {
    if (tx?.id) ids.add(String(tx.id));
    if (Array.isArray(tx?.tags) && tx.tags.includes('mcp-sync') && !tx.tags.includes('mcp-trade')) continue;
    const key = `${tx?.date}|${tx?.code}|${tx?.type}|${round(Number(tx?.shares) || 0, 2)}`;
    const list = loose.get(key) || [];
    list.push(Number(tx?.price) || 0);
    loose.set(key, list);
  }
  const fresh = [];
  let duplicate = 0;
  for (const trade of trades) {
    const id = tradeRecordId(trade);
    if (ids.has(id)) { duplicate += 1; continue; }
    const key = `${trade.date}|${trade.code}|${trade.type}|${round(trade.shares, 2)}`;
    const list = loose.get(key);
    const idx = list ? list.findIndex((p) => !(p > 0) || Math.abs(p - trade.price) <= 0.0015) : -1;
    if (idx >= 0) { list.splice(idx, 1); duplicate += 1; continue; }
    ids.add(id);
    fresh.push({ ...trade, id, selected: true });
  }
  return { trades: fresh, duplicate };
}

// 旧版「汇总调整」流水（tag mcp-sync 且非 mcp-trade）：逐笔成交覆盖的区间内与成交重复，导入时删除。
export function findStaleAdjustments(transactions = [], startDate = '', endDate = '') {
  return (transactions || []).filter((tx) => {
    const tags = Array.isArray(tx?.tags) ? tx.tags : [];
    if (!tags.includes('mcp-sync') || tags.includes('mcp-trade')) return false;
    const d = String(tx?.date || '');
    return d && (!startDate || d >= startDate) && (!endDate || d <= endDate);
  });
}

export function dayBefore(iso) {
  return isoDate(iso) ? addDays(isoDate(iso), -1) : '';
}

// 待写入成交对每只代码的份额净变化（用于计算写入后剩余差额）。
export function netSharesByCode(trades = []) {
  const map = new Map();
  for (const t of trades) {
    if (t.selected === false) continue;
    map.set(t.code, round((map.get(t.code) || 0) + (t.type === 'BUY' ? t.shares : -t.shares), 4));
  }
  return map;
}

export function tradesToDrafts(trades = []) {
  return trades
    .filter((t) => t.selected !== false)
    .map((t) => {
      const parts = ['同花顺投资账本成交'];
      if (t.time) parts.push(t.time);
      if (t.transNo) parts.push(`编号 ${t.transNo}`);
      if (t.fee > 0) parts.push(`费用 ${t.fee}`);
      const exchange = t.marketCode === '1' || t.marketCode === '2';
      return {
        id: t.id,
        code: t.code,
        name: t.name,
        ...(exchange ? { kind: 'exchange' } : {}),
        type: t.type,
        date: t.date,
        price: String(t.price),
        shares: String(t.shares),
        amount: String(t.type === 'BUY' ? round(t.money + t.fee, 2) : round(Math.max(t.money - t.fee, 0), 2)),
        note: parts.join(' · '),
        tags: [exchange ? 'exchange' : 'otc', 'mcp-sync', 'mcp-trade']
      };
    });
}

// 对账：本站场内持仓份额 vs 账本持仓份额 → 买入/卖出调整行。
// aggregates 来自 aggregateByCode；只对场内（exchange）或账本里出现的代码生成调整，场外基金不动。
export function buildMcpSyncPlan({ positions = [], aggregates = [], date = '', clearMissing = true, pendingTrades = [], removedTransactions = [] } = {}) {
  const ledgerByCode = new Map();
  for (const agg of aggregates || []) {
    if (agg && agg.code) ledgerByCode.set(agg.code, agg);
  }
  const pending = netSharesByCode(pendingTrades);
  for (const tx of removedTransactions || []) {
    const sh = Number(tx?.shares) || 0;
    const sign = tx?.type === 'BUY' ? -1 : tx?.type === 'SELL' ? 1 : 0;
    if (sign && tx?.code) pending.set(tx.code, round((pending.get(tx.code) || 0) + sign * sh, 4));
  }
  const firstTradePrice = new Map();
  for (const t of pendingTrades) if (t.selected !== false && t.price > 0 && !firstTradePrice.has(t.code)) firstTradePrice.set(t.code, t.price);
  const pendingNames = new Map(pendingTrades.map((t) => [t.code, t.name]));
  const ledgerSharesOf = (code, agg) => round((Number(agg?.totalShares) || 0) + (pending.get(code) || 0), 4);
  const rows = [];
  const brokerCodes = new Set();
  for (const pos of positions) {
    brokerCodes.add(pos.code);
    const agg = ledgerByCode.get(pos.code);
    const ledgerShares = ledgerSharesOf(pos.code, agg);
    const delta = round(pos.shares - ledgerShares, 4);
    rows.push({
      code: pos.code,
      name: pos.name || agg?.name || '',
      ledgerShares,
      brokerShares: pos.shares,
      delta,
      price: firstTradePrice.get(pos.code) || (pos.price > 0 ? pos.price : round(Number(agg?.latestNav) || 0, 4)),
      type: delta > 0 ? 'BUY' : delta < 0 ? 'SELL' : '',
      selected: delta !== 0
    });
  }
  const residualSources = [...(aggregates || [])];
  for (const [code] of pending) {
    if (!ledgerByCode.has(code)) residualSources.push({ code, name: pendingNames.get(code) || '', kind: 'exchange', totalShares: 0, latestNav: 0 });
  }
  for (const agg of residualSources) {
    if (!agg?.code || brokerCodes.has(agg.code)) continue;
    if (agg.kind !== 'exchange') continue;
    const ledgerShares = ledgerSharesOf(agg.code, agg);
    if (ledgerShares === 0) continue;
    // 账本已无此持仓：本站为正 → 清仓（可选）；本站为负（起始日前的持仓没录）→ 补期初买入。
    const missing = ledgerShares > 0;
    rows.push({
      code: agg.code,
      name: agg.name || pendingNames.get(agg.code) || '',
      ledgerShares,
      brokerShares: 0,
      delta: -ledgerShares,
      price: firstTradePrice.get(agg.code) || round(Number(agg.latestNav) || 0, 4),
      type: missing ? 'SELL' : 'BUY',
      selected: missing ? Boolean(clearMissing) : true,
      missingInBroker: missing
    });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.code.localeCompare(b.code));
  return { date, rows, changeCount: rows.filter((row) => row.type).length };
}

export function planRowsToDrafts(rows = [], date = '') {
  return rows
    .filter((row) => row.selected && row.type && Math.abs(row.delta) > 0)
    .map((row) => ({
      code: row.code,
      name: row.name,
      kind: 'exchange',
      type: row.type,
      date,
      price: row.price > 0 ? String(row.price) : '',
      shares: String(Math.abs(row.delta)),
      note: '本地 MCP 同步（同花顺投资账本）',
      tags: ['exchange', 'mcp-sync']
    }));
}
