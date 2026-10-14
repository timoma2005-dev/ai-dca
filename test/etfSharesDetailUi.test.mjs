import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';

test('份额详情手风琴：键盘展开、快照日期、取消、重试、空缓存及移动端布局', async (t) => {
  const data = syntheticProjection();
  data.expiresAt = new Date(Date.now() + 3600000).toISOString();
  const bundle = await build({
    stdin: { contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import Panel from './src/pages/EtfPcfSharesPanel.jsx';
      import { sharesClient } from './src/app/etfPcfSharesClient.js';
      sharesClient.subscribe = () => ({ promise: Promise.resolve({state:'partial', data:${JSON.stringify(data)}, receivedAt:Date.now()}), release(){} });
      createRoot(document.getElementById('root')).render(<Panel />);`, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, outfile: 'app.js', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }
  });
  const server = createServer((req, res) => {
    const file = bundle.outputFiles.find((f) => f.path.endsWith(req.url === '/app.css' ? '.css' : '.js'));
    res.setHeader('Content-Type', req.url === '/' ? 'text/html' : req.url === '/app.css' ? 'text/css' : 'text/javascript');
    res.end(req.url === '/' ? '<link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>' : file.contents);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => { console.error(error); });
  const requests = [];
  let mode = 'pending', pending;
  await page.route('**/api/etf-pcf-limit?*', async (route) => {
    requests.push(route.request());
    if (mode === 'pending') { pending = route; return; }
    const query = new URL(route.request().url()).searchParams;
    await route.fulfill({ status: mode === 'error' ? 503 : mode === 'empty' ? 404 : 200,
      contentType: 'application/json', body: JSON.stringify(mode === 'empty' ? { reason: 'cache_miss' } : mode === 'error' ? {} : {
        code: query.get('code'), date: query.get('date'), source: query.get('code').startsWith('159') ? 'szse_pcf' : 'sse_pcf',
        prevDayDate: '2026-10-09', prevDayNav: 1.5499, prevDayCashDifference: 5388,
        estimatedCashDifference: 4275.36, totalSubscribeLimitShares: null, netSubscribeLimitShares: null
      }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const toggles = page.locator('button[aria-expanded]');
  await toggles.first().waitFor();
  assert.equal(requests.length, 0);
  await toggles.first().focus(); await page.keyboard.press('Enter');
  await page.getByText('正在读取申赎信息…').waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-expanded="true"]'));
  // Wait for the intercepted fetch to reach its handler.
  await page.waitForTimeout(50);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method(), 'GET');
  assert.equal(new URL(requests[0].url()).searchParams.get('date'), data.date);
  await toggles.first().click();
  assert.equal(await page.locator('[role="region"]').count(), 0);
  await pending.abort().catch(() => {});
  mode = 'ready';
  await toggles.first().click();
  await page.getByText('1.5499', { exact: true }).waitFor();
  const region = page.getByRole('region');
  assert.equal(await region.getAttribute('aria-labelledby'), await toggles.first().getAttribute('id'));
  assert.equal(await region.locator('h4').count(), 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  mode = 'error'; await toggles.nth(1).click();
  await page.getByText('申赎信息读取失败，可点击重试').waitFor();
  assert.equal(await page.locator('[aria-expanded="true"]').count(), 1);
  const count = requests.length;
  await page.waitForTimeout(50); assert.equal(requests.length, count);
  mode = 'empty'; await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('暂无该日期的申赎缓存数据，等待更新').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(requests.every((r) => r.method() === 'GET'));
});
