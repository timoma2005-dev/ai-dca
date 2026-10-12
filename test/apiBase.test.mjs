import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apiUrl, apiUrlDirect, isDirectApiPath, apiUrlWithFallback, fetchWithFallback, wsApiUrl } from '../src/app/apiBase.js';

const DIRECT_ORIGIN = 'https://api.freebacktrack.tech';

test('isDirectApiPath routes user-related prefixes to direct origin', () => {
  assert.equal(isDirectApiPath('/api/account/v1/trades'), true);
  assert.equal(isDirectApiPath('/api/sync/auth/login'), true);
  assert.equal(isDirectApiPath('/api/notify/status'), true);
  assert.equal(isDirectApiPath('/api/holdings/ocr'), true);
  assert.equal(isDirectApiPath('/api/holdings/nav-history'), true);
});

test('isDirectApiPath matches /api/ocr exactly without catching sibling paths', () => {
  assert.equal(isDirectApiPath('/api/ocr'), true);
  assert.equal(isDirectApiPath('/api/ocr?x=1'), true);
  assert.equal(isDirectApiPath('/api/ocr/extra'), false);
  assert.equal(isDirectApiPath('/api/ocrx'), false);
});

test('isDirectApiPath keeps public data paths on the cn proxy', () => {
  assert.equal(isDirectApiPath('/api/markets/quotes'), false);
  assert.equal(isDirectApiPath('/api/market-collector/x'), false);
  assert.equal(isDirectApiPath('/api/fund-fee'), false);
  assert.equal(isDirectApiPath('/api/geo'), false);
});

test('apiUrlDirect always returns the absolute direct-origin URL', () => {
  assert.equal(apiUrlDirect('/api/notify/status'), `${DIRECT_ORIGIN}/api/notify/status`);
  assert.equal(apiUrlDirect('/api/notify/status', { a: 1 }), `${DIRECT_ORIGIN}/api/notify/status?a=1`);
  assert.equal(apiUrlDirect('api/ocr'), `${DIRECT_ORIGIN}/api/ocr`);
});

test('apiUrlDirect skips empty query values the same way as apiUrl', () => {
  assert.equal(
    apiUrlDirect('/api/sync/latest', { a: undefined, b: null, c: '' }),
    `${DIRECT_ORIGIN}/api/sync/latest`
  );
});

test('apiUrl keeps relative paths for non user-related requests', () => {
  assert.equal(apiUrl('/api/markets/quotes'), '/api/markets/quotes');
  assert.equal(apiUrl('/api/fund-fee', { refresh: 1 }), '/api/fund-fee?refresh=1');
});

test('wsApiUrl keeps notification sockets on the cn host', () => {
  assert.equal(wsApiUrl('/api/notify/ws/device-1'), 'ws://localhost/api/notify/ws/device-1');
});

test('wsApiUrl keeps legacy host resolution for non direct paths', () => {
  assert.equal(wsApiUrl('/api/markets/ws'), 'ws://localhost/api/markets/ws');
});

test('apiUrl keeps user data and auth paths relative with no configured origin', () => {
  assert.equal(apiUrl('/api/account/v1'), '/api/account/v1');
  assert.equal(apiUrl('/api/sync/auth/login'), '/api/sync/auth/login');
  assert.deepEqual(apiUrlWithFallback('/api/notify/status', { a: 1 }), {
    primary: '/api/notify/status?a=1', fallback: `${DIRECT_ORIGIN}/api/notify/status?a=1`
  });
});

for (const scenario of ['success', '500', 'network', '404', 'fallback failure']) {
  test(`GET fallback: ${scenario}`, async (t) => {
    const urls = apiUrlWithFallback('/api/notify/status');
    const calls = [];
    const primary = new Response('', { status: scenario === '500' ? 500 : scenario === '404' ? 404 : 200 });
    const fallback = new Response('replica');
    const error = new TypeError('Failed to fetch');
    const options = { headers: { authorization: 'Bearer token' } };
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push(url);
      assert.equal(init, options);
      if (url === urls.primary) {
        if (scenario === 'network' || scenario === 'fallback failure') throw error;
        return primary;
      }
      if (scenario === 'fallback failure') throw error;
      return fallback;
    });
    if (scenario === 'fallback failure') await assert.rejects(fetchWithFallback(urls, options), (e) => e === error);
    else assert.equal(await fetchWithFallback(urls, options), ['500', 'network'].includes(scenario) ? fallback : primary);
    assert.deepEqual(calls, ['500', 'network', 'fallback failure'].includes(scenario) ? [urls.primary, urls.fallback] : [urls.primary]);
  });
}

for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
  test(`${method} never falls back on network errors or 5xx`, async (t) => {
    const urls = apiUrlWithFallback('/api/account/v1');
    const error = new TypeError('Failed to fetch');
    const response = new Response('', { status: 503 });
    let fail = true;
    const mock = t.mock.method(globalThis, 'fetch', async (url) => {
      assert.equal(url, urls.primary);
      if (fail) throw error;
      return response;
    });
    await assert.rejects(fetchWithFallback(urls, { method }), (e) => e === error);
    fail = false;
    assert.equal(await fetchWithFallback(urls, { method }), response);
    assert.equal(mock.mock.callCount(), 2);
  });
}

test('cancelled GET does not attempt the replica', async (t) => {
  const controller = new AbortController();
  controller.abort();
  const error = new DOMException('Aborted', 'AbortError');
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw error; });
  await assert.rejects(fetchWithFallback(apiUrlWithFallback('/api/notify/status'), { signal: controller.signal }), (e) => e === error);
  assert.equal(mock.mock.callCount(), 1);
});

test('account reads use the replica on 5xx while writes stay on cn', async (t) => {
  const { sendAccountApiRequest } = await import('../src/app/accountApi.js');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init.method]);
    return new Response('{}', { status: String(url).startsWith(DIRECT_ORIGIN) ? 200 : 503 });
  });
  await sendAccountApiRequest('/health');
  await assert.rejects(sendAccountApiRequest('/plans', { method: 'PUT', body: {} }), (e) => e.status === 503);
  assert.deepEqual(calls, [
    ['/api/account/v1/health', 'GET'],
    [`${DIRECT_ORIGIN}/api/account/v1/health`, 'GET'],
    ['/api/account/v1/plans', 'PUT']
  ]);
});

test('auth reads stay on cn even when cn returns 5xx', async (t) => {
  const { __internals } = await import('../src/app/authClient.js');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return new Response('{}', { status: 503 });
  });
  await assert.rejects(__internals.requestSync('/auth/me', { method: 'GET' }), (e) => e.status === 503);
  assert.deepEqual(calls, ['/api/sync/auth/me']);
});
