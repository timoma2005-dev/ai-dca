import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShareRows, composeDailyReport, composeWeeklyReport, SHARE_REPORT_CRONS } from '../workers/notify/src/dailyShareReport.js';

function item(code, price, prev, nav, chg) {
  return { code, price, previousClose: prev, navBase: nav, changePercent: chg, ok: true };
}

const ITEMS = [
  item('513100', 2.20, 2.25, 2.00, -2.2), item('513110', 2.18, 2.19, 2.00, -0.5), item('513300', 2.30, 2.30, 2.00, 0),
  item('161130', 4.60, 4.62, 4.45, -0.4), item('513500', 2.65, 2.66, 2.45, -0.4)
];

test('crons are distinct and new', () => {
  assert.deepEqual(Object.values(SHARE_REPORT_CRONS), ['5 1 * * MON-FRI', '35 7 * * MON-FRI', '0 2 * * SAT']);
});

test('rows group nasdaq / lof / sp500 and compute premium', () => {
  const rows = buildShareRows(ITEMS);
  const r = rows.find((x) => x.code === '513110');
  assert.equal(r.group, 'nasdaq');
  assert.equal(r.premiumPct, 9);
  assert.equal(rows.find((x) => x.code === '161130').group, 'lof');
  assert.equal(rows.find((x) => x.code === '513500').group, 'sp500');
  assert.equal(rows.find((x) => x.code === '159941').premiumPct, null);
});

test('pre-open report lists halts and open funds by previous-close premium', () => {
  const rep = composeDailyReport('pre', buildShareRows(ITEMS), '2026-10-31');
  assert.match(rep.title, /10月31日 开盘前/);
  assert.match(rep.text, /预计 9:30 停牌至 10:30：2 只/);
  assert.match(rep.text, /9:30 正常开盘：华泰柏瑞/);
  assert.match(rep.url, /utm_campaign=daily_pre_20261031/);
});

test('post-close overnight pick: lowest ETF unless all above halt line', () => {
  const rep = composeDailyReport('post', buildShareRows(ITEMS), '2026-10-30');
  assert.match(rep.text, /隔夜参考：华泰柏瑞 513110/);
  const high = ITEMS.map((x) => (x.code === '513110' ? item('513110', 2.30, 2.30, 2.0, 0) : x.code === '513100' ? item('513100', 2.25, 2.25, 2.0, 0) : x));
  const rep2 = composeDailyReport('post', buildShareRows(high), '2026-10-30');
  assert.match(rep2.text, /隔夜参考：易方达LOF 161130/);
});

test('weekly report summarises stored post snapshots', () => {
  const rows = buildShareRows(ITEMS);
  const d1 = { ...composeDailyReport('post', rows, '2026-10-26'), rows };
  const d2 = { ...composeDailyReport('post', rows, '2026-10-27'), rows };
  const rep = composeWeeklyReport([d1, d2], '2026-10-31');
  assert.match(rep.text, /10月26日：溢价中位/);
  assert.match(rep.text, /最常出现的最低溢价：华泰柏瑞（2 天）/);
});
