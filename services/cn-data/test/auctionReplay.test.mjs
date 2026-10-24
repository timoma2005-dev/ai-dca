import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auctionTeaser, findBase, maskRecording, parseQQ, recordFrame, topCodes, AUCTION_ETFS } from '../src/demo/auctionReplay.js';

function qqLine(key, cur, pre, t) {
  const f = Array(80).fill('');
  f[1] = 'X'; f[2] = key.slice(2); f[3] = cur; f[4] = pre; f[5] = cur; f[6] = 100; f[9] = cur; f[10] = 5; f[19] = cur; f[20] = 4; f[30] = t; f[40] = '';
  return `v_${key}="${f.join('~')}";`;
}
const T = (hms) => `20261026${hms.replace(/:/g, '')}`;

test('parseQQ and findBase follow the board', () => {
  const qq = parseQQ(qqLine('sh513100', 2.2, 2.0, T('09:20:00')) + qqLine('sz159501', 1.5, 1.5, T('09:20:03')));
  assert.equal(qq.etf.sh513100.cur, 2.2);
  assert.equal(qq.etfTime, T('09:20:03'));
  const pts = [{ t: '2026-10-23 14:59', p: 100 }, { t: '2026-10-23 15:00', p: 101 }, { t: '2026-10-26 09:20', p: 102 }];
  assert.deepEqual(findBase(pts, '2026-10-26 09:20'), { t: '2026-10-23 15:00', p: 101, approx: false });
});

test('mask keeps only the 3 largest |deviation| quotes per frame', () => {
  const etf = {};
  AUCTION_ETFS.forEach((k, i) => { etf[k] = { cur: 1 + i / 100, pre: 1, flag: '' }; });
  etf.sh513100.flag = 'S';
  const top = topCodes(etf, 0);
  assert.equal(top.length, 3);
  assert.ok(!top.includes('sh513100'), 'halted excluded');
  const masked = maskRecording({ date: '2026-10-26', nqPts: [{ t: 'a', p: 100 }], nqBase: { t: 'a', p: 100 }, nav: { 513100: { nav: 1 }, 159513: { nav: 1 } }, frames: [{ s: 33600, etfTime: 'x', nqLast: { t: 'b', p: 100 }, etf }] });
  assert.equal(Object.keys(masked.frames[0].etf).length, 3);
  assert.deepEqual(Object.keys(masked.nav), ['159513']);
});

test('recorder writes frames on a trading day, skips stale quotes, and the teaser serves live / replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auction-'));
  const now = Date.parse('2026-10-26T01:20:00Z'); // 09:20 北京
  const body = AUCTION_ETFS.map((k, i) => qqLine(k, (1 + i / 1000).toFixed(3), '1.000', T('09:20:00'))).join('');
  const fetchText = async (url) => (url.includes('gtimg') ? body : url.includes('trends2')
    ? JSON.stringify({ data: { trends: ['2026-10-23 15:00,100', '2026-10-26 09:20,100.1'] } })
    : JSON.stringify({ Datas: [] }));
  assert.deepEqual(await recordFrame({ now, dir, fetchText }), { frames: 1 });
  assert.equal((await recordFrame({ now: now + 86400000, dir, fetchText })).skipped, 'stale-quotes');
  const live = auctionTeaser({ now, dir });
  assert.equal(live.mode, 'live');
  assert.equal(Object.keys(live.frames[0].etf).length, 3);
  assert.equal(auctionTeaser({ now: now + 3600000, dir }), null, '09:20 才录到一帧，不算完整交易日');
});
