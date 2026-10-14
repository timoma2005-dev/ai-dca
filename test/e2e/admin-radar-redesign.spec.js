import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mockAcceptanceNetwork } from './acceptance-helpers.js';

test.use({ video: 'off' });
if (existsSync('/opt/meta-chromium/chrome'))
  test.use({ launchOptions: { executablePath: '/opt/meta-chromium/chrome', args: ['--no-sandbox'] } });

// 12 只真实标的全集（与 workers/notify/src/nasdaqRadar.js NASDAQ_ETFS 一致），不硬编码原型 8 只。
const RADAR_ETFS = [
  { code: '159513', name: '大成纳斯达克100ETF', premium: 1.96 },
  { code: '159659', name: '招商纳斯达克100ETF', premium: 8.42 },
  { code: '159941', name: '广发纳斯达克100ETF', premium: 6.88 },
  { code: '159696', name: '易方达纳斯达克100ETF', premium: 2.71 },
  { code: '159632', name: '华安纳斯达克100ETF', premium: 5.17 },
  { code: '513390', name: '博时纳斯达克100ETF', premium: 4.05 },
  { code: '513300', name: '华夏纳斯达克100ETF', premium: 3.9 },
  { code: '159501', name: '嘉实纳斯达克100ETF', premium: 3.24 },
  { code: '513870', name: '富国纳斯达克100ETF', premium: 2.5 },
  { code: '159660', name: '汇添富纳斯达克100ETF', premium: 4.8 },
  { code: '513110', name: '华泰柏瑞纳斯达克100ETF', premium: 2.33 },
  { code: '513100', name: '国泰纳斯达克100ETF', premium: 3.11 }
];

function radarSnapshot({ date = '2026-10-13', computedAt = '2026-10-13T13:36:05.000Z' } = {}) {
  return {
    date,
    computedAt,
    premiumSource: 'eastmoney-fundmobapi-nav',
    etfs: RADAR_ETFS,
    bestPair: {
      sell: { code: '159659', name: '招商纳斯达克100ETF', premium: 8.42 },
      buy: { code: '159513', name: '大成纳斯达克100ETF', premium: 1.96 },
      spread: 6.46,
      percentile: 92,
      historyDays: 20
    },
    recentOpportunities: [
      { date: '2026-10-13', pair: '159659 → 159513', spread: 6.46 },
      { date: '2026-10-12', pair: '159659 → 159941', spread: 5.82 }
    ],
    maturity: {
      days: 23,
      level: 4,
      label: '较稳定',
      dots: '●●●●○',
      enabledWeights: {
        base: ['规模', '当前流动性', 'ADTV20'],
        premiumStats20: ['PremiumStd20', 'PremiumMAD20'],
        liquidityStats30: []
      }
    }
  };
}

async function setupRadar(
  page,
  { admin = true, radarMode = 'snapshot', computeFail = false, holdRadar = false, holdCompute = false, time } = {}
) {
  await mockAcceptanceNetwork(page);
  if (time) await page.clock.install({ time });
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
  const counts = { radar: 0, compute: 0, shares: 0, heavy: 0 };
  let mode = radarMode;
  let releaseRadar;
  const radarGate = new Promise((resolvePromise) => (releaseRadar = resolvePromise));
  // 注意 `*` 不跨 `/`：compute 路径必须用 `**` 结尾才能拦到 /nasdaq-radar/compute。
  await page.route('**/api/notify/nasdaq-radar**', async (route) => {
    if (route.request().method() === 'POST') {
      counts.compute++;
      if (holdCompute) {
        await new Promise(() => {}); // 一直挂起：观察 submitting 期间各入口禁用
      }
      if (computeFail) {
        await route.fulfill({ json: { ok: false, error: 'boom' } });
        return;
      }
      await route.fulfill({ json: { ok: true, data: radarSnapshot({ date: '2026-10-14' }) } });
      return;
    }
    counts.radar++;
    if (holdRadar) await radarGate;
    if (mode === 'error') await route.fulfill({ status: 500, json: { error: 'boom' } });
    else if (mode === 'invalid') await route.fulfill({ json: { ok: false, error: 'kv_unavailable' } });
    else if (mode === 'empty') await route.fulfill({ json: { data: null } });
    else if (mode === 'partial') await route.fulfill({ json: { data: { ...radarSnapshot(), bestPair: undefined } } });
    else await route.fulfill({ json: { data: radarSnapshot() } });
  });
  await page.route('**/api/etf-pcf-shares*', async (route) => {
    counts.shares++;
    await route.fulfill({ status: 404, json: { reason: 'cache_miss' } });
  });
  // 雷达页不得引入行情详情级请求。
  page.on('request', (request) => {
    if (/\/api\/.*(kline|nav-history|nav-snapshot|financial|raw-detail|ai-summary|fund-limit)/.test(request.url()))
      counts.heavy++;
  });
  await page.goto('./index.html?tab=adminRadar');
  return {
    counts,
    releaseRadar,
    setRadarMode: (value) => {
      mode = value;
    }
  };
}

/** 北京时间 → Date（页面时钟安装用）。 */
const beijing = (y, mo, d, h, mi, s = 0) => new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s));

const gridColumns = (page) => page.getByTestId('radar-dashboard-grid').locator('> div');

test('desktop shows hero, ranking N, countdown, session pill and 7:4 columns without overflow', async ({
  page
}) => {
  const { counts } = await setupRadar(page);
  await expect(page.getByRole('heading', { name: '纳指 ETF 套利雷达' })).toBeVisible();
  await expect(page.getByText('今日最优套利机会')).toBeVisible();
  await expect(page.getByText('159659', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('article').getByText('价差 6.46%')).toBeVisible();
  await expect(page.getByText('12 只纳指 ETF 溢价排行')).toBeVisible();
  await expect(page.getByText('溢价差历史分位（近 20 个交易日）')).toBeVisible();
  await expect(page.getByText('92分位', { exact: true })).toBeVisible();
  await expect(page.getByText(/雷达快照 \/ 收盘口径，净值日期未验证/).first()).toBeVisible();
  await expect(page.getByText(/距(今日|明日) 21:35/)).toBeVisible();
  await expect(page.getByText('计算控制台')).toBeVisible();
  await expect(page.getByText('数据成熟度')).toBeVisible();
  await expect(page.getByText('近期套利机会')).toBeVisible();
  await expect(page.getByText('每日 21:35 数据生产流水线').first()).toBeVisible();
  expect(counts.radar).toBe(1);
  expect(counts.compute).toBe(0);
  expect(counts.shares).toBe(0);
  expect(counts.heavy).toBe(0);

  // 1024px 及以上双列 7:4；1023px 及以下单列；多断点无横向溢出并截图。
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const columns = gridColumns(page);
    await expect(columns).toHaveCount(2);
    const [left, right] = await columns.all();
    const leftBox = await left.boundingBox();
    const rightBox = await right.boundingBox();
    expect(leftBox.y).toBe(rightBox.y); // 双列同行
    expect(leftBox.width / rightBox.width).toBeGreaterThan(1.5);
    expect(leftBox.width / rightBox.width).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/radar-redesign-${width}.png`, fullPage: true });
  }
  for (const width of [1023, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const columns = gridColumns(page);
    await expect(columns).toHaveCount(2);
    const [left, right] = await columns.all();
    const leftBox = await left.boundingBox();
    const rightBox = await right.boundingBox();
    expect(Math.abs(leftBox.x - rightBox.x)).toBeLessThanOrEqual(1); // 单列对齐堆叠
    expect(Math.abs(leftBox.width - rightBox.width)).toBeLessThanOrEqual(1);
    expect(rightBox.y).toBeGreaterThan(leftBox.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/radar-redesign-${width}.png`, fullPage: true });
  }
  expect(counts.radar).toBe(1); // tick / 断言期间零额外请求
});

test('ranking row interaction opens inline advice; lowest row shows no-switch conclusion', async ({ page }) => {
  const { counts } = await setupRadar(page);
  const row = page.getByRole('button', { name: /159660/ });
  await row.click();
  await expect(page.getByText('持有 159660 的轮动切换建议')).toBeVisible();
  await expect(page.getByText(/溢价差（百分点），未计交易成本/)).toBeVisible();
  await row.click(); // 重复点击关闭
  await expect(page.getByText('持有 159660 的轮动切换建议')).toHaveCount(0);
  await page.getByRole('button', { name: /159513/ }).click(); // 最低溢价行
  await expect(page.getByText(/已是当前有效标的中最低溢价/)).toBeVisible();
  expect(counts.radar).toBe(1); // 选择 ETF 零额外请求
  expect(counts.heavy).toBe(0);
  expect(counts.compute).toBe(0);
});

test('tab switch and back reuses 60s memory cache with zero refetch; radar active keeps zero shares reads', async ({
  page
}) => {
  const { counts } = await setupRadar(page);
  await expect(page.getByText('今日最优套利机会')).toBeVisible();
  expect(counts.radar).toBe(1);
  expect(counts.shares).toBe(0);
  await page.getByRole('tab', { name: '份额新增', exact: true }).click();
  await expect(page.getByText('暂无已验证份额快照，等待定时任务更新')).toBeVisible();
  expect(counts.shares).toBe(1);
  expect(counts.radar).toBe(1);
  await page.getByRole('tab', { name: '套利雷达', exact: true }).click();
  await expect(page.getByText('今日最优套利机会')).toBeVisible();
  expect(counts.radar).toBe(1); // TTL 内回切命中 memory，零 fetch
  expect(counts.heavy).toBe(0);
  expect(counts.compute).toBe(0);
});

test('wait window (15:00-21:35) opens read-only notice with zero POST', async ({ page }) => {
  const { counts } = await setupRadar(page, { time: beijing(2026, 10, 14, 16, 30) });
  await expect(page.getByText('收盘后等待净值披露').first()).toBeVisible();
  await page.getByRole('button', { name: '手动触发计算' }).click();
  await expect(page.getByText('已进入收盘后等待窗口')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始计算' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '强制覆盖正式数据' })).toHaveCount(0);
  await page.getByRole('button', { name: '知道了' }).click();
  await expect(page.getByText('已进入收盘后等待窗口')).toHaveCount(0);
  await page.getByRole('button', { name: '手动执行雷达计算' }).click();
  await expect(page.getByText('已进入收盘后等待窗口')).toBeVisible();
  await page.keyboard.press('Escape'); // Esc 也是关闭路径
  await expect(page.getByText('已进入收盘后等待窗口')).toHaveCount(0);
  expect(counts.compute).toBe(0);
  expect(counts.radar).toBe(1);
});

test('intraday risk dialog requires checkbox, resets on reopen, single POST with same-frame double click', async ({
  page
}) => {
  const { counts } = await setupRadar(page, { time: beijing(2026, 10, 14, 10, 30) });
  await expect(page.getByText('盘中风险窗口（含午休）').first()).toBeVisible();
  await page.getByRole('button', { name: '手动触发计算' }).click();
  await expect(page.getByText('高危操作：当前时段不适合计算')).toBeVisible();
  const forceButton = page.getByRole('button', { name: '强制覆盖正式数据' });
  await expect(forceButton).toBeDisabled();
  await expect(page.getByText('净值与现价错配')).toBeVisible();
  await expect(page.getByText('定时任务复用')).toBeVisible();
  await page.getByRole('button', { name: '放弃操作（推荐）' }).click();
  await expect(page.getByText('高危操作：当前时段不适合计算')).toHaveCount(0);
  expect(counts.compute).toBe(0);

  await page.getByRole('button', { name: '手动触发计算' }).click();
  const checkbox = page.getByRole('checkbox');
  await expect(checkbox).not.toBeChecked(); // 重新打开复位勾选
  await checkbox.check();
  await expect(forceButton).toBeEnabled();
  // 同一帧内连点两次：同步 ref 锁保证只发一次 POST（不能仅靠下一帧的 disabled）。
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('强制覆盖正式数据')
    );
    button.click();
    button.click();
  });
  await expect(page.getByText('已强制计算并写入正式快照')).toBeVisible();
  await expect(page.getByText('2026-10-14 雷达快照 / 收盘口径，净值日期未验证').first()).toBeVisible(); // 成功日期来自 response
  expect(counts.compute).toBe(1);
  expect(counts.radar).toBe(1); // 成功后不跟随无必要 GET
  expect(counts.heavy).toBe(0);
  expect(counts.shares).toBe(0);
});

test('post-close regular confirm posts once and sync-disables every compute entry while submitting', async ({ page }) => {
  const { counts } = await setupRadar(page, {
    time: beijing(2026, 10, 14, 21, 36),
    holdCompute: true
  });
  await expect(page.getByText('已到计划计算窗口 · 净值日期未验证').first()).toBeVisible();
  await page.getByRole('button', { name: '手动触发计算' }).click();
  await expect(page.getByText('确认执行雷达计算')).toBeVisible();
  expect(counts.compute).toBe(0); // 常规确认前零 POST
  await page.getByRole('button', { name: '开始计算' }).click();
  await expect(page.getByText('确认执行雷达计算')).toHaveCount(0); // 提交前关闭弹窗
  // submitting 期间各入口同步禁用（按钮文案变为“计算中…”）。
  await expect(page.getByRole('button', { name: /手动触发计算|计算中…/ }).first()).toBeDisabled();
  await expect(page.getByRole('button', { name: /手动执行雷达计算|计算中…/ }).first()).toBeDisabled();
  await expect(page.getByText('计算中…').first()).toBeVisible();
  expect(counts.compute).toBe(1);
  expect(counts.heavy).toBe(0);
});

test('open dialog re-routes when the session boundary crosses (risk to wait, wait to regular)', async ({ page }) => {
  // 假时钟会随真实时间继续走，起点离边界留足余量，避免断言期间被漂移冲过界。
  const { counts } = await setupRadar(page, { time: beijing(2026, 10, 14, 14, 59, 30) });
  await page.getByRole('button', { name: '手动触发计算' }).click();
  await expect(page.getByText('高危操作：当前时段不适合计算')).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.clock.fastForward(45000); // → 15:00:15 附近，跨入等待窗口
  await expect(page.getByText('已进入收盘后等待窗口')).toBeVisible();
  await expect(page.getByRole('button', { name: '强制覆盖正式数据' })).toHaveCount(0); // 不能带着勾选直接提交
  await page.getByRole('button', { name: '知道了' }).click();

  await page.clock.fastForward(23635000); // → 21:34:10 附近，仍处等待窗口
  await page.getByRole('button', { name: '手动触发计算' }).click();
  await expect(page.getByText('已进入收盘后等待窗口')).toBeVisible();
  await page.clock.fastForward(60000); // 跨过 21:35，进入计划窗口
  await expect(page.getByText('确认执行雷达计算')).toBeVisible(); // 弹窗自动重新分流为常规确认
  expect(counts.compute).toBe(0);
  expect(counts.radar).toBe(1); // 到达 21:35 / 秒级 tick 均零额外请求
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByText('确认执行雷达计算')).toHaveCount(0);
});

test('read error keeps console; retry refetches; compute failure keeps old snapshot for re-verify', async ({ page }) => {
  const { counts, setRadarMode } = await setupRadar(page, {
    radarMode: 'error',
    computeFail: true,
    time: beijing(2026, 10, 14, 12, 0)
  });
  await expect(page.getByText('雷达快照读取失败')).toBeVisible();
  await expect(page.getByText('计算控制台')).toBeVisible(); // 错误态右栏控制台保留
  await expect(page.getByRole('button', { name: '手动执行雷达计算' })).toBeVisible();
  expect(counts.radar).toBe(2); // 主地址 500 后按既有读取降级重试 CF 副本，仍失败
  setRadarMode('snapshot');
  await page.getByRole('button', { name: '重新读取' }).click();
  await expect(page.getByText('今日最优套利机会')).toBeVisible();
  expect(counts.radar).toBe(3);

  // 计算失败：不清空此前有效快照，提示“结果未确认”并提供重新读取核实。
  await page.getByRole('button', { name: '手动触发计算' }).click();
  await expect(page.getByText('高危操作：当前时段不适合计算')).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '强制覆盖正式数据' }).click();
  await expect(page.getByText('结果未确认，请重新读取核实')).toBeVisible();
  await expect(page.getByText('今日最优套利机会')).toBeVisible();
  expect(counts.compute).toBe(1);

  // 核实读取也失败：有旧数据时保留卡片并显示读取错误。
  setRadarMode('error');
  await page.getByRole('button', { name: '重新读取核实' }).click();
  await expect(page.getByText(/本次读取失败/)).toBeVisible();
  await expect(page.getByText('今日最优套利机会')).toBeVisible();
  expect(counts.radar).toBe(5); // 每次失败读 = 主地址 + 副本各一次
  expect(counts.heavy).toBe(0);
});

test('partial snapshot keeps ranking visible and hero missing; empty state shows one pipeline with protected entry', async ({
  page
}) => {
  const { counts } = await setupRadar(page, { radarMode: 'partial' });
  await expect(page.getByText('12 只纳指 ETF 溢价排行')).toBeVisible();
  await expect(page.getByText(/缺少最优套利对/)).toBeVisible();
  await expect(page.getByText('计算控制台')).toBeVisible();
  expect(counts.compute).toBe(0);
  expect(counts.heavy).toBe(0);
});

test('empty state shows single pipeline, protected entry and missing-data side cards', async ({ page }) => {
  const { counts } = await setupRadar(page, { radarMode: 'empty' });
  await expect(page.getByText('今日雷达数据尚未计算')).toBeVisible();
  await expect(page.getByRole('button', { name: '手动触发计算（受时段分级保护）' })).toBeVisible();
  await expect(page.getByText('计算控制台')).toBeVisible();
  await expect(page.getByText('每日 21:35 数据生产流水线')).toHaveCount(1); // 左栏流水线唯一，不重复两份
  await expect(page.getByText('暂无成熟度数据（等待快照与特征历史积累）')).toBeVisible();
  await expect(page.getByText('暂无近期机会记录')).toBeVisible();
  expect(counts.compute).toBe(0);
  expect(counts.heavy).toBe(0);
  expect(counts.shares).toBe(0);
});

test('mobile bottom sheet hides bottom nav on open and restores on every close path', async ({ page }) => {
  const { counts } = await setupRadar(page, { time: beijing(2026, 10, 14, 10, 30) });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible();
  await page.getByRole('button', { name: '手动触发计算' }).click();
  const dialogPanel = page.locator('[data-slot="dialog-content"]');
  await expect(dialogPanel).toHaveClass(/rounded-t-2xl/); // 小于 640px 从底部弹出
  await expect(page.getByTestId('mobile-bottom-nav')).toHaveCount(0); // 打开时隐藏导航
  await page.keyboard.press('Escape');
  await expect(page.getByText('高危操作：当前时段不适合计算')).toHaveCount(0);
  await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible(); // Esc 后恢复

  await page.getByRole('button', { name: '手动触发计算' }).click();
  await expect(page.getByTestId('mobile-bottom-nav')).toHaveCount(0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '强制覆盖正式数据' }).click();
  await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible(); // 提交关闭弹窗即恢复导航
  await expect(page.getByText('已强制计算并写入正式快照')).toBeVisible();
  expect(counts.compute).toBe(1);
  expect(counts.heavy).toBe(0);
});

test('non-admin sees no tabs and triggers zero radar/shares/compute requests', async ({ page }) => {
  const { counts } = await setupRadar(page, { admin: false });
  // 非管理员进不了 adminRadar 工作台（被工作台重定向），也不渲染雷达 Tab。
  await expect(page.getByRole('tab', { name: '套利雷达', exact: true })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(counts.radar).toBe(0);
  expect(counts.shares).toBe(0);
  expect(counts.compute).toBe(0);
  expect(counts.heavy).toBe(0);
});
