/* global Response, setTimeout */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRadarClient, RADAR_TTL_MS } from '../src/app/radarClient.js';

const base = Date.parse('2026-10-13T12:00:00.000Z');

function radarData(overrides = {}) {
  return {
    date: '2026-10-13',
    computedAt: '2026-10-13T13:36:05.000Z',
    premiumSource: 'eastmoney-fundmobapi-nav',
    etfs: [
      { code: '159659', name: '招商纳斯达克100ETF', premium: 8.42 },
      { code: '159696', name: '易方达纳斯达克100ETF', premium: -0.5 }
    ],
    bestPair: {
      sell: { code: '159659', name: '招商纳斯达克100ETF', premium: 8.42 },
      buy: { code: '159696', name: '易方达纳斯达克100ETF', premium: -0.5 },
      spread: 8.92,
      percentile: 92,
      historyDays: 20
    },
    ...overrides
  };
}

/**
 * 测试专用 client：GET 走 fallbackFetchImpl → fetchImpl(primary)，
 * 与 fetchWithFallback 成功路径等价；POST 直连 fetchImpl（无 fallback 语义）。
 */
function makeClient({ fetchImpl, primary, computeUrl } = {}) {
  let clock = base;
  const url = primary || 'https://api.example.test/api/notify/nasdaq-radar';
  const impl =
    fetchImpl ||
    (async () => new Response(JSON.stringify({ data: radarData() })));
  const client = createRadarClient({
    now: () => clock,
    getUrls: { primary: url, fallback: '' },
    computeUrl: computeUrl || `${url}/compute`,
    fetchImpl: impl,
    fallbackFetchImpl: (urls, options) => impl(urls.primary, options)
  });
  return { client, setClock: (value) => (clock = value) };
}

test('memory hit serves zero fetch inside 60s TTL; boundary expires exactly at 60s', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ data: radarData() }));
  };
  const { client, setClock } = makeClient({ fetchImpl });
  assert.equal(RADAR_TTL_MS, 60000);
  const first = await client.subscribe().promise;
  assert.equal(first.state, 'ready');
  assert.equal(first.data.date, '2026-10-13');
  await client.subscribe().promise;
  assert.equal(calls, 1); // 缓存命中零 fetch
  setClock(base + 59999);
  await client.subscribe().promise;
  assert.equal(calls, 1);
  setClock(base + RADAR_TTL_MS);
  await client.subscribe().promise;
  assert.equal(calls, 2); // 60 秒边界过期
});

test('empty snapshot is cached as success-without-data and reusable within TTL', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ data: null }));
  };
  const { client } = makeClient({ fetchImpl });
  assert.equal((await client.subscribe().promise).state, 'empty');
  assert.equal((await client.subscribe().promise).state, 'empty');
  assert.equal(calls, 1);
});

test('disabled subscribe stays idle without any fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ data: radarData() }));
  };
  const { client } = makeClient({ fetchImpl });
  assert.equal((await client.subscribe({ enabled: false }).promise).state, 'idle');
  assert.equal(calls, 0);
});

test('inflight is shared: concurrent subscribes reuse one GET and one promise', async () => {
  let calls = 0;
  let releaseFetch;
  const fetchImpl = () => {
    calls++;
    return new Promise((resolve) => (releaseFetch = () => resolve(new Response(JSON.stringify({ data: radarData() })))));
  };
  const { client } = makeClient({ fetchImpl });
  const a = client.subscribe();
  const b = client.subscribe();
  assert.equal(a.promise, b.promise);
  releaseFetch();
  assert.equal((await b.promise).state, 'ready');
  assert.equal(calls, 1);
});

test('source mismatch, malformed payloads and explicit ok:false are failures, never cached', async () => {
  const payloads = [
    JSON.stringify({ data: { ...radarData(), premiumSource: 'wrong-source' } }),
    JSON.stringify({ data: { ...radarData(), premiumSource: undefined } }),
    '{bad json',
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ ok: false, error: 'kv_unavailable' }),
    JSON.stringify({ ok: false, data: radarData() }), // 显式 ok:false 即使附带 data 也失败
    JSON.stringify({ data: { ...radarData(), etfs: [] } }),
    JSON.stringify({ data: { ...radarData(), etfs: 'nope' } })
  ];
  for (const body of payloads) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(body);
    };
    const { client } = makeClient({ fetchImpl });
    const first = await client.subscribe().promise;
    assert.equal(first.state, 'error', body);
    assert.equal(calls, 1);
    assert.equal(client.inspect().memory, null); // 失败不进缓存
    const second = await client.subscribe().promise;
    assert.equal(second.state, 'error'); // 拒绝后可重试：新的一次 fetch
    assert.equal(calls, 2);
  }
});

test('legacy GET without ok but valid data is accepted as success', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ data: radarData() })); // 无 ok 字段
  const { client } = makeClient({ fetchImpl });
  assert.equal((await client.subscribe().promise).state, 'ready');
});

test('redirect responses are rejected and can be retried with a fresh GET', async () => {
  for (const response of [
    { type: 'opaqueredirect', status: 0 },
    { status: 301, body: { cancel: async () => { throw Error('cancel failed'); } } },
    { status: 307 }
  ]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return { ...response, ok: false };
      return new Response(JSON.stringify({ data: radarData() }));
    };
    const { client } = makeClient({ fetchImpl });
    const rejected = await client.subscribe().promise;
    assert.equal(rejected.state, 'error');
    const retried = await client.subscribe().promise;
    assert.equal(retried.state, 'ready'); // 拒绝后可重试
    assert.equal(calls, 2);
  }
});

test('cache key is derived from the resolved address only; response code/source cannot change it', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(
      JSON.stringify({ code: calls, source: `source-${calls}`, data: radarData({ date: `2026-10-1${calls}` }) })
    );
  };
  const { client } = makeClient({ fetchImpl });
  await client.subscribe().promise;
  const second = await client.subscribe().promise;
  assert.equal(calls, 1); // 响应字段不同也不影响命中
  assert.equal(second.data.date, '2026-10-11'); // 命中的是首次响应的同一份数据
  assert.equal(client.inspect().cacheKey, 'https://api.example.test/api/notify/nasdaq-radar');
});

test('different resolved API addresses stay isolated in memory', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ data: radarData() }));
  };
  const a = makeClient({ fetchImpl, primary: 'https://api-a.example.test/api/notify/nasdaq-radar' });
  const b = makeClient({ fetchImpl, primary: 'https://api-b.example.test/api/notify/nasdaq-radar' });
  await a.client.subscribe().promise;
  await b.client.subscribe().promise;
  assert.equal(calls, 2); // 地址不同不共享缓存
  await a.client.subscribe().promise;
  assert.equal(calls, 2);
});

test('abort discipline: one subscriber leaving never aborts a shared request', async () => {
  const signals = [];
  const fetchImpl = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
    });
  const { client } = makeClient({ fetchImpl });
  const a = client.subscribe();
  a.release();
  const b = client.subscribe();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(signals[0].aborted, false); // 单个订阅卸载不影响共享请求
  const c = client.subscribe();
  assert.equal(b.promise, c.promise);
  b.release();
  c.release();
  await b.promise.catch(() => {});
  assert.equal(signals[0].aborted, true); // 零消费者才 abort
  const d = client.subscribe();
  assert.notEqual(d.promise, b.promise); // 被中断的任务不复用
  d.release();
  await d.promise.catch(() => {});
});

test('stale GET started before a successful POST never overwrites the compute result', async () => {
  let postCalls = 0;
  let releaseGet;
  const fetchImpl = async (_url, options = {}) => {
    if (String(options.method || 'GET').toUpperCase() === 'POST') {
      postCalls++;
      return new Response(JSON.stringify({ ok: true, data: radarData({ date: '2026-10-14' }) }));
    }
    return new Promise((resolve) => (releaseGet = () => resolve(new Response(JSON.stringify({ data: radarData({ date: '2026-10-12' }) })))));
  };
  const { client } = makeClient({ fetchImpl });
  const get = client.subscribe(); // 提交前的 GET
  const posted = await client.compute();
  assert.equal(posted.state, 'success');
  assert.equal(posted.data.date, '2026-10-14');
  releaseGet();
  assert.equal((await get.promise).state, 'superseded'); // 老 GET 结果按代次丢弃
  assert.equal(client.inspect().memory.data.date, '2026-10-14');
  const after = await client.subscribe().promise;
  assert.equal(after.state, 'ready');
  assert.equal(after.data.date, '2026-10-14'); // 成功后不跟随无必要 GET
  assert.equal(postCalls, 1);
});

test('POST is single-shot: no auto retry, no fallback, concurrent calls share one request', async () => {
  let postCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/compute')) {
      postCalls++;
      throw Error('network_down');
    }
    return new Response(JSON.stringify({ data: radarData() }));
  };
  const { client } = makeClient({ fetchImpl });
  const [a, b] = await Promise.all([client.compute(), client.compute()]);
  assert.equal(a, b); // 并发 compute 共享同一次 POST
  assert.equal(postCalls, 1);
  assert.equal(a.state, 'failure');
  assert.match(a.message, /结果未确认，请重新读取核实/);
  assert.equal(client.inspect().memory, null); // 失败不写缓存；旧快照交由上层保留
});

test('POST failure taxonomy: http error, business error and ok:true with null data', async () => {
  const cases = [
    { status: 500, body: JSON.stringify({ error: 'boom' }), expect: 'failure' },
    { status: 200, body: JSON.stringify({ ok: false, error: 'kv_locked' }), expect: 'failure' },
    { status: 200, body: JSON.stringify({ ok: true, data: null }), expect: 'no-result' },
    { status: 200, body: JSON.stringify({ ok: true, data: { ...radarData(), premiumSource: 'bad' } }), expect: 'failure' },
    { status: 200, body: '{oops', expect: 'failure' },
    { status: 200, body: JSON.stringify({ data: radarData() }), expect: 'failure' } // POST 严格要求 ok:true
  ];
  for (const { status, body, expect: expected } of cases) {
    let postCalls = 0;
    const fetchImpl = async (_url, options = {}) => {
      if (String(options.method || 'GET').toUpperCase() === 'POST') {
        postCalls++;
        return new Response(body, { status });
      }
      return new Response(JSON.stringify({ data: radarData() }));
    };
    const { client } = makeClient({ fetchImpl });
    const result = await client.compute();
    assert.equal(result.state, expected, body);
    assert.equal(postCalls, 1); // 不自动重试
    if (result.state === 'failure') assert.match(result.message, /结果未确认，请重新读取核实/);
    if (result.state === 'no-result') assert.match(result.message, /未返回有效结果/);
  }
});

test('explicit refresh bypasses memory within TTL; normal subscribe stays cached', async () => {
  let calls = 0;
  let releaseFetch;
  const fetchImpl = () => {
    calls++;
    return new Promise((resolve) => (releaseFetch = () => resolve(new Response(JSON.stringify({ data: radarData() })))));
  };
  const { client } = makeClient({ fetchImpl });
  const first = client.subscribe();
  releaseFetch();
  assert.equal((await first.promise).state, 'ready');
  // 普通订阅命中 memory；refresh 是明确刷新入口，跳过 memory 直读网络。
  await client.subscribe().promise;
  assert.equal(calls, 1);
  const second = client.subscribe({ refresh: true });
  releaseFetch();
  assert.equal((await second.promise).state, 'ready');
  assert.equal(calls, 2);
});

test('successful POST writes memory under the same key and skips follow-up GET', async () => {
  let getCalls = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (String(options.method || 'GET').toUpperCase() === 'POST') {
      return new Response(JSON.stringify({ ok: true, data: radarData({ date: '2026-10-14' }) }));
    }
    getCalls++;
    return new Response(JSON.stringify({ data: radarData({ date: '2026-10-13' }) }));
  };
  const { client } = makeClient({ fetchImpl });
  assert.equal((await client.subscribe().promise).state, 'ready');
  assert.equal(getCalls, 1);
  const posted = await client.compute();
  assert.equal(posted.state, 'success');
  assert.match(posted.message, /已强制计算并写入正式快照/);
  const after = await client.subscribe().promise;
  assert.equal(after.state, 'ready');
  assert.equal(after.data.date, '2026-10-14');
  assert.equal(getCalls, 1); // 直接用返回值，不额外 GET
});
