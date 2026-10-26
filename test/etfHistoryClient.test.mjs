import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canViewEtfHistory,
  createEtfHistoryClient,
  fmtShares,
  historyToCsv,
  limitEvents,
  normalizeEtfHistory,
  sliceRange,
  summarizeHistory
} from '../src/app/etfHistoryClient.js';

const row = (d, extra = {}) => ({ d, sh: 1e8, dsh: 0, close: 1.1, nav: 1, prem: 10, dprem: 0, eff: 'limited', effShares: 3750000, src: 'net', allow: true, ...extra });

test('canViewEtfHistory: 仅登录且有 api:etf-history 或管理员', () => {
  assert.equal(canViewEtfHistory(null), false);
  assert.equal(canViewEtfHistory({ loggedIn: false, perms: ['api:etf-history'] }), false);
  assert.equal(canViewEtfHistory({ loggedIn: true, perms: ['api:nasdaq-radar'] }), false);
  assert.equal(canViewEtfHistory({ loggedIn: true, perms: ['api:etf-history'] }), true);
  assert.equal(canViewEtfHistory({ loggedIn: true, isAdmin: true, perms: [] }), true);
});

test('normalizeEtfHistory: 代码不符或结构错误返回 null，行按日期排序并丢弃非法值', () => {
  assert.equal(normalizeEtfHistory({ code: '513300', rows: [] }, '159501'), null);
  assert.equal(normalizeEtfHistory({ code: '513300' }, '513300'), null);
  const n = normalizeEtfHistory({ code: '513300', name: 'x', market: 'SSE', rows: [row('2026-10-23'), { d: 'bad' }, row('2026-10-22', { sh: 'NaN', eff: 'weird' })] }, '513300');
  assert.deepEqual(n.rows.map((r) => r.d), ['2026-10-22', '2026-10-23']);
  assert.equal(n.rows[0].sh, null);
  assert.equal(n.rows[0].eff, null);
});

test('limitEvents: 收紧/放宽/不限，未知一侧不计', () => {
  const rows = [
    row('2026-10-20'),
    row('2026-10-21', { effShares: 750000 }),
    row('2026-10-22', { eff: null, effShares: null }),
    row('2026-10-23', { effShares: 750000 }),
    row('2026-10-26', { eff: 'unlimited', effShares: null })
  ];
  const ev = limitEvents(rows);
  assert.deepEqual(ev.map((e) => [e.d, e.kind, e.from, e.to]), [
    ['2026-10-21', 'tightened', 3750000, 750000],
    ['2026-10-26', 'relaxed', 750000, Infinity]
  ]);
});

test('sliceRange / summarizeHistory', () => {
  const rows = Array.from({ length: 200 }, (_, i) => row(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, { sh: 1e8 + i * 1e6, prem: i }));
  assert.equal(sliceRange(rows, '1m').length, 22);
  assert.equal(sliceRange(rows, '1y').length, 200);
  const s = summarizeHistory(sliceRange(rows, '1m'));
  assert.equal(s.sharesChange, 21e6);
  assert.equal(s.premium, 199);
});

test('fmtShares / CSV', () => {
  assert.equal(fmtShares(484100000), '4.84亿');
  assert.equal(fmtShares(750000, { sign: true }), '+75万');
  assert.equal(fmtShares(null), '—');
  const csv = historyToCsv([row('2026-10-26', { effShares: 750000 })], { code: '513300', name: '纳指,ETF' });
  assert.ok(csv.startsWith('\ufeff日期,'));
  assert.ok(csv.includes('"纳指,ETF"'));
  assert.ok(csv.includes('750000,净申购,是'));
});

test('client: 401/403 映射为 login/locked，带 Bearer，成功结果缓存', async () => {
  const calls = [];
  let status = 403;
  const client = createEtfHistoryClient({
    session: () => ({ accessToken: 'tok', username: 'u' }),
    fetchImpl: async (url, init) => {
      calls.push([url, init.headers.Authorization]);
      if (status !== 200) return { status, ok: false };
      return { status: 200, ok: true, json: async () => ({ code: '513300', rows: [row('2026-10-26')] }) };
    }
  });
  assert.equal((await client.load('513300')).state, 'locked');
  status = 401;
  assert.equal((await client.load('513300')).state, 'login');
  status = 200;
  assert.equal((await client.load('513300')).state, 'ready');
  await client.load('513300');
  assert.equal(calls.length, 3);
  assert.match(calls[0][0], /\/api\/etf-history\/513300\.json$/);
  assert.equal(calls[0][1], 'Bearer tok');
  assert.equal((await client.load('../x')).state, 'error');
});
