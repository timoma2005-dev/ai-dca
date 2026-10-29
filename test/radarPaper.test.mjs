import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPaper, paperRecords, paperStats, paperSummary } from '../src/app/radarPaper.js';

// 4 天：d1 发出 A→B 信号，T+1(d2) 收盘成交，持有 1 日到 d3
function snap({ pair, parity, backfill } = {}) {
  return {
    series: {
      dates: ['d1', 'd2', 'd3', 'd4'],
      etfs: {
        A: { price: [1, 1, 0.99, 0.98], premium: [5, 5, 4, 3] },
        B: { price: [1, 1, 1.01, 1.02], premium: [4, 4, 5, 6] },
      },
      paper: {
        pair: pair || [['A', 'B', 70], ['A', 'B', 72], null, ['A', 'B', 60]],
        parity: parity || [null, null, null, null],
        backfill: backfill || [1, 0, 0, 0],
      },
    },
  };
}

test('hasPaper: 无 series.paper 时为 false', () => {
  assert.equal(hasPaper({ series: { dates: [] } }), false);
  assert.equal(hasPaper(snap()), true);
});

test('paperRecords: T+1 收盘成交，持有 k 日，扣成本', () => {
  const r = paperRecords(snap(), { hold: 1, dedupe: true, cost: 0.15 });
  // d1 记一笔；d2 与 d1 同一建议被去重；d4 重新出现（中间断开）再记一笔
  assert.deepEqual(r.map((x) => x.date), ['d1', 'd4']);
  const first = r[0];
  assert.equal(first.entryDate, 'd2');
  assert.equal(first.exitDate, 'd3');
  // (1.01/1)/(0.99/1) − 1 = 2.0202% − 0.15%
  assert.equal(first.ret, 1.87);
  assert.equal(first.convergence, 2); // B +1pp，A −1pp
  assert.equal(first.backfill, true);
  assert.equal(r[1].status, 'pending');
});

test('paperRecords: 不去重时每天都记', () => {
  const r = paperRecords(snap(), { hold: 1, dedupe: false });
  assert.deepEqual(r.map((x) => x.date), ['d1', 'd2', 'd4']);
});

test('paperStats / paperSummary: 胜率与按来源拆分', () => {
  const st = paperStats([{ status: 'done', ret: 1 }, { status: 'done', ret: -0.5 }, { status: 'pending', ret: null }]);
  assert.equal(st.done, 2); assert.equal(st.pending, 1); assert.equal(st.winRate, 50); assert.equal(st.avgRet, 0.25); assert.equal(st.sumRet, 0.5);
  const s = paperSummary(snap(), { hold: 1, dedupe: false });
  assert.equal(s.backfill.done, 1);
  assert.equal(s.live.done, 1); // d2 实时，成交 d3、结算 d4
  assert.equal(s.live.pending, 1);
});

test('paperRecords: 平价换基单独统计', () => {
  const r = paperRecords(snap({ parity: [null, ['B', 'A', 12], null, null] }), { kind: 'parity', hold: 1 });
  assert.equal(r.length, 1);
  assert.equal(r[0].score, 12);
  assert.equal(r[0].sell.code, 'B');
});
