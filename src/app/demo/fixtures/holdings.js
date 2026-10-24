// 持仓总览（holdings）演示 mock：纳指 QDII ETF 三只 + 场外联接一只，含买卖与三次换基配对（SELL.switchPairId → BUY.id）。
// 持仓页演示期间读取的数据：
//   游客（无会话 → 本地模式）：只读本地存储 —— 下方 seed 的账本 / 资金配置 / 成本流水等；
//     另有今日信号 GET /api/notify/switch/snapshot、每日推送入口 GET /api/notify/holdings-rule + /api/notify/status（带占位令牌）。
//   已登录无权限（真实令牌 → 远端模式，holdingsRemoteSource / 全局自动 pull）：
//     GET /api/account/v1/migrations/legacy                    迁移门禁（结构同 account worker normalizeMigrationState）
//     GET /api/account/v1/holdings/ledger/items[?cursor&limit]  交易行（结构同 handleHoldingTransactionCollection：{ rows, nextCursor }）
//     GET /api/account/v1/holdings/ledger/items/:id             单行（推送确认用，演示中不会推送）
//     GET /api/account/v1/holdings/allocation                   账户资金配置（resourceResponse：{ revision, data }）
//     GET /api/account/v1/trades/ledger                         成本流水（空）
//     以及上面三条 notify GET。
// 隔离：seed 覆盖持仓相关全部本地 key（含同步基线、按 userId 的 pending journal、卖出计划等，值为 null 表示演示中视为不存在），
// 真实存储与账号 runtime 不被改动；演示中不推送（holdingTransactionsSync / mutations 在演示中短路），写入仍被演示框架 403。
// 保留：演示中新增的交易（keepKeys 账本）只带入「自洽」的部分 —— 去掉示例交易、超出自身买入份额的卖出、指向示例交易的换基配对，
// 带入时按 id 并入账号现有账本（不覆盖、不删除已有交易），再由正常的交易行同步推送。
import { normalizeAccountAllocationSettings } from '../../accountManager.js';
import { normalizeTransaction } from '../../holdingsLedgerBasics.js';
import { RADAR_DEMO_ETFS } from './adminRadar.js';
import { SWITCH_CONFIG_CACHE_KEY, SWITCH_SNAPSHOT_PATH, buildSwitchDemoConfig, buildSwitchDemoSnapshot } from './fundSwitch.js';
import {
  NOTIFY_HOLDINGS_RULE_PATH, NOTIFY_STATUS_PATH, buildNotifyDemoEvents, buildNotifyDemoHoldingsRule, buildNotifyDemoStatusDetails, buildNotifyDemoStatusSummary,
} from './notify.js';

export const HOLDINGS_LEDGER_KEY = 'aiDcaFundHoldingsLedger';
export const HOLDINGS_ALLOCATION_KEY = 'aiDcaAccountAllocationSettings';
export const HOLDINGS_TRADE_LEDGER_KEY = 'aiDcaTradeLedger';
export const HOLDINGS_SYNC_STATE_KEY = 'aiDcaHoldingTransactionSyncState';
export const HOLDINGS_JOURNAL_PREFIX = 'aiDcaHoldingTxPendingJournal:';
export const ACCOUNT_API_PREFIX = '/api/account/v1';
export const HOLDINGS_ITEMS_PATH = `${ACCOUNT_API_PREFIX}/holdings/ledger/items`;
// 演示中视为不存在的本地 key：旧版持仓、卖出计划 / 草稿、行情页带来的交易草稿、已忽略的今日信号、示例数据标记、成本归档。
const HIDDEN_KEYS = [
  'aiDcaFundHoldingsState', 'aiDcaSellPlanStore', 'aiDcaSellPlanDraft', 'aiDcaMarketActionDraft',
  'aiDcaDismissedTodaySignals_v1', 'aiDcaDemoDataMeta', 'aiDcaTradeLedgerArchive',
];

const ETF_NAME = new Map(RADAR_DEMO_ETFS.map((item) => [item.code, item.name]));
const OTC_CODE = '270042';
const OTC_NAME = '广发纳指100ETF联接（QDII）人民币A';

// 价格取自各日真实单位净值 × 当时溢价（场内）或当日净值（场外，联接净值按广发纳指 ETF 净值折算）；份额为整百。
const ROWS = [
  ['513100-b1', 'BUY', '513100', '2026-04-14', 1.842, 20000, '', '建仓'],
  ['270042-b1', 'BUY', OTC_CODE, '2026-05-12', 8.1385, 1228.73, '', '场外定投'],
  ['159941-b1', 'BUY', '159941', '2026-05-12', 1.564, 12000, '', '建仓'],
  ['513100-b2', 'BUY', '513100', '2026-06-16', 2.18, 6300, '', '加仓'],
  ['513110-b1', 'BUY', '513110', '2026-07-08', 2.373, 9300, '', '换基买入（低溢价 4.0%）'],
  ['513100-s1', 'SELL', '513100', '2026-07-08', 2.225, 10000, '513110-b1', '换基：溢价差 8.0% 切出至 513110'],
  ['159941-b2', 'BUY', '159941', '2026-07-29', 1.462, 6000, '', '回调补仓'],
  ['270042-b2', 'BUY', OTC_CODE, '2026-07-29', 7.5347, 1327.19, '', '场外定投'],
  ['513100-b3', 'BUY', '513100', '2026-08-20', 2.074, 10700, '', '换基买回（溢价 5.0%）'],
  ['513110-s1', 'SELL', '513110', '2026-08-20', 2.404, 9300, '513100-b3', '溢价差收窄至 1.0%，切回 513100'],
  ['159941-s1', 'SELL', '159941', '2026-09-10', 1.619, 1200, '', '溢价 10% 止盈'],
  ['270042-b3', 'BUY', OTC_CODE, '2026-09-10', 8.0434, 248.65, '', '场外定投'],
  ['159513-b1', 'BUY', '159513', '2026-09-24', 1.794, 9000, '', '换基买入（低溢价 5.0%）'],
  ['513100-s2', 'SELL', '513100', '2026-09-24', 2.316, 7000, '159513-b1', '换基：溢价差 8.0% 切出至 159513'],
];

const txId = (key) => `demo-hold-${key}`;

export const HOLDINGS_DEMO_TRANSACTIONS = Object.freeze(ROWS.map(([key, type, code, date, price, shares, pair, note]) => Object.freeze(normalizeTransaction({
  id: txId(key),
  code,
  name: code === OTC_CODE ? OTC_NAME : ETF_NAME.get(code),
  kind: code === OTC_CODE ? 'qdii' : 'exchange',
  type,
  date,
  price,
  shares,
  amount: code === OTC_CODE ? Math.round(price * shares) : undefined,
  switchPairId: pair ? txId(pair) : '',
  note,
}))));
const DEMO_IDS = new Set(HOLDINGS_DEMO_TRANSACTIONS.map((tx) => tx.id));

// 2026-10-23（周五）收盘后的行情 / 净值，首屏即可算市值；页面随后照常拉公开行情刷新。
const SNAPSHOT_AT = new Date(Date.UTC(2026, 9, 23, 8, 14)).toISOString(); // 北京时间 16:14
const QUOTES = [
  ['513100', 2.243, 1.9384, 2.262],
  ['159941', 1.668, 1.4499, 1.682],
  ['159513', 1.774, 1.6148, 1.804],
  ['513110', 2.447, 2.2256, 2.484],
];

export function buildHoldingsDemoSnapshots() {
  const snapshots = Object.fromEntries(QUOTES.map(([code, price, nav, previousClose]) => [code, {
    code, name: ETF_NAME.get(code), latestNav: nav, latestNavDate: '2026-10-23', previousNav: previousClose, previousNavDate: '2026-10-22',
    price, currentPrice: price, previousClose, change: Math.round((price - previousClose) * 1000) / 1000,
    changePercent: Math.round(((price - previousClose) / previousClose) * 10000) / 100, quoteDate: '2026-10-23', marketState: 'CLOSED',
    updatedAt: SNAPSHOT_AT, error: '',
  }]));
  snapshots[OTC_CODE] = {
    code: OTC_CODE, name: OTC_NAME, latestNav: 7.9221, latestNavDate: '2026-10-22', previousNav: 8.159, previousNavDate: '2026-10-21',
    updatedAt: SNAPSHOT_AT, error: '',
  };
  return snapshots;
}

export function buildHoldingsDemoLedger({ withTransactions = true } = {}) {
  return {
    transactions: withTransactions ? HOLDINGS_DEMO_TRANSACTIONS.map((tx) => ({ ...tx })) : [],
    snapshotsByCode: buildHoldingsDemoSnapshots(),
    lastNavMeta: { status: 'ok', updatedAt: SNAPSHOT_AT, successCount: 5, failureCount: 0, errors: [] },
    migratedFromLegacy: false,
    legacyMigrationAt: '',
    switchChains: [],
  };
}

/** 现金 4.8 万（货基年化 1.4%）+ 约 11 万持仓 ≈ 目标 70 / 30。 */
export function buildHoldingsDemoAllocation() {
  return normalizeAccountAllocationSettings({
    cashAmount: 48000, cashYieldMode: 'manual', cashYieldRate: 1.4, targetInvestmentPct: 70, rebalanceThresholdPct: 5, notifyEnabled: true,
    updatedAt: '2026-09-24T12:30:00.000Z',
  });
}

function itemRow(tx, index) {
  return { id: tx.id, revision: index + 1, contentHash: `demo-${index + 1}`, updatedAt: `${tx.date}T07:30:00.000Z`, updatedByEndId: 'browser', updatedByEndType: 'PC Web', data: { ...tx } };
}

/** 演示开始前读真实会话：{ loggedIn, userId }（有真实令牌即远端模式）。 */
function readSession(storage) {
  try {
    const session = JSON.parse(storage?.getItem('aiDcaCloudSyncSession') || 'null');
    return { loggedIn: Boolean(session?.accessToken && session?.username), userId: String(session?.userId || '').trim() };
  } catch {
    return { loggedIn: false, userId: '' };
  }
}

function parseLedger(raw) {
  try {
    const parsed = JSON.parse(raw || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 演示中用户新增的交易里可以单独成立的部分：去掉示例交易、超出自身买入的卖出，以及指向未保留交易的换基配对。 */
export function selfContainedDemoTransactions(transactions = []) {
  const added = (Array.isArray(transactions) ? transactions : [])
    .filter((tx) => tx && typeof tx === 'object' && String(tx.id || '').trim() && !DEMO_IDS.has(String(tx.id)))
    .map((tx) => normalizeTransaction(tx));
  const ordered = [...added].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.type === 'BUY' ? -1 : 1) - (b.type === 'BUY' ? -1 : 1));
  const shares = new Map();
  const kept = [];
  for (const tx of ordered) {
    const held = shares.get(tx.code) || 0;
    if (tx.type === 'BUY') shares.set(tx.code, held + tx.shares);
    else if (tx.type === 'SELL' && tx.shares <= held + 1e-6) shares.set(tx.code, held - tx.shares);
    else continue;
    kept.push(tx);
  }
  const keptIds = new Set(kept.map((tx) => tx.id));
  return added.filter((tx) => keptIds.has(tx.id)).map((tx) => (tx.switchPairId && !keptIds.has(tx.switchPairId) ? { ...tx, switchPairId: '' } : tx));
}

function pruneLedgerEntries(entries) {
  return (entries || []).flatMap(([key, value]) => {
    if (key !== HOLDINGS_LEDGER_KEY) return [];
    const transactions = selfContainedDemoTransactions(parseLedger(value)?.transactions);
    return transactions.length ? [[key, JSON.stringify({ transactions })]] : [];
  });
}

export default {
  keepKeys: [HOLDINGS_LEDGER_KEY],
  seed() {
    const { loggedIn, userId } = readSession(globalThis.window?.localStorage);
    // 已登录：账本由 mock 交易行 hydrate（同步基线为空 → 全部按云端已确认行合并，不产生待推送）；游客：账本直接是示例交易。
    return [
      [HOLDINGS_LEDGER_KEY, JSON.stringify(buildHoldingsDemoLedger({ withTransactions: !loggedIn }))],
      [HOLDINGS_ALLOCATION_KEY, JSON.stringify(buildHoldingsDemoAllocation())],
      [HOLDINGS_TRADE_LEDGER_KEY, '[]'],
      ['aiDcaHoldingAlerts', '[]'],
      [HOLDINGS_SYNC_STATE_KEY, loggedIn ? JSON.stringify({ rows: {}, knownIds: [] }) : null],
      ...(userId ? [[`${HOLDINGS_JOURNAL_PREFIX}${userId}`, null]] : []),
      [SWITCH_CONFIG_CACHE_KEY, JSON.stringify(buildSwitchDemoConfig())],
      ...HIDDEN_KEYS.map((key) => [key, null]),
    ];
  },
  createFixtures() {
    const startedAt = Date.now();
    const events = buildNotifyDemoEvents(startedAt);
    const rows = HOLDINGS_DEMO_TRANSACTIONS.map(itemRow);
    return {
      routes: {
        [`GET ${ACCOUNT_API_PREFIX}/migrations/legacy`]: () => ({ status: 'no-legacy', legacy: { exists: false }, needsMigration: false }),
        [`GET ${HOLDINGS_ITEMS_PATH}`]: () => ({
          resource: 'holdings/ledger', feature: 'holdings', merge: 'holdingsTransactions', revision: rows.length, itemCount: rows.length,
          rows: rows.map((row) => ({ ...row, data: { ...row.data } })), nextCursor: '',
        }),
        [`GET ${HOLDINGS_ITEMS_PATH}/*`]: ({ url }) => {
          const id = decodeURIComponent(url.pathname.slice(HOLDINGS_ITEMS_PATH.length + 1));
          const row = rows.find((item) => item.id === id);
          return row
            ? { resource: 'holdings/ledger', id, revision: row.revision, data: { ...row.data } }
            : new Response(JSON.stringify({ error: 'ITEM_NOT_FOUND', message: '交易行不存在' }), { status: 404, headers: { 'content-type': 'application/json' } });
        },
        [`GET ${ACCOUNT_API_PREFIX}/holdings/allocation`]: () => ({ resource: 'holdings/allocation', feature: 'holdings', revision: 3, data: buildHoldingsDemoAllocation() }),
        [`GET ${ACCOUNT_API_PREFIX}/trades/ledger`]: () => ({ resource: 'trades/ledger', feature: 'trades', revision: 0, data: [] }),
        [`GET ${SWITCH_SNAPSHOT_PATH}`]: () => ({ ok: true, snapshot: buildSwitchDemoSnapshot(), config: buildSwitchDemoConfig() }),
        [`GET ${NOTIFY_HOLDINGS_RULE_PATH}`]: () => buildNotifyDemoHoldingsRule(startedAt),
        [`GET ${NOTIFY_STATUS_PATH}`]: ({ url }) => (url.searchParams.get('view') === 'details'
          ? buildNotifyDemoStatusDetails(events)
          : buildNotifyDemoStatusSummary(events, startedAt)),
      },
    };
  },
  /** 演示结束时：只保留自洽的新增交易（没有新增就不保留，不会弹「已保留演示内容」）。 */
  pruneKept(entries) {
    return pruneLedgerEntries(entries);
  },
  /** 带入账号：按 id 并入账号现有账本（不覆盖、不删除已有交易；同 id 已存在则跳过）。 */
  prepareImport(entries, { storage } = {}) {
    return pruneLedgerEntries(entries).flatMap(([key, value]) => {
      const current = parseLedger(storage?.getItem(key)) || {};
      const existing = Array.isArray(current.transactions) ? current.transactions : [];
      const ids = new Set(existing.map((tx) => String(tx?.id || '')));
      const additions = JSON.parse(value).transactions.filter((tx) => !ids.has(tx.id));
      return additions.length ? [[key, JSON.stringify({ ...current, transactions: [...existing, ...additions] })]] : [];
    });
  },
};
