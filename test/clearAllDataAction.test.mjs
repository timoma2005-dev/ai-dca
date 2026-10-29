import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { runClearAllDataAction } from '../src/app/clearAllDataAction.js';

function installDomGlobals(dom) {
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    CustomEvent: dom.window.CustomEvent
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  };
}

test('clear-all action waits for the danger confirmation and clears after approval', async () => {
  const dom = new JSDOM('', { url: 'https://fast.example/' });
  const restore = installDomGlobals(dom);
  try {
    const ledgerKey = 'aiDcaFundHoldingsLedger';
    window.localStorage.setItem(ledgerKey, JSON.stringify({ transactions: [{ id: 'tx-1' }] }));
    window.localStorage.setItem('aiDcaTradeLedger', JSON.stringify([{ id: 'trade-1' }]));

    let confirmRequest;
    const requestReady = new Promise((resolve) => {
      window.addEventListener('aidca:confirm', (event) => {
        confirmRequest = event.detail;
        resolve();
      }, { once: true });
    });
    let stateRefreshed = false;
    const action = runClearAllDataAction({
      transactions: [{ id: 'tx-1' }],
      aggregates: [{ code: '510300' }],
      tradeLedgerEntries: [],
      onCleared: () => { stateRefreshed = true; }
    });

    await requestReady;
    assert.equal(confirmRequest.tone, 'danger');
    assert.equal(confirmRequest.confirmText, '确认执行');
    assert.match(confirmRequest.description, /1 笔交易记录/);
    assert.match(confirmRequest.description, /1 只基金持仓/);
    assert.equal(stateRefreshed, false, 'the app state stays intact while confirmation is pending');

    confirmRequest.resolve(true);
    await action;

    assert.equal(window.localStorage.getItem(ledgerKey), null);
    assert.equal(window.localStorage.getItem('aiDcaTradeLedger'), null);
    assert.equal(stateRefreshed, true);
  } finally {
    restore();
  }
});
