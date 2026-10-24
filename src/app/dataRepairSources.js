// 数据修复页的外部数据源与云端写入（从 DataRepairExperience 抽出，便于测试与演示隔离）。
// - 官方基金字典：正常走天天基金 fundcode_search.js（window.r）；演示中改为 GET DEMO_FUND_DICTIONARY_PATH（只命中演示 mock，不注入外部脚本）。
// - 场内行情补名：正常走腾讯行情；演示中不外发。
// - 云端写入：演示中被演示框架 403（DEMO_READONLY），调用方据此不更新同步基线、提示「云端未改动」。
import { isFeatureDemoActive } from './demo/demoMode.js';
import { detectFundKind, isGhostTransaction } from './holdingsLedgerBasics.js';

export const DEMO_FUND_DICTIONARY_PATH = '/api/demo/fund-dictionary';
const PLACEHOLDER_NAMES = new Set(['', 'QDII基金', '场内基金', '场外基金', '买入']);

/** 本地底账健康扫描（幽灵记录 / 占位名称 / 缺日期 / 场内场外类别错配）。 */
export function scanLedgerHealth(transactions = []) {
  const txs = Array.isArray(transactions) ? transactions : [];
  const report = { totalTxs: txs.length, ghostCount: 0, placeholderNameCount: 0, missingDateCount: 0, mismatchedKindCount: 0 };
  for (const tx of txs) {
    if (isGhostTransaction(tx)) report.ghostCount += 1;
    if (!tx.date) report.missingDateCount += 1;
    if (PLACEHOLDER_NAMES.has(String(tx.name || '').trim())) report.placeholderNameCount += 1;
    const expectedKind = detectFundKind(tx.code, tx.name);
    if (tx.code && expectedKind && tx.kind !== expectedKind) report.mismatchedKindCount += 1;
  }
  report.healthy = !report.ghostCount && !report.placeholderNameCount && !report.missingDateCount && !report.mismatchedKindCount;
  return report;
}

function toFundMap(items) {
  const fundMap = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item && item[0]) fundMap.set(String(item[0]).padStart(6, '0'), { name: item[2], type: item[3] });
  }
  return fundMap;
}

/** 官方基金字典：{ fundMap, demo }。 */
export async function loadFundDictionary(win = globalThis.window) {
  if (isFeatureDemoActive(win)) {
    const res = await win.fetch(DEMO_FUND_DICTIONARY_PATH);
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!Array.isArray(data?.items)) throw new Error('演示基金字典暂不可用');
    return { fundMap: toFundMap(data.items), demo: true };
  }
  await new Promise((resolve, reject) => {
    if (win.r && Array.isArray(win.r) && win.r.length > 5000) {
      resolve();
      return;
    }
    const s = win.document.createElement('script');
    s.src = 'https://fund.eastmoney.com/js/fundcode_search.js';
    s.charset = 'utf-8';
    s.onload = resolve;
    s.onerror = () => reject(new Error('加载官方字典失败，请检查网络连接'));
    win.document.head.appendChild(s);
  });
  if (!win.r || !Array.isArray(win.r)) throw new Error('官方基金字典解析失败');
  return { fundMap: toFundMap(win.r), demo: false };
}

/** 腾讯行情补场内标的名称，写入 fundMap；演示中不外发，返回 false。 */
export async function fillExchangeNames(codes, fundMap, win = globalThis.window) {
  if (isFeatureDemoActive(win)) return false;
  const qList = codes.map((c) => (c.startsWith('5') || c.startsWith('6') ? `s_sh${c}` : `s_sz${c}`));
  const resp = await win.fetch(`https://qt.gtimg.cn/q=${qList.join(',')}`);
  const text = await resp.text();
  for (const line of text.split(';')) {
    const m = line.match(/v_s_s[hz](\d+)="[^~]*~([^~]+)~/);
    if (m) fundMap.set(m[1], { name: m[2], type: detectFundKind(m[1], m[2]) });
  }
  return true;
}

/** 云端交易行 PUT（data 非空）/ DELETE：{ demoReadonly, json }；演示中被框架 403 时 demoReadonly=true（云端未改动）。 */
export async function writeLedgerRow({ base, token, row, data = null }, win = globalThis.window) {
  const res = await win.fetch(`${base}/holdings/ledger/items/${encodeURIComponent(String(row.id || ''))}`, {
    method: data ? 'PUT' : 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'If-Match': `"${row.revision}"` },
    body: JSON.stringify({ ...(data ? { data } : {}), baseRevision: row.revision, force: false, end: { id: 'browser', type: 'DataRepair' } }),
  });
  const json = await res.json().catch(() => null);
  return { demoReadonly: res.status === 403 && json?.code === 'DEMO_READONLY', json };
}
