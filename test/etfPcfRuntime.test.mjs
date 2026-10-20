// 本地 Workers runtime 验证：用 npx wrangler dev（Miniflare/workerd，兼容日期与生产一致的
// 2026-03-26）启动 test/fixtures/etf-pcf/runtime-harness，在真实 workerd 里验证：
// 1) GBK TextDecoder 解码真实 fixture（Node 通过不代表 workerd 通过）；
// 2) fetchEtfPcfLimit 全流程写 KV 并读回；
// 3) scheduled 模拟：controller.scheduledTime 为毫秒（Cloudflare 文档口径），
//    shanghaiDateKey(new Date(scheduledTime)) 与 runEtfPcfScheduledRefresh 全流程统计。
// 仅本地运行，不部署；wrangler 不在 npx 缓存时跳过（本仓库开发环境已缓存 4.149.0）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Independent SZSE PCF retention contract; SSE/universe TTLs are separate.
const CACHE_TTL_SECONDS = 400 * 86400;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.join(__dirname, 'fixtures/etf-pcf/runtime-harness');
const CONFIG_PATH = path.join(HARNESS_DIR, 'wrangler.toml');
const SCHEDULED_MS = Date.UTC(2026, 9, 13, 1, 0, 0); // 2026-10-13 09:00 上海

const NPM_CLI = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function wranglerAvailable() {
  try {
    const result = spawnSync(NPM_CLI, ['--no-install', 'wrangler', '--version'], {
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000
    });
    // wrangler 4.x 的 --version 只输出数字版本号（如 "4.149.0"），不含 "wrangler" 字样。
    return result.status === 0 && /\d+\.\d+/.test(result.stdout || '');
  } catch (_error) {
    return false;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function startHarness(t) {
  const port = await freePort();
  const child = spawn(
    NPM_CLI,
    [
      '--no-install',
      'wrangler',
      'dev',
      '--config',
      CONFIG_PATH,
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--test-scheduled'
    ],
    {
      cwd: HARNESS_DIR,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    }
  );

  const output = [];
  const record = (chunk) => {
    output.push(String(chunk));
    if (output.length > 400) output.shift();
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const stop = () => {
    if (exited) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (_error) {
      try {
        child.kill('SIGTERM');
      } catch (_e2) {
        // ignore
      }
    }
  };
  t.after(stop);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited) {
      assert.fail('wrangler dev 提前退出：\n' + output.join(''));
    }
    try {
      const response = await fetch(base + '/__test/ping', { signal: AbortSignal.timeout(2000) });
      if (response.ok) return { base, output: () => output.join('') };
    } catch (_error) {
      // 尚未就绪，继续轮询
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  stop();
  assert.fail('wrangler dev 120 秒内未就绪：\n' + output.join(''));
}

async function getJson(base, pathname) {
  const response = await fetch(base + pathname, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, pathname + ' -> HTTP ' + response.status);
  return response.json();
}

test('本地 workerd（2026-03-26 兼容日期）GBK 解码、KV 写入与 scheduled 模拟', { skip: wranglerAvailable() ? false : 'npx 缓存中无 wrangler，跳过本地运行时验证' }, async (t) => {
  const { base } = await startHarness(t);

  // 1) GBK 解码 + 全字段解析在 workerd 内完成（fatal 解码对非法字节抛错）。
  const decoded = await getJson(base, '/__test/decode');
  assert.equal(decoded.ok, true);
  assert.equal(decoded.fundName, '纳指ETF广发');
  assert.equal(decoded.fundType, '跨境ETF');
  assert.equal(decoded.fundManager, '广发基金管理有限公司');
  assert.equal(decoded.targetIndexCode, 'NDX');
  assert.equal(decoded.netSubscribeLimitShares, 1300000);
  assert.equal(decoded.netSubscribeLimitKind, 'limited');
  assert.equal(decoded.netRedeemLimitShares, 1000000000);
  assert.equal(decoded.netRedeemLimitKind, 'limited');
  assert.equal(decoded.accountNetSubscribeLimitKind, 'unlimited');
  assert.equal(decoded.accountTotalSubscribeLimitShares, 1300000);
  assert.equal(decoded.totalRedeemLimitKind, 'unlimited');
  assert.equal(decoded.creationRedemptionUnitShares, 1300000);
  assert.equal(decoded.subscriptionAllowed, true);
  assert.equal(decoded.redemptionAllowed, true);
  assert.equal(decoded.estimatedCashDifference, 4275.36);
  assert.equal(decoded.cashSubstitutionRatioLimitPct, 100);
  assert.equal(decoded.iopvRequired, true);
  assert.equal(decoded.unitCashDividend, 0);
  assert.equal(decoded.localBasketSecurityCount, 1);
  assert.equal(decoded.totalBasketSecurityCount, 102);
  assert.deepEqual(decoded.warnings, []);

  const invalidBytes = await getJson(base, '/__test/decode-invalid');
  assert.equal(invalidBytes.throws, true, 'workerd 的 fatal GBK 解码必须拒绝非法字节');

  // 2) 单标的刷新全流程写 KV（Miniflare 本地 namespace）并可读回。
  const refreshed = await getJson(base, '/__test/fetch-limit');
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.cached, false);
  assert.equal(refreshed.data.code, '159941');
  assert.equal(refreshed.data.date, '2026-10-13');

  const cached = await getJson(base, '/__test/read-cache');
  assert.equal(cached.found, true);
  assert.equal(cached.key, 'etf-pcf:159941:20261013');
  assert.equal(cached.code, '159941');
  assert.equal(cached.fundName, '纳指ETF广发');
  assert.equal(cached.netSubscribeLimitShares, 1300000);
  assert.equal(cached.netRedeemLimitShares, 1000000000);
  assert.equal(cached.fetchedAt, '2026-10-13T01:30:00.000Z');
  assert.equal(cached.expiresAt, new Date(Date.parse(cached.fetchedAt) + CACHE_TTL_SECONDS * 1000).toISOString());

  // 3) scheduled 模拟：time 参数按毫秒透传给 controller.scheduledTime。
  const cronQuery = encodeURIComponent('0 1 * * *');
  let scheduledOk = false;
  for (const endpoint of [
    `/cdn-cgi/handler/scheduled?cron=${cronQuery}&time=${SCHEDULED_MS}`,
    `/__scheduled?cron=${cronQuery}&time=${SCHEDULED_MS}`
  ]) {
    try {
      const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) {
        scheduledOk = true;
        break;
      }
    } catch (_error) {
      // 尝试下一个入口
    }
  }
  assert.ok(scheduledOk, 'wrangler dev 的 scheduled 模拟入口不可用');

  // 等 harness 记录 scheduled 执行结果。
  const deadline = Date.now() + 30_000;
  let record = null;
  while (Date.now() < deadline) {
    record = await getJson(base, '/__test/last-scheduled');
    if (record && record.cron === '0 1 * * *') break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(record && record.cron === '0 1 * * *', 'scheduled handler 未执行');
  // 毫秒语义 echo：本地 workerd 与 Cloudflare 文档口径一致，生产代码 new Date(scheduledTime) 成立。
  assert.equal(record.scheduledTime, SCHEDULED_MS);
  assert.equal(record.dateFromMs, '2026-10-13');
  assert.equal(record.summary.ok, true);
  assert.equal(record.summary.date, '2026-10-13');
  assert.equal(record.summary.probeTotal, 1000);
  assert.equal(record.summary.probeExists, 1);
  assert.equal(record.summary.probeNotFound, 999);
  assert.equal(record.summary.probeFailed, 0);
  assert.equal(record.summary.total, 1);
  assert.equal(record.summary.success, 1);
  assert.equal(record.summary.degraded, false);
});
