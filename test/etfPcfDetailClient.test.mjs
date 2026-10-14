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
