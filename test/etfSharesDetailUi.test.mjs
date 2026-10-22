/* global HashChangeEvent, URL, dispatchEvent, document, history, innerWidth, localStorage, process, structuredClone, window */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { syntheticProjection } from './helpers/etfPcfSharesFixture.mjs';

test('当前份额看板：卡片、表格、详情、移动端、旧快照 fallback 与 admin', async (t) => {
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
  // 直接映射：159501 的四项变化独立显示，total 收紧、net 放宽及账户持平/不可比。
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
  // 直接映射：159509 累计收紧 ×0.9；无 prevLimitDate 的详情日期左端显示 —。
  Object.assign(data.records[1], {
    limitChange: 'tightened',
    limitChanges: {
      total: { change: 'tightened', ratio: 0.9, before: { kind: 'limited', shares: 11000000 }, after: { kind: 'limited', shares: 10000000 } },
      net: { change: 'unchanged', ratio: 1, before: { kind: 'limited', shares: 10000000 }, after: { kind: 'limited', shares: 10000000 } }
    }
  });
  // 直接映射：159513 不限转有限，卡片收紧、详情新增限额。
  Object.assign(data.records[2], {
    prevLimitDate: '2026-10-09',
    limitChange: 'tightened',
    limitChanges: {
      total: { change: 'tightened', ratio: null, before: { kind: 'unlimited', shares: null }, after: { kind: 'limited', shares: 10000000 } }
    }
  });
  // 直接映射：159632 有限转不限，卡片放宽、详情取消限额；未知项保留 —。
  Object.assign(data.records[3], {
    prevLimitDate: '2026-10-09',
    limitChange: 'relaxed',
    limitChanges: {
      total: { change: 'relaxed', ratio: null, before: { kind: 'limited', shares: 10000000 }, after: { kind: 'unlimited', shares: null } }
    }
  });
  // 直接映射：159659 mixed 计入收紧和放宽统计，累计不限、净项收紧、账户放宽。
  Object.assign(data.records[4], {
    limitChange: 'mixed',
    limitChanges: {
      total: { change: 'unchanged', ratio: 1, before: { kind: 'unlimited', shares: null }, after: { kind: 'unlimited', shares: null } },
      net: { change: 'tightened', ratio: 0.4, before: { kind: 'unlimited', shares: null }, after: { kind: 'limited', shares: 4000000 } },
      accountTotal: { change: 'relaxed', ratio: null, before: { kind: 'limited', shares: 500000 }, after: { kind: 'unlimited', shares: null } }
    }
  });
  // 替代：159660 纯账户项收紧仍显示结论与账户变化；旧胶囊不再是默认页契约。
  Object.assign(data.records[5], {
    limitChange: 'tightened',
    limitChanges: {
      total: { change: 'unchanged', ratio: 1, before: { kind: 'unknown', shares: null }, after: { kind: 'unknown', shares: null } },
      net: { change: 'unchanged', ratio: 1, before: null, after: null },
      accountTotal: { change: 'tightened', ratio: 0.5, before: { kind: 'limited', shares: 2000000 }, after: { kind: 'limited', shares: 1000000 } }
    }
  });
  // 直接映射：159696/159941 显式 unchanged；零差额与额度用满独立。
  Object.assign(data.records[6], { limitChange: 'unchanged' });
  Object.assign(data.records[7], { limitChange: 'unchanged' });
  // 替代：513100 暂停徽章、delta 和总份额；补完整预计算字段以隔离零预取验收。
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
  // 替代：513110 未顶格转验 delta，无额度用满徽章。
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
  // 替代：513300 接近 90% 的展示转验 delta（阈值算法在共享单测覆盖）。
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
  // 替代：513390 累计不限、delta；creationSharesKind 的算法保留共享单测。
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
  // 替代：513870 无份额/差额显示暂无；旧净流入汇总转验统计 tile。
  // 替代：旧「所有快照零预取」只适用于完整预计算的新快照；旧形态单列 fallback 用例。
  const keys = ['total', 'net', 'accountTotal', 'accountNet'];
  for (const r of data.records) {
    r.limitChanges ||= {};
    for (const k of keys) r.limitChanges[k] ||= {
      before: null, after: null, change: 'incomparable', ratio: null
    };
  }
  // 直接映射：详情 date 缺失回退 snapshot.date，不引入额外列表请求。
  data.records.find(r => r.code === '159941').limitDate = null;
  const calm = structuredClone(data);
  for (const r of calm.records) {
    r.limitChange = 'unchanged';
    for (const k of keys) r.limitChanges[k].change = 'unchanged';
  }
  const legacy = structuredClone(data);
  delete legacy.limitDate;
  delete legacy.prevLimitDate;
  // 旧快照只留一个可见 code，日期被日历确认；失败 fixture 用于一次重试上限。
  legacy.records = legacy.records.filter(r => r.code === '159501');
  Object.assign(legacy.records[0], { limitDate: '2026-10-12' });
  delete legacy.records[0].limitChanges;
  delete legacy.records[0].limitChange;
  delete legacy.records[0].prevLimitDate;
  // 复用工作台真实分流函数，验证旧 #shares 深链直达公开组件，不再挂载雷达子 tab。
  const workspaceSource = readFileSync(new URL('../src/pages/WorkspacePage.jsx', import.meta.url), 'utf8');
  const renderActivePanel = workspaceSource.match(/ {2}function renderActivePanel\(\) \{[\s\S]*?\n {2}\}/)[0];
  const bundle = await build({
    stdin: { contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import SharesExperience from './src/pages/SharesExperience.jsx';
      import Admin from './src/pages/AdminRadarExperience.jsx';
      import { sharesClient } from './src/app/etfPcfSharesClient.js';
      import { pcfDetailClient } from './src/app/etfPcfDetailClient.js';
      const data = ${JSON.stringify(data)};
      const calm = ${JSON.stringify(calm)};
      const legacy = ${JSON.stringify(legacy)};
      window.__snapshot = data;
      window.__detailClient = pcfDetailClient;
      sharesClient.subscribe = () => {
        window.__sharesSubs = (window.__sharesSubs || 0) + 1;
        const q = location.search;
        if (q.includes('empty')) return { promise: Promise.resolve({ state: 'empty' }), release() {} };
        if (q.includes('error')) return { promise: Promise.resolve({ state: 'error' }), release() {} };
        const snapshot = q.includes('legacy') ? legacy : window.__calm ? calm : data;
        return { promise: Promise.resolve({ state: q.includes('stale') ? 'stale' : 'partial', data: snapshot, receivedAt: Date.now() }), release() {} };
      };
      function TestWorkspace() {
        const params = new URLSearchParams(location.search);
        const activeTab = params.get('tab') || 'shares';
        const isAdminUser = !params.has('denied');
        const links = {};
        const inPagesDir = false;
        const AdminRadarExperience = () => <Admin session={{ isAdmin: isAdminUser }} />;
        const HoldingsExperience = () => <p>持仓兜底</p>;
        const [, setHash] = React.useState(location.hash);
        React.useEffect(() => {
          const syncHash = () => setHash(location.hash);
          window.addEventListener('hashchange', syncHash);
          return () => window.removeEventListener('hashchange', syncHash);
        }, []);
        ${renderActivePanel}
        return renderActivePanel();
      }
      createRoot(document.getElementById('root')).render(<TestWorkspace />);`, resolveDir: process.cwd(), loader: 'jsx' },
    alias: { '@': process.cwd() + '/src' },
    bundle: true, write: false, outfile: 'app.js', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }
  });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = bundle.outputFiles.find(f => f.path.endsWith(pathname === '/app.css' ? '.css' : '.js'));
    res.setHeader('Content-Type', pathname === '/' ? 'text/html' : pathname === '/app.css' ? 'text/css' : 'text/javascript');
    res.end(pathname === '/' ? '<link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>' : file.contents);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function setup(t, query = '', width = 1280) {
    // 每例独立 JS 模块、localStorage、客户端 memory/inflight 与网络计数。
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    await context.addInitScript(() => localStorage.removeItem('etf-shares:view-mode'));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const requests = [], escaped = [], pending = [], failed = [];
    page.on('requestfailed', request => failed.push(request.url()));
    const state = { mode: 'ready' };
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/etf-pcf-limit') {
        const code = url.searchParams.get('code'), date = url.searchParams.get('date');
        requests.push({ code, date });
        if (state.mode === 'pending') { pending.push(route); return; }
        if (state.mode === 'error') return route.fulfill({ status: 503, json: {} });
        if (state.mode === 'empty') return route.fulfill({ status: 404, json: { reason: 'cache_miss' } });
        const sse = code.startsWith('513');
        return route.fulfill({ json: {
          code, date: state.mode === 'wrong-date' ? '2000-01-01' : date, source: state.mode === 'wrong-source' ? 'bad_source' : sse ? 'sse_pcf' : 'szse_pcf',
          prevDayDate: '2026-10-08', prevDayNav: 1.5499, prevDayUnitNav: 100, prevDayCashDifference: 5388,
          ...(sse ? { nav: 2.3456, navPerCreationUnit: 234560, tradingDay: '20261012', creationRedemption: '申购和赎回皆允许' } : {}),
          estimatedCashDifference: 4275.36, cashSubstitutionRatioLimitPct: 100, iopvRequired: true,
          subscriptionAllowed: true, redemptionAllowed: sse, creationRedemptionUnitShares: 1000000,
          totalSubscribeLimitShares: date === '2026-10-09' ? 1000000 : 5000000, totalSubscribeLimitKind: 'limited',
          totalRedeemLimitShares: null, netSubscribeLimitShares: null, netRedeemLimitShares: null,
          accountTotalSubscribeLimitShares: 1000000, accountTotalSubscribeLimitKind: 'limited',
          accountTotalRedeemLimitShares: 0, accountTotalRedeemLimitKind: 'limited',
          accountNetSubscribeLimitShares: null, accountNetSubscribeLimitKind: 'unlimited',
          accountNetRedeemLimitKind: 'unknown'
        } });
      }
      // 所有其余 API（包括 admin 雷达）本地拦截；仅三个构建入口可访问 HTTP server。
      if (url.origin === base && ['/', '/app.js', '/app.css'].includes(url.pathname)) return route.continue();
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, json: { records: [], data: [], items: [] } });
      escaped.push(url.href);
      return route.abort();
    });
    t.after(() => assert.deepEqual(escaped, [], 'unexpected network request'));
    await page.goto(`${base}/${query}`);
    const card = code => page.locator('.nx-grid .nx-card').filter({ hasText: code });
    const open = async code => {
      await card(code).getByRole('button', { name: /PCF 清单/ }).click();
      await page.getByRole('dialog', { name: new RegExp(code) }).waitFor();
    };
    const close = async () => {
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    };
    return { page, card, requests, state, pending, failed, open, close };
  }

  await t.test('直接映射：四类限额、日期、统计；替代：九列表格、结论排序、delta/总份额/额度用满', async t => {
    const { page, card, requests } = await setup(t);
    await card('159501').waitFor();
    assert.equal(await page.locator('.nx-card').count(), 13);
    assert.equal(await card('159501').locator('.nx-limit').count(), 4);
    assert.deepEqual(await card('159501').locator('.nx-limit-label').allTextContents(), ['累计申购', '净申购', '单账户累计', '单账户净申购']);
    assert.deepEqual(await card('159501').locator('.nx-limit-mark').allTextContents(), ['▼ ×0.5', '▲ ×2.5', '—']);
    assert.match(await card('159501').locator('.nx-limit-val').nth(1).textContent(), /1,000万份.*400万份/);
    assert.match(await card('159660').locator('.nx-limit').nth(2).textContent(), /▼ ×0.5/);
    for (const [code, label] of [['159501', '▲放宽'], ['159509', '▼收紧'], ['159513', '▼收紧'], ['159632', '▲放宽'], ['159659', '◆有升有降'], ['159660', '▼收紧'], ['159941', '—未变']]) {
      assert.equal(await card(code).locator('.nx-head-row .nx-pill').textContent(), label);
    }
    assert.deepEqual(await page.locator('.nx-tile b').allTextContents(), ['13', '4', '3', '2']);
    assert.match(await page.locator('.nx-meta').textContent(), /限额日 2026-10-13 对比 2026-10-09.*份额 2026-10-09 → 2026-10-12.*抓取 2026-10-13 09:03:20/);
    // 替代：旧百分比、估算/确定申购、上期份额转为沪深统一 delta、总份额、暂停和 atLimit。
    // 计算语义仍由 etfPcfSharesProjection/schema/client 单测覆盖；默认 UI 不再显示这些旧字段。
    assert.equal(await card('159501').locator('.nx-delta').textContent(), '+1,000万份');
    assert.equal(await card('159501').locator('.nx-full').textContent(), '额度用满');
    assert.match(await card('159501').locator('.nx-foot').textContent(), /总份额 200.1亿份/);
    assert.equal(await card('159632').locator('.nx-delta.neg').textContent(), '-100万份');
    assert.equal(await card('159941').locator('.nx-delta.zero').textContent(), '无变化');
    assert.equal(await card('513870').locator('.nx-delta.muted').textContent(), '暂无');
    assert.equal(await card('513100').locator('.nx-pill.code').textContent(), '沪 513100');
    assert.equal(await card('159501').locator('.nx-pill.code').textContent(), '深 159501');
    assert.equal(await card('513100').locator('.nx-pill.paused').textContent(), '仅赎回');
    assert.equal(await card('513100').locator('.nx-delta').textContent(), '+1,000万份');
    assert.match(await card('513100').locator('.nx-foot').textContent(), /总份额 300亿份/);
    assert.equal(await card('513110').locator('.nx-delta').textContent(), '+100万份');
    assert.equal(await card('513300').locator('.nx-delta').textContent(), '+450万份');
    assert.equal(await card('513390').locator('.nx-delta').textContent(), '+200万份');
    assert.equal(await card('159659').locator('.nx-limit-val').nth(0).textContent(), '不限');
    assert.equal(await card('159660').locator('.nx-limit-val').nth(0).textContent(), '—');
    assert.equal(await card('159513').locator('.nx-limit-mark').nth(0).textContent(), '▼');
    assert.equal(await card('159632').locator('.nx-limit-mark').nth(0).textContent(), '▲');
    assert.equal(await card('513110').locator('.nx-full').count(), 0);
    assert.equal(await card('513300').locator('.nx-full').count(), 0);
    // 替代：旧五列/三态排序/像素条/净流入汇总/禁 KPI 箭头/胶囊 → 结论排序、稳定顺序和两视图一致。
    // 旧数值与像素文案契约仅属于 LegacySharesPanel，不作为默认页契约；仍禁止新增金额估算。
    const codes = await page.locator('.nx-card .nx-pill.code').allTextContents();
    assert.deepEqual(codes.slice(0, 6), ['深 159509', '深 159513', '深 159660', '深 159659', '深 159501', '深 159632']);
    assert.equal(await page.locator('.usage-meter, [role="progressbar"]').count(), 0);
    assert.doesNotMatch(await page.locator('.nx-panel').textContent(), /新增金额估算|估算申购|确定申购|顶格 100%/);
    for (const [name, count] of [['限额有变化', 6], ['额度用满', 2], ['深市', 8], ['沪市', 5], ['全部', 13]]) {
      await page.locator('.filter-group').getByRole('button', { name: new RegExp(`^${name}`) }).click();
      assert.equal(await page.locator('.nx-card').count(), count);
    }
    await page.getByRole('textbox', { name: '搜索代码或简称' }).fill('does-not-exist');
    await page.getByText('没有符合条件的基金').waitFor();
    await page.getByRole('button', { name: '清空搜索' }).click();
    await page.getByRole('textbox', { name: '搜索代码或简称' }).fill('159501');
    assert.equal(await page.locator('.nx-card').count(), 1);
    await page.getByRole('button', { name: '清空搜索' }).click();
    await page.getByTitle('表格', { exact: true }).click();
    await page.locator('.nx-table tbody tr').filter({ hasText: '159501' }).waitFor();
    assert.equal(await page.locator('.nx-table thead th').count(), 9);
    assert.deepEqual(await page.locator('.nx-table .nx-pill.code').allTextContents(), codes);
    const row = page.locator('.nx-table tbody tr').filter({ hasText: '159501' });
    assert.equal(await row.locator('td').count(), 9);
    assert.match(await row.locator('td').nth(2).textContent(), /1,000万份.*原 2,000万份/);
    assert.match(await row.locator('td').nth(3).textContent(), /1,000万份.*原 400万份/);
    assert.equal(await row.locator('td').nth(4).textContent(), '100万份');
    assert.equal(await row.locator('td').nth(5).textContent(), '—');
    assert.equal(await row.getByRole('button', { name: /PCF 清单/ }).count(), 1);
    const before = await page.evaluate(() => window.__sharesSubs);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(n => window.__sharesSubs === n + 1, before);
    assert.equal(await page.locator('.nx-table tbody tr').count(), 13);
    assert.equal(await page.evaluate(() => localStorage.getItem('etf-shares:view-mode')), 'table');
    await page.getByTitle('卡片', { exact: true }).click();
    assert.equal(await page.locator('.nx-card').count(), 13);
    assert.equal(requests.length, 0);
    await page.evaluate(() => { window.__calm = true; });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.nx-head-row .nx-pill')].every(e => e.textContent === '—未变'));
    assert.deepEqual(await page.locator('.nx-tile b').allTextContents(), ['13', '0', '0', '2']);
    assert.equal(requests.length, 0);
  });

  await t.test('直接映射：键盘开 dialog、14+3+环比四行、缓存、单详情和请求日期', async t => {
    const { page, card, requests, state, pending, failed, open, close } = await setup(t);
    await card('159501').waitFor();
    state.mode = 'pending';
    await card('159501').getByRole('button', { name: /PCF 清单/ }).focus();
    await page.keyboard.press('Enter');
    await page.getByText('正在读取申赎信息…').waitFor();
    assert.deepEqual(requests, [{ code: '159501', date: '2026-10-12' }]);
    // 替代：旧 aria-expanded/整行手风琴 → 标题关联 dialog，关闭卸载并释放 pending 请求。
    assert.equal(await page.getByRole('dialog', { name: /159501/ }).getAttribute('aria-modal'), 'true');
    await close();
    await expect.poll(() => failed.length).toBe(1);
    for (const route of pending) await route.abort().catch(() => {});
    state.mode = 'ready';
    await open('159501');
    const region = page.locator('#shares-detail-159501');
    await region.getByText('1.5499', { exact: true }).waitFor();
    assert.equal(await region.getAttribute('role'), 'region');
    assert.equal(await region.getAttribute('aria-labelledby'), 'nx-modal-title-159501');
    assert.equal(await page.getByRole('dialog').getAttribute('aria-labelledby'), 'nx-modal-title-159501');
    assert.equal(requests.length, 2);
    assert.deepEqual(await region.locator('.pcf-date-pill').allTextContents(), ['2026-10-09 → 2026-10-12', 'T 日：2026-10-12', 'P 日：2026-10-08']);
    const compareRows = region.locator('.limit-compare .pcf-kv-row');
    assert.equal(await compareRows.count(), 4);
    assert.deepEqual(await compareRows.locator('dt').allTextContents(), ['累计申购', '净申购', '单账户累计申购', '单账户净申购']);
    assert.deepEqual(await compareRows.locator('.pcf-kv-val > span:not(.limit-change)').allTextContents(), ['2000.00万份 → 1000.00万份', '400.00万份 → 1000.00万份', '100.00万份 → 100.00万份', '— → —']);
    assert.deepEqual(await compareRows.locator('.limit-change').allTextContents(), ['减少至 0.5倍', '新增 2.5倍', '持平', '不可比']);
    assert.equal(await region.locator('.pcf-card.t-day .pcf-kv-row').count(), 14);
    assert.equal(await region.locator('.pcf-card.p-day .pcf-kv-row').count(), 3);
    for (const [label, value] of [['单账户累计申购上限', '100.00万份'], ['单账户累计赎回上限', '0份'], ['单账户净申购上限', '不设上限'], ['单账户净赎回上限', '—']]) {
      assert.equal(await region.locator('.pcf-card.t-day .pcf-kv-row').filter({ hasText: label }).locator('dd').textContent(), value);
    }
    assert.equal(await region.locator('.allow-chip.ok').textContent(), '✓ 允许');
    assert.equal(await region.locator('.allow-chip.blocked').textContent(), '✕ 暂停');
    // 替代：旧页尾三条说明 → 详情 IOPV 非金额依据说明；旧 partial 横幅 → 独立 stale 场景。
    assert.match(await region.locator('.pcf-formula').textContent(), /IOPV/);
    await page.keyboard.press('Escape');
    await region.waitFor({ state: 'detached' });
    const before = requests.length;
    await open('159501');
    await region.getByText('1.5499', { exact: true }).waitFor();
    assert.equal(requests.length, before);
    await close();
    await open('159509');
    await page.locator('#shares-detail-159509').getByText('1.5499', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.equal(await region.count(), 0);
    assert.equal(await page.locator('#shares-detail-159509 .pcf-date-pill').nth(0).textContent(), '— → 2026-10-12');
    await page.locator('.nx-modal-mask').click({ position: { x: 1, y: 1 } });
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await open('513100');
    await page.getByText('上交所官方 PCF').waitFor();
    assert.deepEqual(requests.at(-1), { code: '513100', date: '2026-10-16' });
    assert.equal(await page.locator('#shares-detail-513100 .pcf-card.t-day .pcf-kv-row').count(), 14);
    await close();
    await open('159941');
    await page.locator('#shares-detail-159941').getByText('1.5499', { exact: true }).waitFor();
    assert.deepEqual(requests.at(-1), { code: '159941', date: data.date });
    assert.ok(requests.every(r => ['159501', '159509', '513100', '159941'].includes(r.code)));
  });

  await t.test('直接映射：详情 error/empty、环比独立保留、只有手动重试新增请求', async t => {
    const { page, card, requests, state, open } = await setup(t);
    await card('159632').waitFor();
    state.mode = 'error';
    await open('159632');
    await page.getByText('申赎信息读取失败，可点击重试').waitFor();
    const region = page.locator('#shares-detail-159632');
    assert.equal(await region.locator('.limit-compare .pcf-kv-row').count(), 4);
    assert.equal(await region.locator('.limit-compare .pcf-kv-row').nth(0).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '1000.00万份 → 不设上限');
    assert.equal(await region.locator('.limit-compare .limit-change').nth(0).textContent(), '取消限额');
    // 完整字段的不可比替代旧缺项：四行均保留，未知不猜数值。
    assert.equal(await region.locator('.limit-compare .pcf-kv-row').nth(1).locator('.pcf-kv-val > span:not(.limit-change)').textContent(), '— → —');
    assert.equal(requests.length, 1);
    state.mode = 'empty';
    await page.getByRole('button', { name: '重试读取', exact: true }).click();
    await page.getByText('暂无该日期的申赎缓存数据，等待更新').waitFor();
    assert.equal(requests.length, 2);
    assert.equal(await region.locator('.limit-compare .pcf-kv-row').count(), 4);
    assert.ok(requests.every(r => r.code === '159632' && r.date === '2026-10-12'));
  });

  await t.test('替代：旧快照只请求可见 code 的两日 PCF、去重、日期回退和一次失败重试', async t => {
    const { page, card, requests } = await setup(t, '?legacy');
    await card('159501').waitFor();
    await page.waitForFunction(() => document.querySelector('.nx-head-row .nx-pill')?.textContent === '▲放宽');
    assert.deepEqual(requests.map(r => `${r.code}:${r.date}`).sort(), ['159501:2026-10-09', '159501:2026-10-12']);
    assert.match(await page.locator('.nx-meta').textContent(), /限额日 2026-10-12/);
    await page.locator('.filter-group').getByRole('button', { name: /^深市/ }).click();
    await page.getByTitle('表格', { exact: true }).click();
    await page.locator('.nx-table tbody tr').filter({ hasText: '159501' }).waitFor();
    assert.equal(requests.length, 2);
    // 直接映射：同 key 客户端缓存复用，无额外请求。
    const result = await page.evaluate(async () => {
      const a = window.__detailClient.subscribe('159501', '2026-10-12');
      const b = window.__detailClient.subscribe('159501', '2026-10-12');
      const result = await Promise.all([a.promise, b.promise]);
      a.release(); b.release();
      return result.map(r => r.data.source);
    });
    assert.deepEqual(result, ['szse_pcf', 'szse_pcf']);
    assert.equal(requests.length, 2);
  });

  await t.test('替代：旧快照 fallback 失败最多重试一次，筛选不扩散 code', async t => {
    const { page, card, requests, state } = await setup(t, '?empty');
    // 在同一新上下文首次加载 legacy 前设置拦截状态；导航会重建模块缓存。
    state.mode = 'error';
    await page.goto(`${base}/?legacy`);
    await card('159501').waitFor();
    await expect.poll(() => requests.length).toBe(4);
    await page.clock.install();
    await page.clock.runFor(5000);
    assert.equal(await card('159501').locator('.nx-head-row .nx-pill').textContent(), '待对比');
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(r => r.date), ['2026-10-12', '2026-10-09', '2026-10-12', '2026-10-09']);
    assert.ok(requests.every(r => r.code === '159501'));
    await page.locator('.filter-group').getByRole('button', { name: /^深市/ }).click();
    assert.equal(requests.length, 4);
  });

  await t.test('直接映射：stale/empty/error 与重试订阅增量', async t => {
    const { page, requests } = await setup(t, '?stale');
    await page.locator('.nx-meta .stale').waitFor();
    assert.equal(await page.locator('.nx-meta .stale').textContent(), '本地缓存，待重新确认');
    await page.goto(`${base}/?empty`);
    await page.getByText('暂无已验证快照', { exact: true }).waitFor();
    assert.equal(await page.locator('.nx-card, .nx-table').count(), 0);
    await page.goto(`${base}/?error`);
    await page.getByText('读取失败', { exact: true }).waitFor();
    assert.equal(await page.locator('.state-view.error[role="alert"]').count(), 1);
    const before = await page.evaluate(() => window.__sharesSubs);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(n => window.__sharesSubs === n + 1, before);
    assert.equal(requests.length, 0);
  });

  await t.test('替代：390px 三行手机条目、640/641 React 分支、详情状态与订阅保留', async t => {
    const { page, requests } = await setup(t, '', 390);
    const row = code => page.locator('.nx-m-row').filter({ hasText: code });
    await row('159501').waitFor();
    assert.equal(await page.locator('.nx-m-row').count(), 13);
    assert.equal(await row('159501').locator('.nx-m-status').textContent(), '▲放宽');
    assert.match(await row('159501').locator('.nx-m-l2').nth(0).textContent(), /累计 2000万→1000万份（×0.5）.*净申购 400万→1000万份（×2.5）/);
    assert.match(await row('159501').locator('.nx-m-l2').nth(1).textContent(), /盘前 10-09→10-12.*\+1,000万份.*额度用满.*200.1亿/);
    assert.equal(await row('159501').locator('.nx-m-full').textContent(), '额度用满');
    assert.match(await row('513100').textContent(), /仅允许赎回/);
    assert.equal(requests.length, 0);
    await row('159501').click();
    await page.locator('#shares-detail-159501').getByText('1.5499', { exact: true }).waitFor();
    assert.equal(await page.locator('#shares-detail-159501 .limit-compare .pcf-kv-row').count(), 4);
    assert.equal(await page.locator('#shares-detail-159501 .pcf-card.t-day .pcf-kv-row').count(), 14);
    assert.equal(await page.locator('#shares-detail-159501 .pcf-card.p-day .pcf-kv-row').count(), 3);
    for (const width of [640, 641, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator(width <= 640 ? '.nx-m-list' : '.nx-grid').waitFor();
      assert.equal(await page.getByRole('dialog', { name: /159501/ }).count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(requests.length, 1);
    }
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  });

  await t.test('直接映射：旧 #shares 深链直达公开看板、无雷达子 tab、history 不膨胀', async t => {
    const { page, requests } = await setup(t, '?tab=adminRadar#shares');
    await page.locator('.shares-panel.nx-panel .nx-card').filter({ hasText: '159501' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '份额新增' }).count(), 0);
    assert.equal(await page.getByRole('tab', { name: '套利雷达' }).count(), 0);
    const length = await page.evaluate(() => history.length);
    await page.evaluate(() => {
      history.replaceState(history.state, '', '#radar');
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await page.locator('.shares-panel').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('tab', { name: '套利雷达' }).count(), 0);
    await page.evaluate(() => {
      history.replaceState(history.state, '', '#shares');
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await page.locator('.shares-panel.nx-panel .nx-card').filter({ hasText: '159501' }).waitFor();
    assert.equal(await page.evaluate(() => history.length), length);
    await page.goto(`${base}/?tab=adminRadar&denied#shares`);
    await page.locator('.shares-panel.nx-panel .nx-card').filter({ hasText: '159501' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '份额新增' }).count(), 0);
    await page.evaluate(() => {
      history.replaceState(history.state, '', '#radar');
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await page.getByText('持仓兜底', { exact: true }).waitFor();
    assert.equal(await page.locator('.shares-panel').count(), 0);
    assert.equal(requests.length, 0);
  });
});
