import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { syntheticProjection } from '../helpers/etfPcfSharesFixture.mjs';
import { confirmedSharesCalendar } from '../../shared/etfPcfTradingCalendar.js';
import { mockAcceptanceNetwork } from './acceptance-helpers.js';
test.use({ video: 'off' });
if (existsSync('/opt/meta-chromium/chrome'))
  test.use({ launchOptions: { executablePath: '/opt/meta-chromium/chrome', args: ['--no-sandbox'] } });
async function setup(page, { admin = true, state = 'snapshot', hold = false, liveDates = false } = {}) {
  await mockAcceptanceNetwork(page);
  // Serve local build bytes through interception so this offline test does not
  // depend on the managed Chromium's loopback network permissions.
  await page.route('http://127.0.0.1:4173/**', async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve('.frontend-build', `.${pathname}`);
    if (!file.startsWith(resolve('.frontend-build') + '/')) return route.abort();
    await route.fulfill({ path: existsSync(file) ? file : resolve('.frontend-build/index.html') });
  });
  await page.addInitScript(
    ({ admin }) => {
      localStorage.setItem(
        'aiDcaCloudSyncSession',
        JSON.stringify({
          username: admin ? 'lovexl' : 'ordinary',
          userId: 'synthetic-admin',
          accessToken: 'synthetic-token',
          isAdmin: admin
        })
      );
    },
    { admin }
  );
  const counts = { shares: 0, radar: 0, compute: 0, heavy: 0, details: 0 };
  await page.route('**/api/etf-pcf-limit?*', async (route) => {
    counts.details++;
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({
      json: {
        code: params.get('code'),
        date: params.get('date'),
        source: 'szse_pcf',
        prevDayDate: '2026-10-09',
        prevDayNav: 1.2345,
        prevDayUnitNav: 1234500,
        prevDayCashDifference: 100,
        subscriptionAllowed: true,
        redemptionAllowed: false,
        totalSubscribeLimitShares: 10000000,
        totalRedeemLimitShares: null,
        netSubscribeLimitShares: null,
        netRedeemLimitShares: null,
        creationRedemptionUnitShares: 1000000,
        cashSubstitutionRatioLimitPct: 50,
        estimatedCashDifference: 200,
        iopvRequired: true,
        expiresAt: new Date(Date.now() + 300000).toISOString()
      }
    });
  });
  let mode = state,
    release;
  const wait = new Promise((resolve) => (release = resolve));
  await page.route('**/api/etf-pcf-shares*', async (route) => {
    counts.shares++;
    if (hold) await wait;
    const data = syntheticProjection({
      fetchedAt: new Date(Date.now() - 1000).toISOString(),
      partial: mode === 'partial',
      ...(liveDates
        ? {
            date: '2026-10-13',
            prevDate: '2026-10-12',
            tradingCalendar: confirmedSharesCalendar('2026-10-04', '2026-10-14')
          }
        : {})
    });
    data.pcfSnapshot = { source: 'szse_pcf', date: data.availableOn, codes: ['159941'] };
    await route.fulfill({
      status: mode === 'error' ? 503 : ['empty', 'missing'].includes(mode) ? 404 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        mode === 'error'
          ? { reason: 'kv_unavailable' }
          : mode === 'empty'
            ? { reason: 'cache_miss' }
            : mode === 'missing'
              ? { reason: 'missing_report_date' }
              : data
      )
    });
  });
  await page.route('**/api/notify/nasdaq-radar*', async (route) => {
    if (route.request().method() === 'POST') counts.compute++;
    else counts.radar++;
    await route.fulfill({ json: { data: null } });
  });
  // These must never be introduced by the shares panel.
  page.on('request', (request) => {
    if (
      /\/api\/.*(kline|nav-history|nav-snapshot|financial|raw-detail|ai-summary|fund-limit)/.test(
        request.url()
      )
    )
      counts.heavy++;
  });
  await page.goto('./index.html?tab=adminRadar');
  return { counts, release, setMode: (value) => (mode = value) };
}
test('admin tabs load only active shares, cache repeated switches, keyboard ARIA and mobile cards', async ({
  page
}) => {
  const { counts } = await setup(page, { liveDates: true });
  const shares = page.getByRole('tab', { name: '份额新增', exact: true });
  await expect(shares).toBeVisible();
  expect(counts.shares).toBe(0);
  await shares.click();
  await expect(page.getByText('2026-10-14 PCF 快照，份额统计截至 2026-10-13')).toBeVisible();
  await expect(page.getByText('份额统计基准日：', { exact: false })).toBeVisible();
  await expect(page.getByText('净变动 · 推算申购').first()).toBeVisible();
  await expect(page.getByText('本期总份额').first()).toBeVisible();
  await expect(page.getByText('上期总份额').first()).toBeVisible();
  await expect(page.getByText(/更新及时性待确认/)).toHaveCount(0);
  const radarBefore = counts.radar;
  await expect(page.getByText('顶格 100%')).toBeVisible();
  expect(counts.shares).toBe(1);
  expect(counts.radar).toBe(radarBefore);
  await shares.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '套利雷达', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByRole('tab', { name: '套利雷达', exact: true }).press('ArrowRight');
  await expect(shares).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('超限 125%')).toBeVisible();
  expect(counts.shares).toBe(1);
  expect(counts.compute).toBe(0);
  expect(counts.heavy).toBe(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByText('新增金额设计决策 (v1)：', { exact: false })).toBeVisible();
    await page.screenshot({ path: `test-results/shares-ui-${width}.png`, fullPage: true });
  }
});
for (const state of ['error', 'empty', 'partial', 'missing'])
  test(`shares ${state} state`, async ({ page }) => {
    const harness = await setup(page, { state });
    await page.getByRole('tab', { name: '份额新增', exact: true }).click();
    const texts = {
      error: '份额快照读取失败',
      empty: '暂无已验证份额快照',
      partial: '数据待确认',
      missing: '报表缺少数据日期，暂无法计算份额新增'
    };
    await expect(page.getByText(texts[state], { exact: true }).first()).toBeVisible();
    if (state === 'error') {
      harness.setMode('snapshot');
      await page.getByRole('button', { name: /重试读取快照|刷新重试/ }).click();
      await expect(page.getByText('顶格 100%')).toBeVisible();
      expect(harness.counts.shares).toBe(2);
    }
    expect(harness.counts.compute).toBe(0);
    expect(harness.counts.heavy).toBe(0);
  });
test('loading and rapid switch release prevents old response consumption', async ({ page }) => {
  const harness = await setup(page, { hold: true });
  await page.getByRole('tab', { name: '份额新增', exact: true }).click();
  await expect(page.getByText('正在读取深交所 PCF 份额快照…')).toBeVisible();
  await page.getByRole('tab', { name: '套利雷达', exact: true }).click();
  harness.release();
  await expect(page.getByText('数据日期：2026-10-12 · 对比日期：2026-10-09')).toHaveCount(0);
});
test('non-admin makes zero shares/radar/compute requests', async ({ page }) => {
  const { counts } = await setup(page, { admin: false });
  await expect(page.getByRole('tab', { name: '份额新增', exact: true })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(counts.shares).toBe(0);
  expect(counts.radar).toBe(0);
  expect(counts.compute).toBe(0);
});
test('offline demo states and screenshots have no page overflow at 1440/390/320', async ({ page }) => {
  // Served as a static asset by preview; also works directly from file://.
  await page.goto(pathToFileURL(resolve('docs/demos/etf-pcf-shares-tab/index.html')).href);
  await page.getByRole('tab', { name: '份额新增', exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/shares-demo-${width}.png`, fullPage: true });
  }
});

test('expired local TTL revalidates once; read failure keeps unexpired last snapshot with stale banner', async ({
  page
}) => {
  const data = syntheticProjection({ fetchedAt: new Date(Date.now() - 600000).toISOString() });
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(Date.now());
  const key = `etf-pcf-shares:v2:/api/etf-pcf-shares:${day}:latest`;
  await page.addInitScript(
    ({ key, data }) =>
      localStorage.setItem(key, JSON.stringify({ key, receivedAt: Date.now() - 600000, data })),
    { key, data }
  );
  const { counts } = await setup(page, { state: 'error' });
  await page.getByRole('tab', { name: '份额新增', exact: true }).click();
  await expect(page.getByText('读取失败，展示上次快照')).toBeVisible();
  await expect(page.getByText('顶格 100%')).toBeVisible();
  expect(counts.shares).toBe(1);
  expect(counts.compute).toBe(0);
  expect(counts.heavy).toBe(0);
});

test('visible snapshot becomes stale at client TTL without polling; user retry makes one read', async ({
  page
}) => {
  await page.clock.install({ time: new Date() });
  const { counts } = await setup(page);
  await page.getByRole('tab', { name: '份额新增', exact: true }).click();
  await expect(page.getByText('顶格 100%')).toBeVisible();
  await page.clock.fastForward(300001);
  await expect(page.getByText('本地缓存待重新确认')).toBeVisible();
  expect(counts.shares).toBe(1);
  await page.getByRole('button', { name: /重试读取快照|刷新重试/ }).click();
  await expect(page.getByText('本地缓存待重新确认')).toHaveCount(0);
  expect(counts.shares).toBe(2);
  expect(counts.compute).toBe(0);
  expect(counts.heavy).toBe(0);
});

test('filters, search, amount collapse and on-demand T/P detail keep list reads light', async ({ page }) => {
  const { counts } = await setup(page);
  await page.getByRole('tab', { name: '份额新增', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '份额新增' });
  await expect(panel.locator('tbody .shares-row')).toHaveCount(13);
  expect(counts.details).toBe(0);
  await expect(panel.getByRole('columnheader', { name: '新增金额估算' })).toHaveCount(0);
  await panel.getByRole('button', { name: '新增金额：智能折叠' }).click();
  await expect(panel.getByRole('columnheader', { name: '新增金额估算' })).toBeVisible();
  await expect(panel.locator('tbody .shares-row').first().getByText('待官方净值').first()).toBeVisible();
  await panel.getByRole('button', { name: '顶格 / 接近 2', exact: true }).click();
  await expect(panel.locator('tbody .shares-row')).toHaveCount(2);
  await panel.getByRole('button', { name: '全部标的 13', exact: true }).click();
  await panel.getByRole('textbox', { name: '搜索代码或简称' }).fill('does-not-exist');
  await expect(panel.getByText('未找到符合条件的 ETF 标的')).toBeVisible();
  await panel.getByRole('textbox', { name: '搜索代码或简称' }).fill('159501');
  await expect(panel.locator('tbody .shares-row')).toHaveCount(1);
  await panel.getByRole('button', { name: '明细', exact: true }).click();
  await expect(panel.getByText('T 日即时申赎规则与上限控制')).toBeVisible();
  await expect(panel.getByText('P 日前一交易日清算基准')).toBeVisible();
  await expect(panel.getByText('✓ 允许申购')).toBeVisible();
  await expect(panel.getByText('✕ 暂停赎回')).toBeVisible();
  expect(counts.details).toBe(1);
  await panel.getByRole('button', { name: '收起', exact: true }).click();
  await panel.getByRole('button', { name: '明细', exact: true }).click();
  await expect(panel.getByText('T 日即时申赎规则与上限控制')).toBeVisible();
  expect(counts.details).toBe(1);
  await panel.getByRole('textbox', { name: '搜索代码或简称' }).fill('513100');
  await panel.getByRole('button', { name: '明细', exact: true }).click();
  await expect(panel.getByText('该标的为上交所 (SSE) 跨市场 ETF')).toBeVisible();
  expect(counts.details).toBe(1);
  await panel.getByRole('button', { name: '移动端卡片看板视图' }).click();
  await expect(panel.locator('.card-kpi-row')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panel.getByRole('button', { name: '收起 PCF 明细' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(counts.shares).toBe(1);
  expect(counts.heavy).toBe(0);
});
