import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { runAccountMenuClickChecks } from './helpers/accountMenuClickHarness.mjs';

test('superadmin avatar opens the controlled AccountMenu with full roles and with a legacy session', async (t) => {
  const results = await runAccountMenuClickChecks(JSDOM);
  for (const result of results) t.diagnostic(result);
});
