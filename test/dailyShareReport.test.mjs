import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShareRowsFromEastmoney, composeDailyReport, composeWeeklyReport, SHARE_REPORT_CRONS } from '../workers/notify/src/dailyShareReport.js';

const RAW = {
  513100: { FCODE: '513100', PDATE: '2026-10-28', NAV: '1.9943', NEWPRICE: '2.239', CHANGERATIO: '-2.23', ZJL: '-13.89' },
  513110: { FCODE: '513110', PDATE: '2026-10-28', NAV: '2.2895', NEWPRICE: '2.455', CHANGERATIO: '-2.89', ZJL: '-8.75' },
  513300: { FCODE: '513300', PDATE: '2026-10-29', NAV: '2.4365', NEWPRICE: '2.674', CHANGERATIO: '-2.59', ZJL: '-9.74' },
  159513: { FCODE: '159513', PDATE: '2026-10-28', NAV: '1.6612', NEWPRICE: '1.781', CHANGERATIO: '-2.62', ZJL: '-8.72' },
  161130: { FCODE: '161130', PDATE: '2026-10-29', NAV: '4.3963' },
  513500: { FCODE: '513500', PDATE: '2026-10-28', NAV: '2.4597', NEWPRICE: '2.657', CHANGERATIO: '-1.15', ZJL: '-8.38' }
};
const rows = () => buildShareRowsFromEastmoney(RAW, { lofPx: { cur: 4.631, pre: 4.722 }, navBaseDate: '2026-10-29' });

test('crons', () => {
  assert.deepEqual(Object.values(SHARE_REPORT_CRONS), ['5 1 * * MON-FRI', '35 7 * * MON-FRI', '0 2 * * SAT']);
});

test('premium = -ZJL (eastmoney), LOF from tencent price / nav, est flag', () => {
  const r = rows();
  assert.equal(r.find((x) => x.code === '513100').premiumPct, 13.89);
  assert.equal(r.find((x) => x.code === '513100').navEstimated, true);
  assert.equal(r.find((x) => x.code === '513300').navEstimated, false);
  assert.equal(r.find((x) => x.code === '161130').premiumPct, 5.34);
  assert.equal(r.find((x) => x.code === '159941').premiumPct, null);
});

test('post report: one fund per line, overnight pick, email drops title + link', () => {
  const rep = composeDailyReport('post', rows(), '2026-10-30');
  assert.match(rep.text, /① 大成 159513　8\.72%/);
  assert.match(rep.text, /隔夜参考：大成 159513/);
  assert.match(rep.text, /净值基准 10月29日/);
  assert.match(rep.url, /daily_post_20261030/);
  assert.doesNotMatch(rep.emailText, /【|https:/);
});

test('overnight pick goes to LOF when all ETFs above halt line', () => {
  const raw = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, v.ZJL ? { ...v, ZJL: '-12' } : v]));
  const rep = composeDailyReport('post', buildShareRowsFromEastmoney(raw, { lofPx: { cur: 4.631, pre: 4.722 } }), '2026-10-30');
  assert.match(rep.text, /隔夜参考：易方达LOF 161130/);
});

test('pre report lists halts', () => {
  const rep = composeDailyReport('pre', rows(), '2026-10-31');
  assert.match(rep.text, /预计 9:30 停牌到 10:30：1 只/);
  assert.match(rep.text, /9:30 正常开盘：大成、华泰柏瑞、华夏/);
});

test('weekly', () => {
  const r = rows();
  const d = [{ ...composeDailyReport('post', r, '2026-10-26'), rows: r }, { ...composeDailyReport('post', r, '2026-10-27'), rows: r }];
  const rep = composeWeeklyReport(d, '2026-10-31');
  assert.match(rep.text, /最常出现的最低溢价：大成（2 天）/);
});
