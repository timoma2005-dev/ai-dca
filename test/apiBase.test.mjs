import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apiUrl, apiUrlDirect, isDirectApiPath, wsApiUrl } from '../src/app/apiBase.js';

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

test('wsApiUrl upgrades direct paths to wss on the direct origin', () => {
  assert.equal(wsApiUrl('/api/notify/ws/device-1'), 'wss://api.freebacktrack.tech/api/notify/ws/device-1');
});

test('wsApiUrl keeps legacy host resolution for non direct paths', () => {
  assert.equal(wsApiUrl('/api/markets/ws'), 'ws://localhost/api/markets/ws');
});
