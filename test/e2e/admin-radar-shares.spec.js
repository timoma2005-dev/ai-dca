import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { syntheticProjection } from '../helpers/etfPcfSharesFixture.mjs';
import { mockAcceptanceNetwork } from './acceptance-helpers.js';
test.use({ video: 'off' });
if (existsSync('/opt/meta-chromium/chrome'))
  test.use({ launchOptions: { executablePath: '/opt/meta-chromium/chrome', args: ['--no-sandbox'] } });
async function setup(page, { admin = true, state = 'snapshot', hold = false } = {}) {
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
  const counts = { shares: 0, radar: 0, compute: 0, heavy: 0 };
  let mode = state,
    release;
  const wait = new Promise((resolve) => (release = resolve));
  await page.route('**/api/etf-pcf-shares*', async (route) => {
    counts.shares++;
    if (hold) await wait;
    const data = syntheticProjection({
      fetchedAt: new Date(Date.now() - 1000).toISOString(),
      partial: mode === 'partial'
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
  const { counts } = await setup(page);
  const shares = page.getByRole('tab', { name: '份额新增', exact: true });
  await expect(shares).toBeVisible();
  expect(counts.shares).toBe(0);
  await shares.click();
  await expect(page.getByText(/PCF 快照，份额统计截至 2026-10-12/)).toBeVisible();
  await expect(
    page.getByText('份额统计日期：2026-10-12 · 对比日期：2026-10-09', { exact: false })
  ).toBeVisible();
  await expect(page.getByText('统计日申购（份，推算）').first()).toBeVisible();
  await expect(page.getByText('本期份额（统计 10-12）').first()).toBeVisible();
  const radarBefore = counts.radar;
  await expect(page.getByText('是（100% 精确相等）')).toBeVisible();
  expect(counts.shares).toBe(1);
  expect(counts.radar).toBe(radarBefore);
  await shares.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '套利雷达', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByRole('tab', { name: '套利雷达', exact: true }).press('ArrowRight');
  await expect(shares).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('否（超过上限观测 125%）')).toBeVisible();
  expect(counts.shares).toBe(1);
  expect(counts.compute).toBe(0);
  expect(counts.heavy).toBe(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByText('新增金额暂缺 D 日净值日期证据，不拿实时行情/IOPV 凑数。')).toBeVisible();
    await page.screenshot({ path: `test-results/shares-ui-${width}.png`, fullPage: true });
  }
});
for (const state of ['error', 'empty', 'partial', 'missing'])
  test(`shares ${state} state`, async ({ page }) => {
    const harness = await setup(page, { state });
    await page.getByRole('tab', { name: '份额新增', exact: true }).click();
    const texts = {
      error: '份额快照读取失败，请稍后重试',
      empty: '暂无已验证份额快照，等待定时任务更新',
      partial: '缺少可确认的上一交易日份额，暂无法计算新增',
      missing: '报表缺少数据日期，暂无法计算份额新增'
    };
    await expect(page.getByText(texts[state]).first()).toBeVisible();
    if (state === 'error') {
      harness.setMode('snapshot');
      await page.getByRole('button', { name: '重试读取' }).click();
      await expect(page.getByText('是（100% 精确相等）')).toBeVisible();
      expect(harness.counts.shares).toBe(2);
    }
    expect(harness.counts.compute).toBe(0);
    expect(harness.counts.heavy).toBe(0);
  });
test('loading and rapid switch release prevents old response consumption', async ({ page }) => {
  const harness = await setup(page, { hold: true });
  await page.getByRole('tab', { name: '份额新增', exact: true }).click();
  await expect(page.getByText('正在读取份额快照…')).toBeVisible();
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
  const key = `etf-pcf-shares:v2:https://api.freebacktrack.tech/api/etf-pcf-shares:${day}:latest`;
  await page.addInitScript(
    ({ key, data }) =>
      localStorage.setItem(key, JSON.stringify({ key, receivedAt: Date.now() - 600000, data })),
    { key, data }
  );
  const { counts } = await setup(page, { state: 'error' });
  await page.getByRole('tab', { name: '份额新增', exact: true }).click();
  await expect(page.getByText('读取失败，展示上次快照')).toBeVisible();
  await expect(page.getByText('是（100% 精确相等）')).toBeVisible();
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
  await expect(page.getByText('是（100% 精确相等）')).toBeVisible();
  await page.clock.fastForward(300001);
  await expect(page.getByText('本地缓存待重新确认')).toBeVisible();
  expect(counts.shares).toBe(1);
  await page.getByRole('button', { name: '重试读取' }).click();
  await expect(page.getByText('本地缓存待重新确认')).toHaveCount(0);
  expect(counts.shares).toBe(2);
  expect(counts.compute).toBe(0);
  expect(counts.heavy).toBe(0);
});
