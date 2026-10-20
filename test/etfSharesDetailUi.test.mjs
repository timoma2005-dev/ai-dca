/* global HashChangeEvent, URL, console, dispatchEvent, document, history, innerWidth, process */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';

test('份额面板：新字段直渲染告警、沪深统一利用率、抽屉 14+3+环比四行、零预取、请求拆分、移动卡片、admin 挂载', async (t) => {
  // ---- fixture：限额环比结论（limitChange/limitChanges/prevLimitDate）与 513 份额直接注入快照，
  // 不再依赖历史限额请求推导 up/down/flat。----
  const data = syntheticProjection();
  data.expiresAt = new Date(Date.now() + 3600000).toISOString();
  // 顶层新字段：limitDate 优先于各行 limitDate 最大值（本 fixture 行内最大 2026-10-16，用于验证优先级）。
  Object.assign(data, { limitDate: '2026-10-13', prevLimitDate: '2026-10-09' });
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
  // 159501：净限额生效（角标「净」）；total 收紧、net 放宽 → 胶囊按 limitSource 取 net「新增 2.5倍」。
  Object.assign(data.records.find((r) => r.code === '159501'), {
    netLimitKind: 'limited',
    netLimitShares: 10000000,
    effLimitKind: 'limited',
    effLimitShares: 10000000,
    limitSource: 'net',
    prevLimitDate: '2026-10-09',
    limitChange: 'relaxed',
    limitChanges: {
      total: { change: 'tightened', ratio: 0.5, before: { kind: 'limited', shares: 20000000 }, after: { kind: 'limited', shares: 10000000 } },
      net: { change: 'relaxed', ratio: 2.5, before: { kind: 'limited', shares: 4000000 }, after: { kind: 'limited', shares: 10000000 } },
      accountTotal: { change: 'unchanged', ratio: 1, before: { kind: 'limited', shares: 1000000 }, after: { kind: 'limited', shares: 1000000 } },
      accountNet: { change: 'incomparable', ratio: null, before: null, after: null }
    }
  });
  // 159509：total 收紧 → 「减少至 0.9倍」；不给 prevLimitDate，抽屉环比日期左端显示 —。
  Object.assign(data.records[1], {
    limitChange: 'tightened',
    limitChanges: {
      total: { change: 'tightened', ratio: 0.9, before: { kind: 'limited', shares: 11000000 }, after: { kind: 'limited', shares: 10000000 } },
      net: { change: 'unchanged', ratio: 1, before: { kind: 'limited', shares: 10000000 }, after: { kind: 'limited', shares: 10000000 } }
    }
  });
  // 159513：上一期不限 → 新出现有限限额 → 「新增限额」。
  Object.assign(data.records[2], {
    prevLimitDate: '2026-10-09',
    limitChange: 'tightened',
    limitChanges: {
      total: { change: 'tightened', ratio: null, before: { kind: 'unlimited', shares: null }, after: { kind: 'limited', shares: 10000000 } }
    }
  });
  // 159632：限额取消（有限 → 不设上限）→ 「取消限额」；net/账户条目缺失，抽屉行显示「— → —」。
  Object.assign(data.records[3], {
    prevLimitDate: '2026-10-09',
    limitChange: 'relaxed',
    limitChanges: {
      total: { change: 'relaxed', ratio: null, before: { kind: 'limited', shares: 10000000 }, after: { kind: 'unlimited', shares: null } }
    }
  });
  // 159659（累计不限）：生效项持平、net 收紧 → limitChange mixed → 「限额有变」。
  Object.assign(data.records[4], {
    limitChange: 'mixed',
    limitChanges: {
      total: { change: 'unchanged', ratio: 1, before: { kind: 'unlimited', shares: null }, after: { kind: 'unlimited', shares: null } },
      net: { change: 'tightened', ratio: 0.4, before: { kind: 'unlimited', shares: null }, after: { kind: 'limited', shares: 4000000 } },
      accountTotal: { change: 'relaxed', ratio: null, before: { kind: 'limited', shares: 500000 }, after: { kind: 'unlimited', shares: null } }
    }
  });
  // 159660（生效限额 unknown）：纯账户项收紧 → 行高亮但无胶囊文案。
  Object.assign(data.records[5], {
    limitChange: 'tightened',
    limitChanges: {
      total: { change: 'unchanged', ratio: 1, before: { kind: 'unknown', shares: null }, after: { kind: 'unknown', shares: null } },
      net: { change: 'unchanged', ratio: 1, before: null, after: null },
      accountTotal: { change: 'tightened', ratio: 0.5, before: { kind: 'limited', shares: 2000000 }, after: { kind: 'limited', shares: 1000000 } }
    }
  });
  // 159696/159941：显式 unchanged，不高亮、无胶囊。
  Object.assign(data.records[6], { limitChange: 'unchanged' });
  Object.assign(data.records[7], { limitChange: 'unchanged' });
  // 513100：暂停申购（暂停优先），带真实上一期份额；完全无环比新字段（滚动发布期的旧形态记录）。
  Object.assign(data.records.find((r) => r.code === '513100'), {
    shares: 30000000000,
    prevDate: '2026-10-09',
    prevShares: 29990000000,
    deltaShares: 10000000,
    creationShares: 0,
    creationSharesKind: 'exact',
    subscriptionAllowed: false,
    redemptionAllowed: true,
    totalLimitKind: 'limited',
    totalLimitShares: 2500000,
    netLimitKind: 'unknown',
    netLimitShares: null,
    effLimitKind: 'limited',
    effLimitShares: 2500000,
    limitSource: 'total',
    limitDate: '2026-10-16',
    utilization: 4,
    atLimit: false,
    nearTotalLimit: true,
    status: 'complete',
    reasons: ['missing_dated_nav']
  });
  // 513110：正常未顶格，估算申购。
  Object.assign(data.records.find((r) => r.code === '513110'), {
    shares: 2000000000,
    prevDate: '2026-10-09',
    prevShares: 1999000000,
    deltaShares: 1000000,
    creationShares: 1000000,
    creationSharesKind: 'estimate',
    subscriptionAllowed: true,
    redemptionAllowed: true,
    totalLimitKind: 'limited',
    totalLimitShares: 5000000,
    netLimitKind: 'unknown',
    netLimitShares: null,
    effLimitKind: 'limited',
    effLimitShares: 5000000,
    limitSource: 'total',
    limitDate: '2026-10-12',
    utilization: 0.2,
    atLimit: false,
    nearTotalLimit: false,
    status: 'complete',
    reasons: ['missing_dated_nav']
  });
  // 513300：接近 90%。
  Object.assign(data.records.find((r) => r.code === '513300'), {
    shares: 1004500000,
    prevDate: '2026-10-09',
    prevShares: 1000000000,
    deltaShares: 4500000,
    creationShares: 4500000,
    creationSharesKind: 'estimate',
    subscriptionAllowed: true,
    redemptionAllowed: true,
    totalLimitKind: 'limited',
    totalLimitShares: 5000000,
    netLimitKind: 'unknown',
    netLimitShares: null,
    effLimitKind: 'limited',
    effLimitShares: 5000000,
    limitSource: 'total',
    limitDate: '2026-10-12',
    utilization: 0.9,
    atLimit: false,
    nearTotalLimit: true,
    status: 'complete',
    reasons: ['missing_dated_nav']
  });
  // 513390：累计不限，仅申购开放 → 确定申购值。
  Object.assign(data.records.find((r) => r.code === '513390'), {
    shares: 502000000,
    prevDate: '2026-10-09',
    prevShares: 500000000,
    deltaShares: 2000000,
    creationShares: 2000000,
    creationSharesKind: 'exact',
    subscriptionAllowed: true,
    redemptionAllowed: false,
    totalLimitKind: 'unlimited',
    totalLimitShares: null,
    netLimitKind: 'unknown',
    netLimitShares: null,
    effLimitKind: 'unlimited',
    effLimitShares: null,
    limitSource: 'total',
    limitDate: '2026-10-12',
    utilization: null,
    atLimit: null,
    nearTotalLimit: null,
    status: 'complete',
    reasons: ['missing_dated_nav']
  });
  // 513870 保持完全旧形态（无份额/差额）：降级展示 + 净流入 N 为 12（动态）。
  // 无胶囊变体：其余变化字段显式 unchanged/null，仅保留 159660 的纯账户项收紧
  // → 高亮 1 行但 chipRows 为空，验证无空告警条 + 换快照后高亮同步无残留。
  const calm = structuredClone(data);
  for (const r of calm.records) {
    if (r.code !== '159660') {
      r.limitChange = 'unchanged';
      r.limitChanges = null;
    }
  }
  // 完全无新字段的旧快照变体：页面正常、限额基准日回退 reduce、无告警、零预取。
  const legacy = structuredClone(data);
  delete legacy.limitDate;
  delete legacy.prevLimitDate;
  for (const r of legacy.records) {
    delete r.limitChange;
    delete r.limitChanges;
    delete r.prevLimitDate;
  }
  const bundle = await build({
    stdin: { contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import SharesExperience from './src/pages/SharesExperience.jsx';
      import Admin from './src/pages/AdminRadarExperience.jsx';
      import { sharesClient } from './src/app/etfPcfSharesClient.js';
      const stale = ${JSON.stringify(data)};
      const calm = ${JSON.stringify(calm)};
      const legacy = ${JSON.stringify(legacy)};
      sharesClient.subscribe = () => {
        window.__sharesSubs = (window.__sharesSubs || 0) + 1;
        const query = location.search;
        if (query.includes('empty')) return { promise: Promise.resolve({ state: 'empty' }), release() {} };
        if (query.includes('error')) return { promise: Promise.resolve({ state: 'error', reason: 'http_error' }), release() {} };
        const snapshot = query.includes('calm') ? calm : query.includes('legacy') ? legacy : stale;
        return { promise: Promise.resolve({ state: 'partial', data: snapshot, receivedAt: Date.now() }), release() {} };
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
  // PCF 路由：只剩抽屉的当前详情请求（含四个单账户限额字段）；无任何历史日期请求。
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
    const sse = code.startsWith('513');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      code, date, source: sse ? 'sse_pcf' : 'szse_pcf',
      prevDayDate: '2026-10-08', prevDayNav: 1.5499, prevDayUnitNav: 100, prevDayCashDifference: 5388,
      ...(sse ? { nav: 2.3456, navPerCreationUnit: 234560, tradingDay: '20261012', creationRedemption: '申购和赎回皆允许' } : {}),
      estimatedCashDifference: 4275.36, cashSubstitutionRatioLimitPct: 100, iopvRequired: true,
      subscriptionAllowed: true, redemptionAllowed: sse ? true : false, creationRedemptionUnitShares: 1000000,
      totalSubscribeLimitShares: 5000000, totalSubscribeLimitKind: 'limited',
      totalRedeemLimitShares: null, netSubscribeLimitShares: null, netRedeemLimitShares: null,
      accountTotalSubscribeLimitShares: 1000000, accountTotalSubscribeLimitKind: 'limited',
      accountTotalRedeemLimitShares: 0, accountTotalRedeemLimitKind: 'limited',
      accountNetSubscribeLimitShares: null, accountNetSubscribeLimitKind: 'unlimited',
      accountNetRedeemLimitKind: 'unknown'
    }) });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.locator('.shares-row').first().waitFor();
  const row = (code) => page.locator('tr.shares-row').filter({ hasText: code });
  const codes = () => page.locator('tr.shares-row .symbol-code').allTextContents();
  // 验收边界：首屏/筛选/搜索/排序/告警计算零 PCF 详情请求；无上一限额日请求、无预取。
  await page.waitForTimeout(80);
  assert.equal(requests.length, 0);
  // 六种变化文案全部由快照字段直接渲染：新增/减少至 X倍、新增限额、取消限额、限额有变（+抽屉的持平/不可比）。
  const chip159501 = page.locator('.alert-chip', { hasText: '159501' });
  assert.equal(await chip159501.locator('.limit-change.up').textContent(), '新增 2.5倍');
  const chip159509 = page.locator('.alert-chip', { hasText: '159509' });
  assert.equal(await chip159509.locator('.limit-change.down').textContent(), '减少至 0.9倍');
  assert.equal(await page.locator('.alert-chip', { hasText: '159513' }).locator('.limit-change.down').textContent(), '新增限额');
  assert.equal(await page.locator('.alert-chip', { hasText: '159632' }).locator('.limit-change.up').textContent(), '取消限额');
  assert.equal(await page.locator('.alert-chip', { hasText: '159659' }).locator('.limit-change.flat').textContent(), '限额有变');
  // 纯账户项变化（159660）：行高亮但无胶囊文案；胶囊只渲染 5 个，容器按 chipRows 渲染。
  assert.equal(await page.locator('.alert-chip', { hasText: '159660' }).count(), 0);
  assert.equal(await page.locator('.alert-chip').count(), 5);
  assert.equal(await page.locator('tr.shares-row.alert-row').count(), 6);
  assert.equal(await page.locator('.alert-strip').count(), 1);
  // 单行信息栏：状态 chip、顶层限额基准日优先（≠各行最大 2026-10-16）、上一限额日进 title、动态 N 净流入。
  assert.match(await page.locator('.status-chip.stale').textContent(), /数据滞后待确认/);
  assert.match(await page.locator('.head-date').textContent(), /份额基准日 2026-10-12 · 对比 2026-10-09 · 限额基准日 2026-10-13/);
  assert.match(await page.locator('.head-meta').textContent(), /抓取 2026-10-13 09:03:20/);
  assert.match(await page.locator('.head-meta').getAttribute('title'), /上一限额日：2026-10-09/);
  assert.deepEqual(await page.locator('.head-stat b').allTextContents(), ['+6,050', '9', '13']);
  assert.equal(
    await page.locator('.head-stat').first().getAttribute('title'),
    '全部 13 只中 12 只有效净增合计（负值参与净额）'
  );
  assert.match(await page.locator('.stale-banner').textContent(), /更新及时性待确认/);
  // 五列表格与 §9 否决项：无 KPI 磁贴、无利用率进度条、无 ▲▼、无金额列。
  assert.deepEqual(await page.locator('thead th').allTextContents(), ['代码 / 简称', '净增份额⇅', '限额利用率⇅', '本期总份额⇅', '']);
  assert.equal(await page.locator('th[aria-sort="none"]').count(), 3);
  assert.equal(await page.locator('.stat-card, .card-kpi-grid, .usage-meter, .usage-bar, [role="progressbar"]').count(), 0);
  assert.equal(await page.locator('.delta-val').filter({ hasText: /[▲▼]/ }).count(), 0);
  // 行内容：估算/确定申购、净角标、顶格/超限、513 暂停优先与真实总份额。
  const r0 = row('159501');
  assert.equal(await r0.locator('.symbol-code').textContent(), '159501');
  assert.equal(await r0.locator('.market-tag').textContent(), '深市');
  assert.equal(await r0.locator('.delta-val').textContent(), '+1,000.00');
  assert.equal(await r0.locator('.delta-sub').textContent(), '估算申购 约 1,000 万份');
  assert.equal(await r0.locator('.ceiling-tag').textContent(), '顶格 100%');
  assert.match(await r0.locator('.util-sub').textContent(), /净当日上限 1,000 万份/);
  assert.equal(await r0.locator('.limit-src-badge').textContent(), '净');
  assert.equal(await r0.locator('.total-val').textContent(), '200.10 亿');
  assert.equal(await r0.locator('.total-prev').textContent(), '上期 200.00 亿');
  const fillWidth = async () => r0.locator('.delta-fill').evaluate((el) => Math.round(el.getBoundingClientRect().width));
  assert.equal(await r0.locator('.delta-bar').evaluate((el) => Math.round(el.getBoundingClientRect().width)), 140);
  assert.equal(await fillWidth(), 112); // 10,000,000 / 全表最大 12,500,000 = 80%
  assert.equal(await row('159509').locator('.delta-sub').textContent(), '确定申购 950 万份');
  assert.equal(await row('159513').locator('.ceiling-tag').textContent(), '超限 125%');
  assert.equal(await row('159513').locator('.util-sub').textContent(), '累计当日上限 1,000 万份 · 限 10-16');
  assert.equal(await row('159513').locator('.limit-src-badge').textContent(), '累计');
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
  assert.equal(await sse.locator('.ceiling-tag').textContent(), '暂停申购'); // 暂停优先于顶格分支
  assert.equal(await sse.locator('.util-sse-pending').count(), 0);
  assert.equal(await sse.locator('.util-sub').textContent(), '累计当日上限 250 万份 · 限 10-16');
  assert.equal(await sse.locator('.limit-src-badge').textContent(), '累计');
  assert.equal(await sse.locator('.delta-val').textContent(), '+1,000.00');
  assert.equal(await sse.locator('.delta-sub').textContent(), '确定申购 0 万份');
  assert.equal(await sse.locator('.total-val').textContent(), '300.00 亿');
  assert.equal(await sse.locator('.total-prev').textContent(), '上期 299.90 亿');
  assert.equal(await row('513110').locator('.ceiling-tag').textContent(), '未顶格 20%');
  assert.equal(await row('513110').locator('.delta-sub').textContent(), '估算申购 约 100 万份');
  assert.equal(await row('513300').locator('.ceiling-tag').textContent(), '接近 90%');
  assert.equal(await row('513390').locator('.ceiling-tag').textContent(), '累计不限');
  assert.equal(await row('513390').locator('.delta-sub').textContent(), '确定申购 200 万份');
  assert.equal(await row('513870').locator('.ceiling-tag').textContent(), '数据待确认');
  assert.equal(await row('513870').locator('.delta-val').textContent(), '—');
  assert.equal(await row('513870').locator('.delta-sub').textContent(), '未比对');
  assert.equal(await row('513870').locator('.total-val').textContent(), '—');
  // 键盘展开当前详情：只请求当前 code/date（该行 limitDate 等于统计日）；关闭即卸载释放订阅。
  const toggles = page.locator('.detail-btn');
  mode = 'pending';
  await toggles.first().focus();
  await page.keyboard.press('Enter');
  await page.getByText('正在读取申赎信息…').waitFor();
  assert.equal(requests.length, 1);
  const detailQuery = new URL(requests[0].url()).searchParams;
  assert.equal(detailQuery.get('code'), '159501');
  assert.equal(detailQuery.get('date'), data.date);
  await toggles.first().click();
  assert.equal(await page.locator('[aria-labelledby]').count(), 0);
  for (const p of pending) await p.abort().catch(() => {});
  pending.length = 0;
  // 重新展开：环比小节 + T 日 14 行 + P 日 3 行；允许状态高亮、日期显式展示。
  mode = 'ready';
  await toggles.first().click();
  await page.getByText('1.5499', { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  const region = page.locator('#shares-detail-159501');
  assert.equal(await region.getAttribute('role'), 'region');
  assert.equal(await region.getAttribute('aria-labelledby'), await toggles.first().getAttribute('id'));
  // row prop 链：环比小节由 row.limitChanges 渲染，日期取 row.prevLimitDate → row.limitDate。
  assert.equal(await region.locator('.limit-compare').count(), 1);
  assert.equal(await region.locator('.limit-compare .pcf-kv-row').count(), 4);
  assert.deepEqual(await region.locator('.pcf-date-pill').allTextContents(), [
    '2026-10-09 → 2026-10-12',
    'T 日：2026-10-12',
    'P 日：2026-10-08'
  ]);
  const compareRows = region.locator('.limit-compare .pcf-kv-row');
  assert.deepEqual(await compareRows.locator('dt').allTextContents(), [
    '累计申购',
    '净申购',
    '单账户累计申购',
    '单账户净申购'
  ]);
  assert.equal(await compareRows.nth(0).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '2000.00万份 → 1000.00万份');
  assert.equal(await compareRows.nth(0).locator('.limit-change').getAttribute('class'), 'limit-change down');
  assert.equal(await compareRows.nth(0).locator('.limit-change').textContent(), '减少至 0.5倍');
  assert.equal(await compareRows.nth(1).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '400.00万份 → 1000.00万份');
  assert.equal(await compareRows.nth(1).locator('.limit-change').getAttribute('class'), 'limit-change up');
  assert.equal(await compareRows.nth(1).locator('.limit-change').textContent(), '新增 2.5倍');
  assert.equal(await compareRows.nth(2).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '100.00万份 → 100.00万份');
  assert.equal(await compareRows.nth(2).locator('.limit-change').getAttribute('class'), 'limit-change flat');
  assert.equal(await compareRows.nth(2).locator('.limit-change').textContent(), '持平');
  assert.equal(await compareRows.nth(3).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '— → —');
  assert.equal(await compareRows.nth(3).locator('.limit-change').textContent(), '不可比');
  // .pcf-kv-row 数量按小节限定：T 日 14 行（10 + 4 单账户）、P 日 3 行。
  assert.equal(await region.locator('.pcf-card.t-day .pcf-kv-row').count(), 14);
  assert.equal(await region.locator('.pcf-card.p-day .pcf-kv-row').count(), 3);
  assert.equal(await region.locator('.pcf-card.t-day .pcf-kv-row').filter({ hasText: '单账户累计申购上限' }).locator('dd').textContent(), '100.00万份');
  assert.equal(await region.locator('.pcf-card.t-day .pcf-kv-row').filter({ hasText: '单账户累计赎回上限' }).locator('dd').textContent(), '0份');
  assert.equal(await region.locator('.pcf-card.t-day .pcf-kv-row').filter({ hasText: '单账户净申购上限' }).locator('dd').textContent(), '不设上限');
  assert.equal(await region.locator('.pcf-card.t-day .pcf-kv-row').filter({ hasText: '单账户净赎回上限' }).locator('dd').textContent(), '—');
  assert.equal(await region.locator('.allow-chip.ok').textContent(), '✓ 允许');
  assert.equal(await region.locator('.allow-chip.blocked').textContent(), '✕ 暂停');
  assert.match(await region.locator('.pcf-formula').textContent(), /IOPV/);
  // 关闭再展开：同 code/date 命中内存缓存，不重复请求。
  await toggles.first().click();
  await toggles.first().click();
  await page.getByText('1.5499', { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  // 单展开手风琴：展开第二只时第一只自动收起；159509 无 prevLimitDate，环比日期左端为 —。
  await page.locator('#shares-toggle-159509').click();
  await page.waitForFunction(() => document.querySelectorAll('.detail-btn[aria-expanded="true"]').length === 1);
  assert.equal(requests.length, 3);
  const region509 = page.locator('#shares-detail-159509');
  assert.equal(await region509.locator('.pcf-date-pill').first().textContent(), '— → 2026-10-12');
  // 错误态不自动重试；详情失败时环比小节仍可见（独立于请求状态）。
  await page.locator('#shares-toggle-159509').click();
  mode = 'error';
  await page.locator('#shares-toggle-159632').click();
  await page.getByText('申赎信息读取失败，可点击重试').waitFor();
  assert.equal(await page.locator('.detail-btn[aria-expanded="true"]').count(), 1);
  assert.equal(requests.length, 4);
  const region632 = page.locator('#shares-detail-159632');
  assert.equal(await region632.locator('.limit-compare').count(), 1);
  const compareRows632 = region632.locator('.limit-compare .pcf-kv-row');
  assert.equal(await compareRows632.nth(0).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '1000.00万份 → 不设上限');
  assert.equal(await region632.locator('.limit-compare .limit-change').textContent(), '取消限额');
  // 条目缺失：净申购/单账户行显示「— → —」且无变化标签。
  assert.equal(await compareRows632.nth(1).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '— → —');
  assert.equal(await compareRows632.nth(1).locator('.limit-change').count(), 0);
  assert.equal(await compareRows632.nth(3).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '— → —');
  const errorCount = requests.length;
  await page.waitForTimeout(50);
  assert.equal(requests.length, errorCount);
  mode = 'empty';
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('暂无该日期的申赎缓存数据，等待更新').waitFor();
  assert.equal(requests.length, errorCount + 1);
  await page.locator('#shares-toggle-159632').click();
  // 沪市筛选：展开沪市行只请求该行 limitDate 的详情，渲染上交所 PCF；无 limitChanges 整节隐藏。
  mode = 'ready';
  await page.getByRole('button', { name: '沪市 5' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 5);
  const beforeSse = requests.length;
  await page.locator('tr.shares-row').first().locator('.detail-btn').click();
  await page.getByText('上交所官方 PCF').waitFor();
  assert.equal(requests.length, beforeSse + 1);
  const sseQuery = new URL(requests[requests.length - 1].url()).searchParams;
  assert.equal(sseQuery.get('code'), '513100');
  assert.equal(sseQuery.get('date'), '2026-10-16');
  assert.equal(await page.locator('#shares-detail-513100 .limit-compare').count(), 0);
  assert.equal(await page.locator('#shares-detail-513100 .pcf-card.t-day .pcf-kv-row').count(), 14);
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
  // 六档筛选计数与全表固定净增尺度：筛选/搜索/排序不改变条形图分母、不触发详情请求。
  await page.getByRole('button', { name: '净增 9' }).click();
  assert.equal(await page.locator('tr.shares-row').count(), 9);
  assert.equal(await fillWidth(), 112);
  await page.getByRole('button', { name: '净减 1' }).click();
  assert.deepEqual(await codes(), ['159632']);
  await page.getByRole('button', { name: '全部 13' }).click();
  await page.locator('.alert-chip').first().click();
  assert.equal(await page.locator('tr.shares-row').count(), 4);
  assert.match(await page.locator('.filter-btn[aria-pressed="true"]').textContent(), /顶格 \/ 接近/);
  await page.getByRole('button', { name: '全部 13' }).click();
  assert.equal(requests.length, beforeSse + 1);
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
  // 刷新按钮只递增 reloadCount 重新订阅快照，不重拉任何 PCF 详情。
  const subsBefore = await page.evaluate(() => window.__sharesSubs);
  const reqBefore = requests.length;
  await page.locator('.refresh-btn').click();
  assert.equal(await page.evaluate(() => window.__sharesSubs), subsBefore + 1);
  await page.waitForTimeout(50);
  assert.equal(requests.length, reqBefore);
  // 页尾口径说明：三条 note（净增口径、顶格双口径、沪市已接入 + 金额估算缺失原因）。
  await page.locator('.shares-notes summary').click();
  const notes = await page.locator('.notes-list li').allTextContents();
  assert.equal(notes.length, 3);
  assert.ok(notes.some((text) => text.includes('沪市（513 开头）份额已接入上交所 ETF 规模数据')));
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
  // 无胶囊变体：唯一变化行（159660 纯账户项）高亮但无胶囊 → 无空告警条；其余高亮无残留；零预取。
  const reqsCalm = requests.length;
  await page.goto(`${base}/?calm`);
  await page.locator('.shares-row').first().waitFor();
  assert.equal(await page.locator('.alert-strip').count(), 0);
  assert.equal(await page.locator('.alert-chip').count(), 0);
  assert.equal(await page.locator('.limit-change').count(), 0);
  assert.equal(await page.locator('tr.shares-row.alert-row').count(), 1);
  assert.equal(await page.locator('tr.shares-row.alert-row').filter({ hasText: '159660' }).count(), 1);
  await page.waitForTimeout(80);
  assert.equal(requests.length, reqsCalm);
  // 完全无新字段的旧快照变体：页面正常、限额基准日回退各行最大值、无上一限额日 title、无告警、零预取。
  const reqsLegacy = requests.length;
  await page.goto(`${base}/?legacy`);
  await page.locator('.shares-row').first().waitFor();
  assert.equal(await page.locator('tr.shares-row').count(), 13);
  assert.match(await page.locator('.head-date').textContent(), /份额基准日 2026-10-12 · 对比 2026-10-09 · 限额基准日 2026-10-16/);
  assert.doesNotMatch(await page.locator('.head-meta').getAttribute('title'), /上一限额日/);
  assert.equal(await page.locator('tr.shares-row.alert-row').count(), 0);
  assert.equal(await page.locator('.alert-strip').count(), 0);
  assert.deepEqual(await page.locator('.head-stat b').allTextContents(), ['+6,050', '9', '13']);
  await page.waitForTimeout(80);
  assert.equal(requests.length, reqsLegacy);
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
