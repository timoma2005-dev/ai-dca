import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatInt,
  formatDeltaShares,
  formatSharesCompact,
  formatNetSumWan,
  formatCreationCell,
  limitText,
  isCappedOrNear,
  ceilingMeta,
  sortRecords,
  matchesSearch,
  pillRows,
  limitAnchorText,
  progressMeta,
  summaryStats
} from '../src/pages/etfPcfSharesView.js';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';
import { confirmedSharesCalendar } from '../shared/etfPcfTradingCalendar.js';

test('数字格式化：整数千分位、缺失不补零；万份增量千分位、零显示 0 份', () => {
  assert.equal(formatInt(7077986575), '7,077,986,575');
  assert.equal(formatInt(0), '0');
  assert.equal(formatInt(null), '—');
  assert.equal(formatDeltaShares(10000000), '1,000.00 万份');
  assert.equal(formatDeltaShares(123450000), '12,345.00 万份');
  assert.equal(formatDeltaShares(1300000), '130.00 万份');
  assert.equal(formatDeltaShares(0), '0 份');
  assert.equal(formatDeltaShares(-1000000), '-100.00 万份');
  assert.equal(formatDeltaShares(null), '—');
  assert.equal(formatSharesCompact(7077986575), '70.78 亿份');
  assert.equal(formatSharesCompact(890120000), '8.90 亿份');
  assert.equal(formatSharesCompact(5000000), '500.00 万份');
  assert.equal(formatSharesCompact(9999), '9,999 份');
  assert.equal(formatSharesCompact(null), '—');
  assert.equal(formatNetSumWan(67600000), '+6,760.00');
  assert.equal(formatNetSumWan(-1000000), '-100.00');
  assert.equal(formatNetSumWan(0), '0.00');
  assert.equal(formatNetSumWan(null), '—');
});

test('盘前净新增复用 creationLabel：约/确定/暂无语义保持不变', () => {
  assert.deepEqual(formatCreationCell({ creationShares: 8425300, creationSharesKind: 'estimate' }), {
    text: '约 842.53 万',
    kind: 'estimate',
    tone: 'pos'
  });
  assert.deepEqual(formatCreationCell({ creationShares: 12500000, creationSharesKind: 'estimate' }), {
    text: '约 1,250 万',
    kind: 'estimate',
    tone: 'pos'
  });
  assert.deepEqual(formatCreationCell({ creationShares: 0, creationSharesKind: 'exact' }), {
    text: '0 万',
    kind: 'exact',
    tone: 'zero'
  });
  assert.deepEqual(formatCreationCell({ creationShares: null, creationSharesKind: null }), {
    text: '暂无',
    kind: null,
    tone: 'muted'
  });
  assert.deepEqual(formatCreationCell({ creationShares: -1000, creationSharesKind: 'estimate' }), {
    text: '暂无',
    kind: null,
    tone: 'muted'
  });
});

test('累计申购上限：有限万/亿份、无限累计不限、未知为 —', () => {
  assert.equal(limitText({ totalLimitKind: 'limited', totalLimitShares: 13000000 }), '1,300 万份');
  assert.equal(limitText({ totalLimitKind: 'limited', totalLimitShares: 170000000 }), '1.70 亿份');
  assert.equal(limitText({ totalLimitKind: 'unlimited', totalLimitShares: null }), '累计不限');
  assert.equal(limitText({ totalLimitKind: 'unknown', totalLimitShares: null }), '—');
  assert.equal(limitText({ totalLimitKind: 'limited', totalLimitShares: null }), '—');
});

test('顶格状态映射：sharesCeiling kind 原样输出，沪市与缺失为待确认', () => {
  const rows = syntheticProjection().records;
  assert.deepEqual(
    rows.slice(0, 6).map((r) => ceilingMeta(r)),
    [
      { kind: 'at-limit', label: '顶格 100%' },
      { kind: 'near-limit', label: '接近 95%' },
      { kind: 'over-limit', label: '超限 125%' },
      { kind: 'outflow', label: '净流出' },
      { kind: 'unlimited', label: '累计不限' },
      { kind: 'pending', label: '数据待确认' }
    ]
  );
  assert.deepEqual(ceilingMeta(rows.find((r) => !r.code.startsWith('159'))), {
    kind: 'pending',
    label: '沪市待接入'
  });
  assert.deepEqual(ceilingMeta({ ...rows[0], atLimit: false, nearTotalLimit: false, utilization: 0.5 }), {
    kind: 'normal',
    label: '未顶格 50%'
  });
  assert.equal(isCappedOrNear(rows[0]), true);
  assert.equal(isCappedOrNear(rows[1]), true);
  assert.equal(isCappedOrNear(rows[2]), false);
  assert.equal(isCappedOrNear(rows[4]), false);
  assert.equal(isCappedOrNear(rows[5]), false);
});

test('列头排序：缺失值置底、同值按代码稳定排序、代码列正倒序', () => {
  const rows = syntheticProjection().records;
  const codes = (list) => list.map((r) => r.code);
  assert.deepEqual(codes(sortRecords(rows, { key: null })), codes(rows));
  assert.equal(sortRecords(rows, { key: null, dir: 'asc' }), rows);
  const desc = codes(sortRecords(rows, { key: 'deltaShares', dir: 'desc' }));
  assert.deepEqual(desc, [
    '159513',
    '159501',
    '159509',
    '159659',
    '159660',
    '159696',
    '159941',
    '159632',
    '513100',
    '513110',
    '513300',
    '513390',
    '513870'
  ]);
  const asc = codes(sortRecords(rows, { key: 'deltaShares', dir: 'asc' }));
  assert.equal(asc[0], '159632');
  assert.deepEqual(asc.slice(-6), ['159513', '513100', '513110', '513300', '513390', '513870']);
  assert.deepEqual(codes(sortRecords(rows, { key: 'code', dir: 'desc' }))[0], '513870');
  assert.deepEqual(codes(sortRecords(rows, { key: 'code', dir: 'asc' }))[0], '159501');
  const tie = sortRecords(
    [
      { code: '159941', deltaShares: 0 },
      { code: '159660', deltaShares: 0 },
      { code: '159513', deltaShares: null }
    ],
    { key: 'deltaShares', dir: 'desc' }
  );
  assert.deepEqual(codes(tie), ['159660', '159941', '159513']);
});

test('搜索匹配仅限代码与名称，大小写不敏感，空白视为无条件', () => {
  const row = { code: '159501', name: '纳指ETF嘉实' };
  assert.equal(matchesSearch(row, '159501'), true);
  assert.equal(matchesSearch(row, '纳指'), true);
  assert.equal(matchesSearch(row, '  '), true);
  assert.equal(matchesSearch(row, ''), true);
  assert.equal(matchesSearch(row, '513100'), false);
  assert.equal(matchesSearch({ code: 'SPY', name: 'S&P 500' }, 's&p'), true);
});

test('口径 Pill：PCF 对齐按 T/P 日表述，未对齐回退统计口径，限额日期不一切换提示', () => {
  const aligned = {
    ...syntheticProjection({
      date: '2026-10-13',
      prevDate: '2026-10-12',
      tradingCalendar: confirmedSharesCalendar('2026-10-04', '2026-10-14')
    }),
    pcfSnapshot: { source: 'szse_pcf', date: '2026-10-14', codes: ['159941'] }
  };
  assert.deepEqual(pillRows(aligned, aligned.records).map((p) => `${p.label}: ${p.value}`), [
    '累计申购上限: PCF 限额 (10-13)',
    '盘前净新增: 上一交易日 PCF 推导 (10-13)',
    '本期总份额: 上一交易日快照 (10-13)',
    '上期总份额: 上上交易日快照 (10-12)'
  ]);
  const plain = syntheticProjection();
  assert.deepEqual(pillRows(plain, plain.records).map((p) => `${p.label}: ${p.value}`), [
    '累计申购上限: PCF 限额 (10-12)',
    '盘前净新增: 报表推导 (10-12)',
    '本期总份额: 统计日快照 (10-12)',
    '上期总份额: 上一统计日快照 (10-09)'
  ]);
  const mixed = plain.records.map((r, i) => (i === 0 ? { ...r, limitDate: '2026-10-16' } : r));
  assert.equal(limitAnchorText(mixed), '日期不一，见各行');
  assert.equal(limitAnchorText(plain.records.map((r) => ({ ...r, limitDate: null }))), '—');
  assert.deepEqual(pillRows(null, []), []);
});

test('进度条：宽度 clamp 0-100、文字保留真实百分比、负值净减少、未知/无限不画', () => {
  const rows = syntheticProjection().records;
  assert.deepEqual(progressMeta(rows[0]), { drawable: true, width: 100, text: '100%', tone: 'hot' });
  assert.deepEqual(progressMeta(rows[1]), { drawable: true, width: 95, text: '95%', tone: 'hot' });
  assert.deepEqual(progressMeta(rows[2]), { drawable: true, width: 100, text: '125%', tone: 'hot' });
  assert.deepEqual(progressMeta(rows[3]), { drawable: true, width: 0, text: '净减少', tone: 'neg' });
  assert.deepEqual(progressMeta(rows[4]), { drawable: false, width: 0, text: '', tone: '' });
  assert.deepEqual(progressMeta(rows[5]), { drawable: false, width: 0, text: '', tone: '' });
  assert.deepEqual(progressMeta({ totalLimitKind: 'limited', utilization: 0.385 }), {
    drawable: true,
    width: 38.5,
    text: '39%',
    tone: 'cool'
  });
  assert.deepEqual(progressMeta({ totalLimitKind: 'limited', utilization: 0.5 }), {
    drawable: true,
    width: 50,
    text: '50%',
    tone: 'mid'
  });
});

test('统计卡片：合计净新增为有效深市样本汇总并注明样本数', () => {
  const rows = syntheticProjection().records;
  const stats = summaryStats(rows);
  assert.deepEqual(stats, {
    total: 13,
    szCount: 8,
    shCount: 5,
    cappedCount: 2,
    atLimitCount: 1,
    nearCount: 1,
    netSum: 33000000,
    verifiedCount: 8,
    inflowCount: 4
  });
  const shOnly = summaryStats(rows.filter((r) => !r.code.startsWith('159')));
  assert.equal(shOnly.netSum, null);
  assert.equal(shOnly.verifiedCount, 0);
});
