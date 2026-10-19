/* global HashChangeEvent, URL, console, dispatchEvent, document, history, innerWidth, process */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';

test('份额面板整体替换：信息栏、告警条限额环比三态、五列表格、三态排序、抽屉 10+3、请求拆分、沪市短路、移动卡片、admin 挂载', async (t) => {
  // ---- fixture：3 只告警（顶格/接近/顶格），限额环比分别 up/down/flat；限额日期 2026-10-12 → 上一交易日 2026-10-09 ----
  const data = syntheticProjection();
  data.expiresAt = new Date(Date.now() + 3600000).toISOString();
  Object.assign(data.records[0], { creationShares: 10000000, creationSharesKind: 'estimate' });
  Object.assign(data.records[1], { creationShares: 9500000, creationSharesKind: 'exact' });
  Object.assign(data.records[2], { creationShares: 12500000, creationSharesKind: 'estimate', limitDate: '2026-10-16' });
  Object.assign(data.records[3], { creationShares: -1000000, creationSharesKind: 'estimate' });
  Object.assign(data.records[6], {
    shares: 20010000000,
    deltaShares: 10000000,
    utilization: 1,
    atLimit: true,
    nearTotalLimit: true,
    creationShares: 10000000,
    creationSharesKind: 'estimate'
  });
  // 无告警变体：验证「无告警首屏零 PCF 请求」（over-limit 不并入告警）。
  const calm = structuredClone(data);
  for (const [i, delta] of [
    [0, 5000000],
    [1, 6000000],
    [6, 0]
  ]) {
    Object.assign(calm.records[i], {
      shares: 20000000000 + delta,
      deltaShares: delta,
      utilization: delta / 10000000,
      atLimit: false,
      nearTotalLimit: false
    });
  }
  const bundle = await build({
    stdin: { contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import SharesExperience from './src/pages/SharesExperience.jsx';
      import Admin from './src/pages/AdminRadarExperience.jsx';
      import { sharesClient } from './src/app/etfPcfSharesClient.js';
      const stale = ${JSON.stringify(data)};
      const calm = ${JSON.stringify(calm)};
      sharesClient.subscribe = () => {
        window.__sharesSubs = (window.__sharesSubs || 0) + 1;
        const query = location.search;
        if (query.includes('empty')) return { promise: Promise.resolve({ state: 'empty' }), release() {} };
        if (query.includes('error')) return { promise: Promise.resolve({ state: 'error', reason: 'http_error' }), release() {} };
        return { promise: Promise.resolve({ state: 'partial', data: query.includes('calm') ? calm : stale, receivedAt: Date.now() }), release() {} };
      };
      createRoot(document.getElementById('root')).render(location.search.includes('admin') ? <Admin session={{ isAdmin: !location.search.includes('denied') }} /> : <SharesExperience />);`, resolveDir: process.cwd(), loader: 'jsx' },
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
  // PCF 路由：历史日期（上一交易日 2026-10-09）按 code 返回不同限额演示 up/down/flat；当前详情日期返回通用清单。
  const historyLimit = { 159501: 9000000, 159509: 11000000, 159696: 10000000 };
  const requests = [];
  let mode = 'ready';
  const pending = [];
  await page.route('**/api/etf-pcf-limit?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const code = query.get('code');
    const date = query.get('date');
    requests.push(route.request());
    if (mode === 'pending') { pending.push(route); return; }
    if (mode === 'error') { await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); return; }
    if (mode === 'empty') { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ reason: 'cache_miss' }) }); return; }
    const historical = date === '2026-10-09' && Object.hasOwn(historyLimit, code);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      code, date, source: 'szse_pcf',
      prevDayDate: '2026-10-08', prevDayNav: 1.5499, prevDayUnitNav: 100, prevDayCashDifference: 5388,
      estimatedCashDifference: 4275.36, cashSubstitutionRatioLimitPct: 100, iopvRequired: true,
      subscriptionAllowed: true, redemptionAllowed: false, creationRedemptionUnitShares: 1000000,
      totalSubscribeLimitShares: historical ? historyLimit[code] : 5000000, totalSubscribeLimitKind: 'limited',
      totalRedeemLimitShares: null, netSubscribeLimitShares: null, netRedeemLimitShares: null
    }) });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.locator('.shares-row').first().waitFor();
  const row = (code) => page.locator('tr.shares-row').filter({ hasText: code });
  const codes = () => page.locator('tr.shares-row .symbol-code').allTextContents();
  // 首屏仅 3 只告警标的的历史限额请求（严格取 limitDate 的上一交易日），无当前详情请求。
  await page.waitForTimeout(50);
  assert.deepEqual(requests.map((r) => new URL(r.url()).searchParams.get('code')).sort(), ['159501', '159509', '159696']);
  assert.ok(requests.every((r) => new URL(r.url()).searchParams.get('date') === '2026-10-09'));
  assert.ok(requests.every((r) => r.method() === 'GET'));
  // 限额环比三态：up/down/flat；口径不符（非 limited/非整数）静默不渲染。
  assert.equal(await page.locator('.limit-change.up').textContent(), '限额↑ 100 万份');
  assert.equal(await page.locator('.limit-change.down').textContent(), '限额↓ 100 万份');
  assert.equal(await page.locator('.limit-change.flat').textContent(), '限额持平');
  // 单行信息栏：状态 chip、基准日/对比、抓取时间（上海时区）、三个统计与刷新按钮。
  assert.match(await page.locator('.status-chip.stale').textContent(), /数据滞后待确认/);
  assert.match(await page.locator('.head-date').textContent(), /基准日 2026-10-12 · 对比 2026-10-09/);
  assert.match(await page.locator('.head-meta').textContent(), /抓取 2026-10-13 09:03:20/);
  assert.deepEqual(await page.locator('.head-stat b').allTextContents(), ['+4,300', '3', '13']);
  // 告警条：3 个胶囊（over-limit 不并入），点击胶囊切换到「顶格 / 接近」筛选。
  assert.equal(await page.locator('.alert-strip').count(), 1);
  assert.deepEqual(await page.locator('.alert-chip-status').allTextContents(), ['顶格', '接近', '顶格']);
  assert.equal(await page.locator('.stale-banner').count(), 1);
  assert.match(await page.locator('.stale-banner').textContent(), /更新及时性待确认/);
  // 五列表格与 §9 否决项：无 KPI 磁贴、无利用率进度条、无 ▲▼、无金额列。
  assert.deepEqual(await page.locator('thead th').allTextContents(), ['代码 / 简称', '净增份额⇅', '限额利用率⇅', '本期总份额⇅', '']);
  assert.equal(await page.locator('th[aria-sort="none"]').count(), 3);
  assert.equal(await page.locator('.stat-card, .card-kpi-grid, .usage-meter, .usage-bar, [role="progressbar"]').count(), 0);
  assert.equal(await page.locator('.delta-val').filter({ hasText: /[▲▼]/ }).count(), 0);
  // 行内容：代码/市场/简称、净增（含估算副文案与固定尺度对比条）、七类徽章、总份额 null 不补 0。
  const r0 = row('159501');
  assert.equal(await r0.locator('.symbol-code').textContent(), '159501');
  assert.equal(await r0.locator('.market-tag').textContent(), '深市');
  assert.equal(await r0.locator('.delta-val').textContent(), '+1,000.00');
  assert.equal(await r0.locator('.delta-sub').textContent(), '估算申购 约 1,000 万份');
  assert.equal(await r0.locator('.ceiling-tag').textContent(), '顶格 100%');
  assert.match(await r0.locator('.util-sub').textContent(), /当日上限 1,000 万份/);
  assert.equal(await r0.locator('.total-val').textContent(), '200.10 亿');
  assert.equal(await r0.locator('.total-prev').textContent(), '上期 200.00 亿');
  const fillWidth = async () => r0.locator('.delta-fill').evaluate((el) => Math.round(el.getBoundingClientRect().width));
  assert.equal(await r0.locator('.delta-bar').evaluate((el) => Math.round(el.getBoundingClientRect().width)), 140);
  assert.equal(await fillWidth(), 112); // 10,000,000 / 全表最大 12,500,000 = 80%
  assert.equal(await row('159513').locator('.ceiling-tag').textContent(), '超限 125%');
  assert.equal(await row('159513').locator('.util-sub').textContent(), '当日上限 1,000 万份 · 限 10-16');
  assert.equal(await row('159632').locator('.delta-val').textContent(), '-100.00');
  assert.equal(await row('159632').locator('.ceiling-tag').textContent(), '净流出');
  assert.equal(await row('159632').locator('.delta-sub').count(), 0); // 负值申购数不渲染
  assert.equal(await row('159660').locator('.ceiling-tag').textContent(), '数据待确认');
  assert.equal(await row('159660').locator('.util-sub').count(), 0);
  assert.equal(await row('159659').locator('.ceiling-tag').textContent(), '累计不限');
  assert.equal(await row('159659').locator('.util-sub').textContent(), '无累计申购限额');
  assert.equal(await row('159941').locator('.delta-val').textContent(), '0.00'); // 零值灰显
  assert.equal(await row('159941').locator('.delta-bar').count(), 0); // 零不画填充
  const sse = row('513100');
  assert.equal(await sse.locator('.ceiling-tag').textContent(), '沪市待接入');
  assert.equal(await sse.locator('.util-sse-pending').count(), 1);
  assert.equal(await sse.locator('.delta-val').textContent(), '—');
  assert.equal(await sse.locator('.delta-sub').textContent(), '未比对');
  assert.equal(await sse.locator('.total-val').textContent(), '—');
  assert.equal(await sse.locator('.total-prev').textContent(), '上期 —');
  // 键盘展开当前详情：请求日期为快照统计日 data.date；关闭即卸载释放订阅。
  const toggles = page.locator('.detail-btn');
  mode = 'pending';
  await toggles.first().focus();
  await page.keyboard.press('Enter');
  await page.getByText('正在读取申赎信息…').waitFor();
  assert.equal(requests.length, 4);
  const detailQuery = new URL(requests[3].url()).searchParams;
  assert.equal(detailQuery.get('code'), '159501');
  assert.equal(detailQuery.get('date'), data.date);
  await toggles.first().click();
  assert.equal(await page.locator('[aria-labelledby]').count(), 0);
  for (const p of pending) await p.abort().catch(() => {});
  pending.length = 0;
  // 重新展开：T 日 10 行 + P 日 3 行真实字段、允许状态高亮、日期显式展示。
  mode = 'ready';
  await toggles.first().click();
  await page.getByText('1.5499', { exact: true }).waitFor();
  assert.equal(requests.length, 5);
  const region = page.locator(`#shares-detail-159501`);
  assert.equal(await region.getAttribute('role'), 'region');
  assert.equal(await region.getAttribute('aria-labelledby'), await toggles.first().getAttribute('id'));
  assert.equal(await region.locator('.pcf-kv-row').count(), 13);
  assert.deepEqual(await region.locator('.pcf-date-pill').allTextContents(), ['T 日：2026-10-12', 'P 日：2026-10-08']);
  assert.equal(await region.locator('.allow-chip.ok').textContent(), '✓ 允许');
  assert.equal(await region.locator('.allow-chip.blocked').textContent(), '✕ 暂停');
  assert.match(await region.locator('.pcf-formula').textContent(), /IOPV/);
  // 关闭再展开：同 code/date 命中内存缓存，不重复请求（环比标签与抽屉共用同一缓存）。
  await toggles.first().click();
  await toggles.first().click();
  await page.getByText('1.5499', { exact: true }).waitFor();
  assert.equal(requests.length, 5);
  // 单展开手风琴：展开第二只时第一只自动收起。
  await page.locator('#shares-toggle-159509').click();
  await page.waitForFunction(() => document.querySelectorAll('.detail-btn[aria-expanded="true"]').length === 1);
  assert.equal(requests.length, 6);
  // 错误态不自动重试；显式重试后 404 cache_miss 展示为无数据。
  await page.locator('#shares-toggle-159509').click();
  mode = 'error';
  await page.locator('#shares-toggle-159632').click();
  await page.getByText('申赎信息读取失败，可点击重试').waitFor();
  assert.equal(await page.locator('.detail-btn[aria-expanded="true"]').count(), 1);
  const errorCount = requests.length;
  await page.waitForTimeout(50);
  assert.equal(requests.length, errorCount);
  mode = 'empty';
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('暂无该日期的申赎缓存数据，等待更新').waitFor();
  await page.locator('#shares-toggle-159632').click();
  // 沪市筛选 + 本地短路：展开沪市行不产生任何详情请求。
  await page.getByRole('button', { name: '沪市 5' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 5);
  const beforeSse = requests.length;
  await page.locator('tr.shares-row').first().locator('.detail-btn').click();
  await page.getByText('沪市 PCF 清单暂未接入').waitFor();
  assert.equal(requests.length, beforeSse);
  await page.locator('tr.shares-row').first().locator('.detail-btn').click();
  await page.getByRole('button', { name: '全部 13' }).click();
  // 三态排序：默认 → 降序 → 升序 → 默认恢复；缺失置底、同值按代码稳定排序。
  const sortBtn = page.getByRole('button', { name: /净增份额/ });
  await sortBtn.click();
  assert.deepEqual((await codes()).slice(0, 3), ['159513', '159501', '159696']);
  assert.equal((await codes()).at(-1), '513870');
  assert.equal(await page.locator('th[aria-sort="descending"]').count(), 1);
  await sortBtn.click();
  assert.equal((await codes())[0], '159632');
  assert.equal(await page.locator('th[aria-sort="ascending"]').count(), 1);
  await sortBtn.click();
  assert.equal((await codes())[0], '159501');
  assert.equal(await page.locator('th[aria-sort="none"]').count(), 3);
  // 六档筛选计数与全表固定净增尺度：筛选/搜索/排序不改变条形图分母。
  await page.getByRole('button', { name: '净增 5' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 5);
  assert.equal(await fillWidth(), 112);
  await page.getByRole('button', { name: '净减 1' }).click();
  assert.deepEqual(await codes(), ['159632']);
  await page.getByRole('button', { name: '全部 13' }).click();
  await page.locator('.alert-chip').first().click();
  assert.equal(await page.locator('tr.shares-row').count(), 3);
  assert.match(await page.locator('.filter-btn[aria-pressed="true"]').textContent(), /顶格 \/ 接近/);
  await page.getByRole('button', { name: '全部 13' }).click();
  // 搜索与筛选为本地行为：空结果与源数据 empty 分开处理。
  await page.getByRole('textbox', { name: '搜索代码或简称' }).fill('does-not-exist');
  await page.getByText('未找到符合条件的 ETF 标的').waitFor();
  await page.getByRole('button', { name: '清空筛选条件' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 13);
  await page.getByRole('textbox', { name: '搜索代码或简称' }).fill('159501');
  assert.equal(await page.locator('tr.shares-row').count(), 1);
  await page.getByRole('button', { name: '清空搜索' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 13);
  // 整行可点击展开；内按钮 stopPropagation 不双触发。
  await row('159509').locator('td.sh-symbol').click();
  assert.equal(await page.locator('#shares-toggle-159509').getAttribute('aria-expanded'), 'true');
  await row('159509').locator('td.sh-symbol').click();
  assert.equal(await page.locator('#shares-toggle-159509').getAttribute('aria-expanded'), 'false');
  // 刷新按钮只递增 reloadCount 重新订阅快照，不重拉历史 PCF。
  const subsBefore = await page.evaluate(() => window.__sharesSubs);
  const reqBefore = requests.length;
  await page.locator('.refresh-btn').click();
  assert.equal(await page.evaluate(() => window.__sharesSubs), subsBefore + 1);
  await page.waitForTimeout(50);
  assert.equal(requests.length, reqBefore);
  // 页尾口径说明：三条 note（净增口径、顶格双口径、沪市 + 金额估算缺失原因）。
  await page.locator('.shares-notes summary').click();
  const notes = await page.locator('.notes-list li').allTextContents();
  assert.equal(notes.length, 3);
  assert.ok(notes.some((text) => text.includes('新增金额估算')));
  assert.ok(notes.some((text) => text.includes('IOPV')));
  // ≤860px 移动卡片：同一 DOM、thead 仅 CSS 隐藏、展开与订阅保留、无横向溢出。
  await page.locator('#shares-toggle-159501').click();
  await page.getByText('1.5499', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.detail-btn[aria-expanded="true"]').count(), 1);
  assert.equal(await page.locator('thead').evaluate((el) => getComputedStyle(el).display), 'none');
  assert.equal(await page.locator('thead th').count(), 5);
  assert.equal(await page.locator('tr.shares-row').count(), 13);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 861, height: 900 });
  assert.notEqual(await page.locator('thead').evaluate((el) => getComputedStyle(el).display), 'none');
  await page.setViewportSize({ width: 860, height: 900 });
  assert.equal(await page.locator('thead').evaluate((el) => getComputedStyle(el).display), 'none');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  // 无告警变体：告警条不渲染，首屏零 PCF 请求。
  const reqsCalm = requests.length;
  await page.goto(`${base}/?calm`);
  await page.locator('.shares-row').first().waitFor();
  assert.equal(await page.locator('.alert-strip').count(), 0);
  assert.equal(await page.locator('.limit-change').count(), 0);
  await page.waitForTimeout(80);
  assert.equal(requests.length, reqsCalm);
  // 404 empty：待流水线更新提示；错误态重试仅递增 reloadCount 重新订阅。
  await page.goto(`${base}/?empty`);
  await page.getByText('暂无已验证份额快照').waitFor();
  assert.match(await page.locator('.state-desc').textContent(), /09:00 抓取、09:01 校验、09:02 发布/);
  assert.equal(await page.locator('thead').count(), 0);
  await page.goto(`${base}/?error`);
  await page.getByText('份额快照读取失败').waitFor();
  assert.equal(await page.locator('.state-view.error').count(), 1);
  const errSubs = await page.evaluate(() => window.__sharesSubs);
  await page.getByRole('button', { name: '重试读取快照' }).click();
  assert.equal(await page.evaluate(() => window.__sharesSubs), errSubs + 1);
  // 雷达页 #shares 子 tab 与 hash 同步回归（新组件直接挂载）。
  await page.goto(`${base}/?admin`);
  await page.getByRole('tab', { name: '套利雷达' }).waitFor();
  await page.evaluate(() => {
    history.replaceState(history.state, '', '#shares');
    dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await page.locator('#tab-shares[aria-selected="true"]').waitFor();
  await page.goto(`${base}/?admin#shares`);
  await page.getByRole('tab', { name: '份额新增' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '份额新增' }).getAttribute('aria-selected'), 'true');
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole('tab', { name: '套利雷达' }).click();
  assert.equal(new URL(page.url()).hash, '#radar');
  await page.getByRole('tab', { name: '份额新增' }).click();
  assert.equal(new URL(page.url()).hash, '#shares');
  assert.equal(await page.evaluate(() => history.length), historyLength);
  await page.goto(`${base}/?admin-denied#shares`);
  // admin 门控已移除：非管理员也能看份额 tab，新面板正常渲染。
  await page.getByRole('tab', { name: '份额新增' }).waitFor();
  assert.equal(await page.locator('.shares-panel').count(), 1);
});
