import { expect, test } from '@playwright/test';
import { MOBILE_VIEWPORT } from './acceptance-helpers.js';

const LEDGER_KEY = 'aiDcaFundHoldingsLedger';
const ledgerFixture = {
  source: 'react-fund-holdings-ledger',
  version: 3,
  transactions: [
    {
      id: 'clear-data-mobile-regression',
      code: '510300',
      name: '清空回归测试基金',
      kind: 'exchange',
      type: 'BUY',
      date: '2026-10-28',
      price: 4.2,
      shares: 100,
      note: ''
    }
  ],
  migratedFromLegacy: false,
  legacyMigrationAt: '',
  switchChains: [],
  transactionCodeCount: 1
};

test('mobile holdings FAB clears local data after confirming, even though its menu closes', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.addInitScript(({ key, ledger }) => {
    window.localStorage.setItem(key, JSON.stringify(ledger));
  }, { key: LEDGER_KEY, ledger: ledgerFixture });
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}'
  }));

  await page.goto('./index.html?tab=holdings');
  await expect(page.getByText('清空回归测试基金').first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.locator('.fab-above-bottom-nav').getByRole('button', { name: '清除数据' }).click();

  const confirmDialog = page.getByRole('dialog');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText('1 笔交易记录');
  await expect(confirmDialog).toContainText('1 只基金持仓');
  await page.getByRole('button', { name: '确认执行' }).click();

  await expect(confirmDialog).toBeHidden();
  await expect(page.getByText('清空回归测试基金')).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return 0;
    return JSON.parse(raw)?.transactions?.length ?? -1;
  }, LEDGER_KEY)).toBe(0);
});
