import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPcfDetailClient, formatPcfShares, pcfDetailSections } from '../src/app/etfPcfDetailClient.js';
const code = '159941', date = '2026-10-13';
const payload = { code, date, source: 'szse_pcf', prevDayNav: 1.5499 };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('详情懒加载 GET、按 code+快照日期去重、命中/过期缓存与日期隔离', async () => {
  let clock = 1000;
  const calls = [];
  let resolve;
  const client = createPcfDetailClient({ now: () => clock, fetchImpl: (url, options) => {
    calls.push({ url, options }); return new Promise((r) => { resolve = r; });
  } });
  assert.equal(calls.length, 0);
  const a = client.subscribe(code, date), b = client.subscribe(code, date);
  assert.equal(calls.length, 1);
  assert.equal(a.promise, b.promise);
  assert.equal(calls[0].url, '/api/etf-pcf-limit?code=159941&date=2026-10-13');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
  a.release(); assert.equal(calls[0].options.signal.aborted, false);
  resolve(response(payload)); assert.equal((await b.promise).state, 'ready'); b.release();
  await client.subscribe(code, date).promise; assert.equal(calls.length, 1);
  clock += 300001;
  const expired = client.subscribe(code, date); assert.equal(calls.length, 2);
  resolve(response(payload)); await expired.promise;
  const other = client.subscribe(code, '2026-10-12'); assert.equal(calls.length, 3);
  resolve(response({ ...payload, date: '2026-10-12' })); await other.promise;
});

test('收起取消，晚响应不缓存，再展开发新请求', async () => {
  const calls = [];
  const client = createPcfDetailClient({ fetchImpl: (_url, options) => new Promise((resolve) => calls.push({ resolve, options })) });
  const first = client.subscribe(code, date);
  first.release(); first.release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls[0].options.signal.aborted, true);
  const next = client.subscribe(code, date);
  assert.equal(calls.length, 2);
  calls[0].resolve(response(payload)); assert.equal((await first.promise).state, 'error');
  calls[1].resolve(response(payload)); assert.equal((await next.promise).state, 'ready');
});

test('404 cache_miss 为无数据，失败不自动重试，redirect/source/identity 拒绝且不缓存', async () => {
  for (const result of [response({ reason: 'cache_miss' }, 404), response({}, 503),
    response({ reason: 'unsupported_code' }, 404), response({ ...payload, source: 'wrong' }),
    response({ ...payload, date: '2026-10-12' }), response({ ...payload, code: '159501' }),
    { status: 302, body: { cancel: async () => {} } }, { type: 'opaqueredirect', status: 0 }]) {
    let calls = 0;
    const client = createPcfDetailClient({ fetchImpl: async () => { calls++; return result.clone ? result.clone() : result; } });
    const value = await client.subscribe(code, date).promise;
    assert.equal(value.state, result.status === 404 && (await result.clone().json()).reason === 'cache_miss' ? 'empty' : 'error');
    assert.equal(calls, 1);
    await client.subscribe(code, date).promise;
    assert.equal(calls, 2);
  }
});

test('服务端过期时间不延长本地缓存', async () => {
  let clock = 1000, calls = 0;
  const client = createPcfDetailClient({ now: () => clock, fetchImpl: async () => {
    calls++; return response({ ...payload, expiresAt: new Date(2000).toISOString() });
  } });
  await client.subscribe(code, date).promise;
  await client.subscribe(code, date).promise; assert.equal(calls, 1);
  clock = 2000;
  await client.subscribe(code, date).promise; assert.equal(calls, 2);
});

test('两市场字段映射、原始净值精度、允许情况与上限单位', () => {
  assert.equal(formatPcfShares(1e8), '1.00亿份');
  assert.equal(formatPcfShares(1e6), '100.00万份');
  assert.equal(formatPcfShares(1234), '1234份');
  assert.equal(formatPcfShares(null), '—');
  const sz = pcfDetailSections({ ...payload, prevDayDate: '2026-10-09', prevDayCashDifference: -12.5,
    prevDayUnitNav: 100, estimatedCashDifference: 4275.36, iopvRequired: false,
    subscriptionAllowed: true, redemptionAllowed: false, cashSubstitutionRatioLimitPct: 100,
    totalSubscribeLimitShares: null, netSubscribeLimitShares: null });
  assert.equal(sz[0].date, '2026-10-09');
  assert.deepEqual(sz[0].rows.map((r) => r[1]), ['-12.5', '100', '1.5499']);
  assert.deepEqual(sz[1].rows.map((r) => r[1]), ['4,275.36', '100%', '否', '—', '允许', '不允许', '无', '—', '不设上限', '—']);
  const sse = pcfDetailSections({ source: 'sse_pcf', navPerCreationUnit: 123, nav: 1.23, creationRedemption: '暂停申赎' });
  assert.equal(sse[0].date, '—');
  assert.deepEqual(sse[0].rows.map((r) => r[1]), ['—', '123', '1.23']);
  assert.equal(sse[1].rows[4][1], '暂停申赎');
  assert.equal(sse[1].rows[5][1], '暂停申赎');
});

test('单账户限额四字段逐项独立追加；数值/0/null/unlimited/unknown 格式；旧 payload 保持 10+3 行', () => {
  const base = { ...payload, prevDayDate: '2026-10-09' };
  // 旧 payload：无任何 account* 字段时 T 日保持 10 行、P 日 3 行，顺序不变。
  const legacy = pcfDetailSections(base);
  assert.equal(legacy[1].rows.length, 10);
  assert.equal(legacy[0].rows.length, 3);
  assert.equal(legacy[1].rows[9][0], '当日净赎回上限');
  // 四个单账户字段逐项独立出现，互不连带：只给一项只在末尾追加对应一行。
  assert.deepEqual(
    pcfDetailSections({
      ...base,
      accountTotalSubscribeLimitShares: 1000000,
      accountTotalSubscribeLimitKind: 'limited'
    })[1].rows.slice(-1),
    [['单账户累计申购上限', '100.00万份']]
  );
  assert.deepEqual(
    pcfDetailSections({
      ...base,
      accountTotalRedeemLimitShares: 0,
      accountTotalRedeemLimitKind: 'limited'
    })[1].rows.slice(-1),
    [['单账户累计赎回上限', '0份']]
  );
  assert.deepEqual(
    pcfDetailSections({
      ...base,
      accountNetSubscribeLimitShares: null,
      accountNetSubscribeLimitKind: 'unlimited'
    })[1].rows.slice(-1),
    [['单账户净申购上限', '不设上限']]
  );
  // Shares null 或 kind unlimited 都记「不设上限」；kind 缺失而 shares 缺失（数值缺失）记「—」。
  assert.deepEqual(
    pcfDetailSections({
      ...base,
      accountNetRedeemLimitShares: null,
      accountNetRedeemLimitKind: 'unknown'
    })[1].rows.slice(-1),
    [['单账户净赎回上限', '不设上限']]
  );
  assert.deepEqual(
    pcfDetailSections({ ...base, accountNetRedeemLimitKind: 'unknown' })[1].rows.slice(-1),
    [['单账户净赎回上限', '—']]
  );
  assert.deepEqual(
    pcfDetailSections({ ...base, accountTotalSubscribeLimitKind: 'limited' })[1].rows.slice(-1),
    [['单账户累计申购上限', '—']]
  );
  // 四项齐全：T 日 14 行（10 + 4），追加行顺序固定，P 日 3 行不变。
  const full = pcfDetailSections({
    ...base,
    accountTotalSubscribeLimitShares: 1000000,
    accountTotalSubscribeLimitKind: 'limited',
    accountTotalRedeemLimitShares: 0,
    accountTotalRedeemLimitKind: 'limited',
    accountNetSubscribeLimitShares: null,
    accountNetSubscribeLimitKind: 'unlimited',
    accountNetRedeemLimitShares: null,
    accountNetRedeemLimitKind: 'unknown'
  });
  assert.equal(full[1].rows.length, 14);
  assert.equal(full[0].rows.length, 3);
  assert.deepEqual(
    full[1].rows.slice(10).map((r) => [r[0], r[1]]),
    [
      ['单账户累计申购上限', '100.00万份'],
      ['单账户累计赎回上限', '0份'],
      ['单账户净申购上限', '不设上限'],
      ['单账户净赎回上限', '不设上限']
    ]
  );
  assert.deepEqual(full[1].rows.slice(0, 10), legacy[1].rows);
});

 test('同周期 effect 卸载重挂复用 inflight', async () => {
  let calls = 0, resolve;
  const client = createPcfDetailClient({ fetchImpl: () => { calls++; return new Promise((r) => { resolve = r; }); } });
  const first = client.subscribe(code, date); first.release();
  const remount = client.subscribe(code, date);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(first.promise, remount.promise);
  assert.equal(calls, 1);
  resolve(response(payload));
  assert.equal((await remount.promise).state, 'ready');
  remount.release();
});
