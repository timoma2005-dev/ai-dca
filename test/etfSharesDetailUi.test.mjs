/* global HashChangeEvent, URL, console, dispatchEvent, document, history, innerWidth, process */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';

test('份额面板 UI 重构：宽表/卡片双布局、键盘展开、快照日期、取消、重试、空缓存、沪市短路', async (t) => {
  const data = syntheticProjection();
  data.expiresAt = new Date(Date.now() + 3600000).toISOString();
  Object.assign(data.records[0], {
    shares: 7077986575,
    prevShares: 7072986575,
    deltaShares: 5000000,
    limitDate: '2026-10-16',
    totalLimitKind: 'limited',
    totalLimitShares: 100000000,
    utilization: 0.05,
    atLimit: false,
    nearTotalLimit: false,
    creationShares: 5000000,
    creationSharesKind: 'estimate'
  });
  Object.assign(data.records[1], {
    deltaShares: 0,
    totalLimitKind: 'limited',
    totalLimitShares: 5000000,
    utilization: 0,
    atLimit: false,
    nearTotalLimit: false,
    creationShares: 0,
    creationSharesKind: 'exact'
  });
  Object.assign(data.records[2], {
    deltaShares: null,
    shares: null,
    prevShares: null,
    totalLimitKind: 'unknown',
    limitDate: null,
    utilization: null,
    atLimit: null,
    nearTotalLimit: null
  });
  Object.assign(data.records.find((r) => !r.code.startsWith('159')), {
    totalLimitKind: 'limited',
    totalLimitShares: 10000000,
    atLimit: true,
    utilization: 1,
    nearTotalLimit: true
  });
  const bundle = await build({
    stdin: { contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import Panel from './src/pages/EtfPcfSharesPanel.jsx';
      import Admin from './src/pages/AdminRadarExperience.jsx';
      import { sharesClient } from './src/app/etfPcfSharesClient.js';
      sharesClient.subscribe = () => ({ promise: Promise.resolve({state:'partial', data:${JSON.stringify(data)}, receivedAt:Date.now()}), release(){} });
      createRoot(document.getElementById('root')).render(location.search.includes('admin') ? <Admin session={{isAdmin:!location.search.includes('denied')}} /> : <Panel />);`, resolveDir: process.cwd(), loader: 'jsx' },
    alias: { '@': process.cwd() + '/src' },
    bundle: true, write: false, outfile: 'app.js', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }
  });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = bundle.outputFiles.find((f) => f.path.endsWith(pathname === '/app.css' ? '.css' : '.js'));
    res.setHeader('Content-Type', pathname === '/' ? 'text/html' : pathname === '/app.css' ? 'text/css' : 'text/javascript');
    res.end(pathname === '/' ? '<link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>' : file.contents);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
  // 首次列表展示不请求任何 PCF 详情。
  assert.equal(requests.length, 0);
  // 宽表 10 列（含详情展开列），排序指示通过 aria-sort 表达。
  assert.deepEqual(await page.locator('thead th').allTextContents(), [
    '代码', '名称', '份额增量', '盘前净新增份额', '顶格状态', '本期总份额', '上期总份额', '累计申购上限', '限额日期', '详情'
  ]);
  assert.equal(await page.locator('th[aria-sort="none"]').count(), 4);
  const row = (code) => page.locator('tr.shares-row').filter({ hasText: code });
  const cells = (code) => row(code).locator('td');
  assert.deepEqual((await cells(data.records[0].code).allTextContents()).slice(0, 4), [
    `深${data.records[0].code}`,
    data.records[0].name,
    '500.00 万份',
    '约 500 万估算'
  ]);
  assert.deepEqual((await cells(data.records[0].code).allTextContents()).slice(4), [
    '未顶格 5%', '7,077,986,575', '7,072,986,575', '1.00 亿份', '2026-10-16', ''
  ]);
  assert.equal(await cells('159509').nth(2).textContent(), '0 份');
  assert.equal(await cells('159509').nth(3).textContent(), '0 万确定');
  assert.equal(await cells('159509').nth(7).textContent(), '500 万份');
  assert.equal(await cells('159513').nth(2).textContent(), '—');
  assert.equal(await cells('159513').nth(5).textContent(), '—');
  assert.equal(await cells('159513').nth(7).textContent(), '—');
  assert.equal(await cells('159513').nth(8).textContent(), '—');
  assert.equal(await cells('159513').nth(4).textContent(), '数据待确认');
  assert.equal(await cells('159632').nth(4).textContent(), '净流出');
  assert.equal(await cells('513100').nth(4).textContent(), '沪市待接入');
  // 数据口径 Pills 与快照说明。
  const pillText = await page.locator('.shares-pill-row').textContent();
  assert.match(pillText, /日期不一，见各行/);
  assert.match(pillText, /报表推导 \(10-12\)/);
  assert.match(pillText, /统计日快照 \(10-12\)/);
  assert.match(pillText, /上一统计日快照 \(10-09\)/);
  const caption = await page.locator('.shares-caption').textContent();
  assert.match(caption, /份额统计截至 2026-10-12，PCF 快照日期暂无/);
  assert.match(caption, /2026-10-13 09:03:20/);
  assert.equal(await page.locator('.stale-warning-banner').count(), 1);
  assert.match(await page.locator('.status-indicator-chip').textContent(), /数据滞后待确认/);
  // 顶部 3 统计卡片：总数、顶格/接近、合计净新增（注明有效样本数）。
  assert.deepEqual(await page.locator('.stat-value').allTextContents(), ['13', '1', '+600.00']);
  assert.match(await page.locator('.stat-caption').nth(2).textContent(), /有效深市样本 7 只 · 净流入 2\/7/);
  // 键盘展开详情：Enter 触发、按需请求、快照日期作为请求参数。
  await toggles.first().focus(); await page.keyboard.press('Enter');
  await page.getByText('正在读取申赎信息…').waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-expanded="true"]'));
  await page.waitForTimeout(50);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method(), 'GET');
  assert.equal(new URL(requests[0].url()).searchParams.get('date'), data.date);
  // 关闭即卸载释放，抽屉不再渲染。
  await toggles.first().click();
  assert.equal(await page.locator('[aria-labelledby]').count(), 0);
  await pending.abort().catch(() => {});
  mode = 'ready';
  await toggles.first().click();
  await page.getByText('1.5499', { exact: true }).waitFor();
  const region = page.locator(`#shares-detail-${data.records[0].code}`);
  assert.equal(await region.getAttribute('aria-labelledby'), await toggles.first().getAttribute('id'));
  assert.equal(await region.locator('.pcf-section-card').count(), 2);
  assert.equal(await region.locator('.pcf-status-chip').count(), 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // 单展开手风琴：展开第二只时第一只自动收起；错误态不重复请求。
  mode = 'error'; await toggles.nth(1).click();
  await page.getByText('申赎信息读取失败，可点击重试').waitFor();
  assert.equal(await page.locator('[aria-expanded="true"]').count(), 1);
  const count = requests.length;
  await page.waitForTimeout(50); assert.equal(requests.length, count);
  mode = 'empty'; await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('暂无该日期的申赎缓存数据，等待更新').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // 沪市筛选 + 本地短路：展开沪市行不产生任何详情请求。
  await page.getByRole('button', { name: '沪市 5' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 5);
  const before = requests.length;
  await page.locator('tr.shares-row').first().locator('.row-toggle').click();
  await page.getByText('该标的为上交所 (SSE) 跨市场 ETF').waitFor();
  assert.equal(requests.length, before);
  await page.getByRole('button', { name: '全部标的 13' }).click();
  // 列头排序：缺失值置底、同值按代码稳定排序、aria-sort 状态切换。
  await page.getByRole('button', { name: '份额增量' }).click();
  assert.deepEqual((await page.locator('tr.shares-row .code-mono').allTextContents()).slice(0, 2), ['159501', '159659']);
  assert.equal(await page.locator('th[aria-sort="descending"]').count(), 1);
  assert.equal(await page.locator('tr.shares-row .code-mono').last().textContent(), '513870');
  await page.getByRole('button', { name: '份额增量' }).click();
  assert.equal(await page.locator('tr.shares-row .code-mono').first().textContent(), '159632');
  assert.equal(await page.locator('th[aria-sort="ascending"]').count(), 1);
  await page.getByRole('button', { name: '代码' }).click();
  assert.equal(await page.locator('tr.shares-row .code-mono').first().textContent(), '513870');
  await page.getByRole('button', { name: '代码' }).click();
  assert.equal(await page.locator('tr.shares-row .code-mono').first().textContent(), '159501');
  // 搜索与筛选全为本地行为：空状态 + 重置。
  await page.getByRole('textbox', { name: '搜索代码或简称' }).fill('does-not-exist');
  await page.getByText('未找到符合条件的 ETF 标的').waitFor();
  assert.equal(await page.locator('tr.shares-row').count(), 0);
  await page.getByRole('button', { name: '重置筛选条件' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 13);
  await page.getByRole('textbox', { name: '搜索代码或简称' }).fill('159501');
  assert.equal(await page.locator('tr.shares-row').count(), 1);
  await page.getByRole('button', { name: '清空搜索' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 13);
  // 窄容器切换为卡片布局：展开状态保留、进度条与 PCF 详情、口径折叠栏、无横向溢出。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.shares-card').first().waitFor();
  assert.equal(await page.locator('thead').count(), 0);
  assert.equal(await page.locator('.shares-card').count(), 13);
  assert.equal(await page.locator('.shares-card.is-open').count(), 1);
  await page.getByText('该标的为上交所 (SSE) 跨市场 ETF').waitFor();
  mode = 'ready';
  await page.getByRole('button', { name: /159501/ }).click();
  await page.getByText('1.5499', { exact: true }).waitFor();
  const meter = page.locator('.shares-card.is-open .usage-meter');
  assert.equal(await meter.count(), 1);
  assert.match(await meter.textContent(), /5%/);
  assert.match(await page.locator('.shares-card.is-open .card-kpi-grid').textContent(), /70.78 亿份/);
  await page.getByRole('button', { name: '数据口径与日期锚点' }).click();
  await page.getByText('日期不一，见各行').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(requests.every((r) => r.method() === 'GET'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?admin`);
  await page.getByRole('tab', {name:'套利雷达'}).waitFor();
  await page.evaluate(() => {
    history.replaceState(history.state, '', '#shares');
    dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await page.locator('#tab-shares[aria-selected="true"]').waitFor();
  await page.goto(`http://127.0.0.1:${server.address().port}/?admin#shares`);
  await page.getByRole('tab', {name:'份额新增'}).waitFor();
  assert.equal(await page.getByRole('tab', {name:'份额新增'}).getAttribute('aria-selected'), 'true');
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole('tab', {name:'套利雷达'}).click();
  assert.equal(new URL(page.url()).hash, '#radar');
  await page.getByRole('tab', {name:'份额新增'}).click();
  assert.equal(new URL(page.url()).hash, '#shares');
  assert.equal(await page.evaluate(() => history.length), historyLength);
  await page.goto(`http://127.0.0.1:${server.address().port}/?admin-denied#shares`);
  // admin 门控已移除（e08bd42a）：非管理员也能看份额 tab
  await page.getByRole('tab', {name:'份额新增'}).waitFor();
  assert.equal(await page.locator('.shares-panel').count(), 1);
});
