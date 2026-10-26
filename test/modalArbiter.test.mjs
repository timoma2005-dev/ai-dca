import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockingConfirmOpen, setBlockingConfirmOpen, shouldAutoOpenLoginSync, subscribeBlockingConfirm } from '../src/app/modalArbiter.js';

test('confirm dialog state is tracked and broadcast only on change', () => {
  const seen = [];
  const off = subscribeBlockingConfirm((open) => seen.push(open));
  setBlockingConfirmOpen(true);
  setBlockingConfirmOpen(true);
  assert.equal(isBlockingConfirmOpen(), true);
  setBlockingConfirmOpen(false);
  assert.equal(isBlockingConfirmOpen(), false);
  assert.deepEqual(seen, [true, false]);
  off();
  setBlockingConfirmOpen(true);
  assert.deepEqual(seen, [true, false]);
  setBlockingConfirmOpen(false);
});

test('login-sync auto open only for non-silent (login flow / manual reopen)', () => {
  assert.equal(shouldAutoOpenLoginSync({ silent: true }), false);
  assert.equal(shouldAutoOpenLoginSync({ silent: false }), true);
  assert.equal(shouldAutoOpenLoginSync(undefined), true);
});
