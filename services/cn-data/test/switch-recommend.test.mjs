/* global process, fetch, setTimeout, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { openDb as openAuthServiceDb, closeDb as closeAuthServiceDb } from '../../auth/src/db.js';
import { registerUser } from '../../auth/src/auth.js';
import { clearMinuteKlineCache, parseTencentDayMinutes } from '../src/notify/minuteKline.js';
import { buildPairSeries, handleSwitchRecommend, replaySpread } from '../src/notify/switchRecommend.js';

// ---- 固定分钟 fixture：所有基金净值恒为 2.0；159632 溢价 5% ± 0.6% 正弦摆动，513100 恒 4.5%，
// 其余基金视为无成交（累计量不变 / v=0），分钟 bar 被过滤，不参与配对。
const LIQUID = new Set(['159632', '513100']);
const NAV = 2;
const DAYS_1M = ['20261019', '20261020', '20261021', '20261022', '20261023'];
const DAYS_5M = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', ...DAYS_1M.map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`)];
const minutes = (step) => {
  const out = [];
  for (const [start, end] of [[570, 690], [780, 900]]) for (let m = start; m <= end; m += step) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`);
  return out;
};
function premium(code, index) {
  const wave = 5 + 0.6 * Math.sin(index / 20);
  if (code === '159632') return wave;
  return 4.5;
}
const price = (code, index) => (NAV * (1 + premium(code, index) / 100)).toFixed(3);

function tencentPayload(code) {
  const prefix = code.startsWith('5') ? 'sh' : 'sz';
  let index = 0;
  const data = DAYS_1M.map((date) => {
    let volume = 0;
    return { date, data: minutes(1).map((hhmm) => { volume += LIQUID.has(code) ? 100 : 0; index += 1; return `${hhmm} ${price(code, index)} ${volume} 0`; }) };
  }).reverse();
  return { code: 0, data: { [`${prefix}${code}`]: { data } } };
}
function collectorPayload(code) {
  let index = 0;
  const candles = DAYS_5M.flatMap((date) => minutes(5).map((hhmm) => {
    index += 5;
    return { time: `${date} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00`, c: Number(price(code, index)), v: LIQUID.has(code) ? 1000 : 0 };
  }));
  return { candles };
}
const navPayload = () => ({ Datas: ['2026-10-09', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-21', '2026-10-22'].map((FSRQ) => ({ FSRQ, DWJZ: String(NAV) })) });

function stubUpstream(t, mode = 'ok') {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1:') && !href.includes('/api/markets/')) return original(url, init);
    calls.push(href);
    if (mode === 'down') throw new Error('connect ECONNREFUSED');
    if (mode === 'slow') { await new Promise((resolve) => setTimeout(resolve, 300)); throw new Error('slow'); }
    const code = href.match(/(\d{6})(?!.*\d{6})/)?.[1] || href.match(/FCODE=(\d{6})/)?.[1];
    const body = href.includes('day/query') ? tencentPayload(code)
      : href.includes('/kline/') ? collectorPayload(href.match(/kline\/(\d{6})/)[1])
        : href.includes('FundMNHisNetList') ? navPayload() : null;
    if (!body) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  clearMinuteKlineCache();
  t.after(() => { globalThis.fetch = original; clearMinuteKlineCache(); });
  return calls;
}

function memoryDb(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

test('腾讯分时只保留有成交且在交易时段内的分钟', () => {
  const payload = { data: { sz159632: { data: [{ date: '20261026', data: [
    '0930 2.431 0 0.000', '0931 2.431 0 0.000', '1030 2.420 500 1210', '1031 2.421 500 1210', '1032 2.422 800 1937', '1530 2.43 900 2100'
  ] }] } } };
  const bars = parseTencentDayMinutes(payload, '159632');
  assert.deepEqual(bars.map((bar) => bar.t), ['2026-10-26 10:30', '2026-10-26 10:32']);
});

test('价差序列用 bar 日期之前两只基金共同的最新净值', () => {
  const rows = buildPairSeries(
    [{ t: '2026-10-23 10:00', date: '2026-10-23', close: 2.2 }, { t: '2026-10-23 10:01', date: '2026-10-23', close: 2.2 }],
    [{ t: '2026-10-23 10:00', date: '2026-10-23', close: 2.1 }],
    [{ date: '2026-10-21', nav: 2 }, { date: '2026-10-22', nav: 2 }, { date: '2026-10-23', nav: 9 }],
    [{ date: '2026-10-21', nav: 2 }, { date: '2026-10-23', nav: 9 }]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].navDate, '2026-10-21');
  assert.ok(Math.abs(rows[0].spread - 5) < 1e-9);
});

test('回放：H→L→H 往返计 1 轮，费用吃掉价差时不算胜', () => {
  const rows = [0.2, 1.2, 0.1, 0.5].map((spread, i) => ({ t: String(i), date: 'd', priceH: 2 * (1 + spread / 100), priceL: 2, spread }));
  const cheap = replaySpread(rows, { startSide: 'H', lowerPct: 0.15, upperPct: 1, costPct: 0.05 });
  assert.equal(cheap.triggerCount, 2);
  assert.equal(cheap.cycleCount, 1);
  assert.equal(cheap.winRatePct, 100);
  const costly = replaySpread(rows, { startSide: 'H', lowerPct: 0.15, upperPct: 1, costPct: 1 });
  assert.equal(costly.winRatePct, 0);
});

test('分组 / 阈值 / 费用 / 持仓缺失按 10000 元', async (t) => {
  const calls = stubUpstream(t);
  const db = memoryDb(t);
  const result = await handleSwitchRecommend(db, 'u1', { holdingCode: '159632', feeWanRate: 1 });
  assert.equal(result.status, undefined);
  const rule = result.body.rule;
  assert.equal(result.body.ok, true);
  assert.deepEqual(rule.highCodes, ['159632']);
  assert.deepEqual(rule.lowCodes, ['513100']);
  assert.equal(rule.holdingSide, 'H');
  assert.equal(rule.backtestTimeframe, '1m');
  assert.ok(rule.upperPct > rule.lowerPct);
  assert.ok(rule.upperPct - rule.lowerPct >= 2 * rule.feeConfig.switchCostPct - 1e-6);
  assert.ok(rule.feeConfig.switchCostPct > 0.02 && rule.feeConfig.switchCostPct < 0.1);
  assert.equal(rule.backtest.selectionStatus, 'optimized');
  assert.ok(rule.backtest.cycleCount >= 1);
  assert.equal(rule.holdingNotional, 10000);
  assert.equal(rule.holdingQuantity, null);
  assert.equal(rule.holdingSource, 'default');
  assert.equal(rule.feeConfig.estimatedTotalFee, 2);
  assert.equal(rule.feeConfig.mode, 'estimated_total');
  assert.match(rule.message, /最近 5 个交易日 1m 盘中溢价差/);
  assert.equal(rule.backtest.crossCheck.timeframe, '5m');
  assert.equal(rule.candidateFundCodes.length, 11);
  // 第二次点击命中短缓存，不再请求上游
  const before = calls.length;
  await handleSwitchRecommend(db, 'u1', { holdingCode: '513100', feeWanRate: 1 });
  assert.equal(calls.length, before);
});

test('持有低溢价腿时 holdingSide=L；高费率拉大阈值带宽', async (t) => {
  stubUpstream(t);
  const db = memoryDb(t);
  const low = (await handleSwitchRecommend(db, 'u1', { holdingCode: '513100', feeWanRate: 1 })).body.rule;
  assert.equal(low.holdingSide, 'L');
  assert.deepEqual(low.lowCodes, ['513100']);
  const pricey = (await handleSwitchRecommend(db, 'u1', { holdingCode: '159632', feeWanRate: 30 })).body.rule;
  assert.ok(pricey.upperPct - pricey.lowerPct >= 2 * (0.6 + 0.04) - 1e-6);
});

test('持仓金额从账本读取', async (t) => {
  stubUpstream(t);
  const db = memoryDb(t);
  const insert = db.prepare(`INSERT INTO account_holdings_transactions
    (user_id, transaction_id, revision, content_hash, bytes, payload, deleted, updated_at, updated_by_end_id, updated_by_end_type)
    VALUES (?, ?, 1, '', 0, ?, 0, '2026-10-01', '', '')`);
  insert.run('u2', 'a', JSON.stringify({ code: '159632', type: 'BUY', shares: 5000, name: '华安纳指' }));
  insert.run('u2', 'b', JSON.stringify({ code: '159632', type: 'SELL', shares: 1000 }));
  insert.run('u3', 'c', JSON.stringify({ code: '159632', type: 'BUY', shares: 9999 }));
  const rule = (await handleSwitchRecommend(db, 'u2', { holdingCode: '159632', feeWanRate: 1 })).body.rule;
  assert.equal(rule.holdingQuantity, 4000);
  assert.equal(rule.holdingSource, 'ledger');
  assert.ok(rule.holdingNotional > 8000 && rule.holdingNotional < 9000);
});

test('参数错误与池外代码返回明确错误', async (t) => {
  stubUpstream(t);
  const db = memoryDb(t);
  assert.equal((await handleSwitchRecommend(db, 'u1', { holdingCode: '12' })).body.code, 'INVALID_HOLDING_CODE');
  assert.equal((await handleSwitchRecommend(db, 'u1', { holdingCode: '159632', feeWanRate: -1 })).body.code, 'INVALID_FEE');
  const outside = await handleSwitchRecommend(db, 'u1', { holdingCode: '513500', feeWanRate: 1 });
  assert.equal(outside.status, 400);
  assert.equal(outside.body.code, 'HOLDING_NOT_IN_POOL');
});

test('上游失败 502、超时 504', async (t) => {
  const db = memoryDb(t);
  await t.test('down', async (tt) => {
    stubUpstream(tt, 'down');
    const res = await handleSwitchRecommend(db, 'u1', { holdingCode: '159632', feeWanRate: 1 });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(res.body.ok, false);
  });
  await t.test('timeout', async (tt) => {
    stubUpstream(tt, 'slow');
    const res = await handleSwitchRecommend(db, 'u1', { holdingCode: '159632', feeWanRate: 1 }, { budgetMs: 50 });
    assert.equal(res.status, 504);
    assert.equal(res.body.code, 'RECOMMEND_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });
});

test('HTTP：未登录 401、无 api:fund-switch 403、VIP 200', async (t) => {
  stubUpstream(t);
  const directory = mkdtempSync(join(tmpdir(), 'cn-data-recommend-auth-'));
  const path = join(directory, 'auth.sqlite');
  const authDb = openAuthServiceDb(path);
  const plain = registerUser(authDb, { username: 'plainrec', clientPasswordHash: 'a'.repeat(64) });
  const vip = registerUser(authDb, { username: 'viprec', clientPasswordHash: 'a'.repeat(64) });
  authDb.prepare('DELETE FROM user_roles WHERE user_id = ?').run(plain.userId);
  // 与线上一致：api:fund-switch 只授予 vip 及以上（迁移默认给了 user）。
  authDb.prepare("DELETE FROM role_permissions WHERE role_code = 'user' AND perm_code = 'api:fund-switch'").run();
  authDb.prepare("INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES ('vip', 'api:fund-switch')").run();
  authDb.prepare('INSERT OR REPLACE INTO user_roles (user_id, role_code, expires_at, granted_by, created_at) VALUES (?, ?, NULL, ?, ?)')
    .run(vip.userId, 'vip', 'test', new Date().toISOString());
  const previous = process.env.AUTH_DB_PATH;
  process.env.AUTH_DB_PATH = path;
  const db = memoryDb(t);
  const server = createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close(); server.closeAllConnections();
    closeAuthServiceDb(authDb);
    if (previous === undefined) delete process.env.AUTH_DB_PATH; else process.env.AUTH_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/notify/switch/recommend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ holdingCode: '159632', feeWanRate: 1 })
    });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('')).status, 401);
  assert.equal((await call(plain.accessToken)).status, 403);
  const ok = await call(vip.accessToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.deepEqual(ok.body.rule.highCodes, ['159632']);
});
