// 从本机 tzzb-mcp（同花顺投资账本）读取股票/场内基金持仓，并与本站持仓对账生成调整流水。
// 只读：只调用 tzzb_account_list / tzzb_positions，不调用任何交易类工具。
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

export async function fetchTzzbHoldings(url, { selectedKeys = null, fetchImpl } = {}) {
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
  // tzzb-mcp 底层共用一个 Chrome CDP 连接，必须串行调用。
  for (const acc of targets) {
    const payload = await client.callTool('tzzb_positions', acc.args);
    perAccount.push({ ...acc, positions: parseTzzbPositions(payload) });
  }
  return {
    url: client.url,
    accounts,
    perAccount,
    positions: mergePositionsByCode(perAccount.map((acc) => acc.positions))
  };
}

// 对账：本站场内持仓份额 vs 账本持仓份额 → 买入/卖出调整行。
// aggregates 来自 aggregateByCode；只对场内（exchange）或账本里出现的代码生成调整，场外基金不动。
export function buildMcpSyncPlan({ positions = [], aggregates = [], date = '', clearMissing = true } = {}) {
  const ledgerByCode = new Map();
  for (const agg of aggregates || []) {
    if (agg && agg.code) ledgerByCode.set(agg.code, agg);
  }
  const rows = [];
  const brokerCodes = new Set();
  for (const pos of positions) {
    brokerCodes.add(pos.code);
    const agg = ledgerByCode.get(pos.code);
    const ledgerShares = round(Number(agg?.totalShares) || 0, 4);
    const delta = round(pos.shares - ledgerShares, 4);
    rows.push({
      code: pos.code,
      name: pos.name || agg?.name || '',
      ledgerShares,
      brokerShares: pos.shares,
      delta,
      price: pos.price > 0 ? pos.price : round(Number(agg?.latestNav) || 0, 4),
      type: delta > 0 ? 'BUY' : delta < 0 ? 'SELL' : '',
      selected: delta !== 0
    });
  }
  for (const agg of aggregates || []) {
    if (!agg?.code || brokerCodes.has(agg.code)) continue;
    if (agg.kind !== 'exchange') continue;
    const ledgerShares = round(Number(agg.totalShares) || 0, 4);
    if (!(ledgerShares > 0)) continue;
    rows.push({
      code: agg.code,
      name: agg.name || '',
      ledgerShares,
      brokerShares: 0,
      delta: -ledgerShares,
      price: round(Number(agg.latestNav) || 0, 4),
      type: 'SELL',
      selected: Boolean(clearMissing),
      missingInBroker: true
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
