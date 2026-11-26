import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { accountEmailDeps, handleEmailStatus, handleEmailUseAccount } from '../src/notify/emailRoutes.js';

const account = { userId: 'u1', clientId: 'c1' };

test('account email from registration can be used as notify email', async (t) => {
  const db = openDb(':memory:');
  const original = accountEmailDeps.readAccountEmail;
  accountEmailDeps.readAccountEmail = (userId) => (userId === 'u1' ? 'alice@example.com' : '');
  t.after(() => { accountEmailDeps.readAccountEmail = original; db.close(); });

  assert.equal(handleEmailStatus(db, account).accountEmail, 'al***@example.com');
  const result = await handleEmailUseAccount(db, account, {});
  assert.equal(result.ok, true);
  assert.equal(result.email.verified, true);
  assert.equal(result.email.enabled, true);
  await assert.rejects(handleEmailUseAccount(db, { userId: 'u2', clientId: 'c2' }, {}), /ACCOUNT_EMAIL_MISSING|还没有绑定邮箱/);
});

test('verified account email takes over a notify email bound to another user', async (t) => {
  const db = openDb(':memory:');
  const original = accountEmailDeps.readAccountEmail;
  accountEmailDeps.readAccountEmail = () => 'shared@example.com';
  t.after(() => { accountEmailDeps.readAccountEmail = original; db.close(); });
  await handleEmailUseAccount(db, account, {});
  const rebound = await handleEmailUseAccount(db, { userId: 'u2', clientId: 'c2' }, {});
  assert.equal(rebound.ok, true);
});
