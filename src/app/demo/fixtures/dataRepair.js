// 数据修复（dataRepair）演示 mock：同一份持仓演示账本（纳指 QDII ETF + 场外联接，见 ./holdings.js）混入几类常见脏数据。
// 数据修复页演示期间读取的数据：
//   本地存储（游客与已登录都读）：aiDcaFundHoldingsLedger（健康扫描 + 本地底账清洗）、aiDcaHoldingTransactionSyncState（云端版本基线）。
//   接口：GET DEMO_FUND_DICTIONARY_PATH  演示基金字典（演示中不注入天天基金 fundcode_search.js，场内行情补名也不外发）；
//         已登录无权限（真实令牌）另读 GET /api/account/v1/holdings/ledger/items（云端交易行，含同样的脏数据）。游客无会话，只做本地修复。
// 待修复问题（修复后即「已修复」，结果表逐条列出）：
//   幽灵记录 2 笔 —— 202691（2026-9-1 错位成代码）、260924（9/24 换基买入日期错位）；占位名称 2 笔 —— 159513 买入「QDII基金」、
//   513110 卖出「场内基金」；类别错配 2 笔 —— 270042 联接标成普通场外、159941 场内 ETF 标成 QDII 场外。
// 隔离：修复只在演示覆盖层里改本地底账 / 同步基线，退出演示即丢弃；云端 PUT / DELETE 由演示框架 403（页面提示云端未改动、不更新基线）。
// 不保留、不带入（无 keepKeys / getState）：修复对象是示例账本，修复结果带入账号会把示例交易混进真实持仓；真实账本请开通后在本页修复。
import { DEMO_FUND_DICTIONARY_PATH } from '../../dataRepairSources.js';
import { RADAR_DEMO_ETFS } from './adminRadar.js';
import {
  HOLDINGS_DEMO_TRANSACTIONS, HOLDINGS_ITEMS_PATH, HOLDINGS_JOURNAL_PREFIX, HOLDINGS_LEDGER_KEY, HOLDINGS_SYNC_STATE_KEY, buildHoldingsDemoLedger,
} from './holdings.js';

const FIXES = {
  'demo-hold-159513-b1': { name: 'QDII基金', note: '截图导入未识别名称' },
  'demo-hold-513110-s1': { name: '场内基金', note: '券商对账单导入' },
  'demo-hold-270042-b3': { kind: 'otc', tags: ['otc'] },
  'demo-hold-159941-s1': { kind: 'qdii', tags: ['qdii', 'otc'] },
};
const GHOSTS = [
  { id: 'demo-repair-ghost-202691', code: '202691', name: '买入', kind: 'otc', tags: ['otc'], type: 'BUY', date: '', price: 1, shares: 100, amount: 100, note: '日期 2026-9-1 错位成代码' },
  { id: 'demo-repair-ghost-260924', code: '260924', name: '场内基金', kind: 'otc', tags: ['otc'], type: 'BUY', date: '', price: 1.794, shares: 9000, amount: 16146, note: '换基买入日期错位' },
];

/** 演示账本交易：持仓演示 14 笔（其中 4 笔带问题）+ 2 笔幽灵记录。 */
export function buildDataRepairDemoTransactions() {
  const rows = HOLDINGS_DEMO_TRANSACTIONS.map((tx) => ({ ...tx, ...(FIXES[tx.id] || {}) }));
  rows.splice(rows.findIndex((tx) => tx.id === 'demo-hold-159513-b1') + 1, 0, ...GHOSTS.map((tx) => ({ ...tx, switchPairId: '' })));
  return rows;
}

export function buildDataRepairDemoLedger() {
  const ledger = buildHoldingsDemoLedger();
  ledger.transactions = buildDataRepairDemoTransactions();
  ledger.snapshotsByCode['202691'] = { code: '202691', name: '买入', latestNav: 0, updatedAt: '', error: '基金代码不存在' };
  return ledger;
}

const OTC_FUNDS = [
  ['270042', '广发纳指100ETF联接（QDII）人民币A'],
  ['000834', '大成纳斯达克100ETF联接(QDII)A'],
  ['040046', '华安纳斯达克100ETF联接(QDII)A'],
  ['161130', '易方达纳斯达克100ETF联接(QDII-LOF)A'],
];

/** 演示基金字典（天天基金 fundcode_search 同格式：[code, 简拼, 名称, 类型, 全拼]），名称与持仓演示一致。 */
export function buildDemoFundDictionary() {
  return [
    ...RADAR_DEMO_ETFS.map(({ code, name }) => [code, '', name, '指数型-海外股票', '']),
    ...OTC_FUNDS.map(([code, name]) => [code, '', name, 'QDII', '']),
  ];
}

function readUserId(storage) {
  try {
    return String(JSON.parse(storage?.getItem('aiDcaCloudSyncSession') || 'null')?.userId || '').trim();
  } catch {
    return '';
  }
}

export default {
  seed() {
    const userId = readUserId(globalThis.window?.localStorage);
    return [
      [HOLDINGS_LEDGER_KEY, JSON.stringify(buildDataRepairDemoLedger())],
      [HOLDINGS_SYNC_STATE_KEY, JSON.stringify({ rows: {}, knownIds: [] })],
      ...(userId ? [[`${HOLDINGS_JOURNAL_PREFIX}${userId}`, null]] : []),
    ];
  },
  createFixtures() {
    const rows = buildDataRepairDemoTransactions().map((tx, index) => ({
      id: tx.id, revision: index + 1, contentHash: `demo-${index + 1}`, updatedAt: `${tx.date || '2026-09-24'}T07:30:00.000Z`,
      updatedByEndId: 'browser', updatedByEndType: 'PC Web', data: tx,
    }));
    return {
      routes: {
        [`GET ${DEMO_FUND_DICTIONARY_PATH}`]: () => ({ items: buildDemoFundDictionary() }),
        [`GET ${HOLDINGS_ITEMS_PATH}`]: () => ({
          resource: 'holdings/ledger', feature: 'holdings', merge: 'holdingsTransactions', revision: rows.length, itemCount: rows.length,
          rows: rows.map((row) => ({ ...row, data: { ...row.data } })), nextCursor: '',
        }),
      },
    };
  },
};
