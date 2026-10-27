#!/usr/bin/env node
/**
 * auth 双活对账 + outbox 告警巡检。
 *
 * 背景见 docs/plan-auth-local-sqlite.md：CN 本地 auth 服务（services/auth）是
 * 用户/凭据的唯一写入口，注册、登录只依赖本地 SQLite 事务，再经 sync_outbox
 * 至少一次投递到 CF D1（workers/account 与 workers/sync 共用 ai-dca-sync-db）。
 * 本脚本做两件事：
 *
 *   1. 告警：巡检 auth /health 的 outbox {pending, processing, dead}，
 *      dead 非零即严重；pending 积压、processing 超租约为警告。
 *   2. 对账：按 export-local.mjs 的 `wrangler d1 export --remote` + node:sqlite
 *      暂存范式拉取远端 D1，逐行核对本地 users / 未过期 sessions 是否一致。
 *      outbox 完成事件在本地是物理删除（markEventDone），无法按 event_id 回溯，
 *      因此对账以最终状态为准：本地存在而 D1 缺失/不一致即投递缺口。
 *
 * 用法：
 *   node scripts/auth-reconcile.mjs [--db PATH] [--health URL|none]
 *        [--pending-warn N] [--staging DIR] [--skip-remote] [--json]
 * 退出码：存在 critical 发现时为 1，否则 0。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH = '/var/lib/ai-dca-auth/auth.sqlite';
export const DEFAULT_HEALTH_URL = 'http://127.0.0.1:8080/health';
export const DEFAULT_PENDING_WARN = 50;
// 与 services/auth/src/outbox.js CLAIM_LEASE_MS 对齐：超过该时长仍 processing
// 说明消费者崩溃后租约回收也没能让事件重新投递（或 syncWorker 停摆）。
export const CLAIM_LEASE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function finding(severity, code, message) {
  return { severity, code, message };
}

/** 从 wrangler.toml 文本中提取首个 [[d1_databases]] 块的字段。 */
export function parseWranglerD1(configText) {
  for (const block of configText.split(/(?=^\[)/m)) {
    if (!block.startsWith('[[d1_databases]]')) continue;
    const fields = Object.fromEntries(
      [...block.matchAll(/^\s*(\w+)\s*=\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]])
    );
    if (fields.database_name) return fields;
  }
  return null;
}

/** 依次在 account / sync worker 配置里定位共用的 D1（ai-dca-sync-db）。 */
export function resolveD1Target(root) {
  for (const worker of ['account', 'sync']) {
    const config = join(root, 'workers', worker, 'wrangler.toml');
    const d1 = parseWranglerD1(readFileSync(config, 'utf8'));
    if (d1) return { ...d1, config };
  }
  throw new Error('未在 workers/account 或 workers/sync 的 wrangler.toml 中找到 d1_databases');
}

/**
 * 告警判定（纯函数）：/health 快照 + 积压阈值。
 * dead>0 永远 critical；pending 超阈值 warning；health 与直连库统计不一致 warning。
 */
export function evaluateHealth(health, options = {}) {
  const pendingWarn = options.pendingWarn ?? DEFAULT_PENDING_WARN;
  const findings = [];
  const outbox = health?.outbox;
  if (!outbox || typeof outbox !== 'object') {
    return [finding('critical', 'HEALTH_SHAPE', '/health 返回缺少 outbox 统计')];
  }
  const { pending = 0, processing = 0, dead = 0 } = outbox;
  if (dead > 0) {
    findings.push(finding('critical', 'OUTBOX_DEAD', `outbox 存在 ${dead} 条死信，本地变更未到达 D1，需人工介入`));
  }
  if (pending > pendingWarn) {
    findings.push(finding('warning', 'OUTBOX_BACKLOG', `outbox pending=${pending} 超过阈值 ${pendingWarn}，同步可能滞后`));
  }
  if (options.dbStats) {
    for (const status of ['pending', 'processing', 'dead']) {
      if (Number(options.dbStats[status] || 0) !== Number(outbox[status] || 0)) {
        findings.push(finding('warning', 'HEALTH_DIVERGENCE',
          `/health 与直连 SQLite 的 outbox 统计不一致（${status}: health=${outbox[status] ?? 0}, db=${options.dbStats[status] ?? 0}）`));
      }
    }
  }
  return findings;
}

/** 直连本地 SQLite 的 outbox 细节：死信清单、超租约 processing、最老 pending 年龄。 */
export function outboxFindings(db, { now = Date.now(), claimLeaseMs = CLAIM_LEASE_MS } = {}) {
  const findings = [];
  const dead = db.prepare(
    `SELECT event_id, event_type, retry_count, last_error FROM sync_outbox
     WHERE status = 'dead' ORDER BY created_at LIMIT 20`
  ).all();
  for (const row of dead) {
    findings.push(finding('critical', 'OUTBOX_DEAD_ROW',
      `死信 ${row.event_id}（${row.event_type}, retry=${row.retry_count}）: ${String(row.last_error || '').slice(0, 200)}`));
  }
  const stale = db.prepare(
    `SELECT event_id, event_type, claimed_at FROM sync_outbox
     WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at <= ?`
  ).all(new Date(now - claimLeaseMs).toISOString());
  for (const row of stale) {
    findings.push(finding('warning', 'OUTBOX_STALE_PROCESSING',
      `事件 ${row.event_id}（${row.event_type}）processing 超过 ${Math.round(claimLeaseMs / 60000)} 分钟租约（claimed_at=${row.claimed_at}）`));
  }
  const oldest = db.prepare(
    `SELECT event_id, created_at FROM sync_outbox WHERE status = 'pending' ORDER BY created_at LIMIT 1`
  ).get();
  if (oldest) {
    const ageMs = now - Date.parse(oldest.created_at);
    if (Number.isFinite(ageMs) && ageMs > CLAIM_LEASE_MS) {
      findings.push(finding('warning', 'OUTBOX_OLDEST_PENDING',
        `最老 pending 事件 ${oldest.event_id} 已等待 ${Math.round(ageMs / 60000)} 分钟`));
    }
  }
  return findings;
}

/** users 对账：本地是写入口，D1 必须存在同 id/username 且凭据逐字符一致。 */
export function reconcileUsers(localDb, remoteDb) {
  const findings = [];
  const remote = remoteDb.prepare('SELECT id, username, password_hash, password_salt FROM users');
  const remoteById = new Map(remote.all().map((row) => [row.id, row]));
  let checked = 0;
  for (const local of localDb.prepare('SELECT id, username, password_hash, password_salt FROM users').all()) {
    checked += 1;
    const other = remoteById.get(local.id);
    if (!other) {
      findings.push(finding('critical', 'USER_MISSING_REMOTE', `用户 ${local.username}（${local.id}）在 D1 不存在，注册事件未投递`));
      continue;
    }
    if (other.username !== local.username) {
      findings.push(finding('critical', 'USER_NAME_MISMATCH', `用户 ${local.id} 用户名分叉：local=${local.username}, d1=${other.username}`));
    }
    if (other.password_hash !== local.password_hash || String(other.password_salt || '') !== String(local.password_salt || '')) {
      findings.push(finding('critical', 'USER_CREDENTIAL_MISMATCH', `用户 ${local.username}（${local.id}）凭据不一致，双活验密口径存在分叉`));
    }
  }
  const localIds = new Set(localDb.prepare('SELECT id FROM users').all().map((row) => row.id));
  const remoteOnly = [...remoteById.keys()].filter((id) => !localIds.has(id));
  for (const id of remoteOnly) {
    findings.push(finding('info', 'USER_REMOTE_ONLY', `D1 用户 ${id} 本地不存在（bootstrap 前历史数据或本地库丢失）`));
  }
  findings.push(finding('info', 'USERS_CHECKED', `users 对账完成：本地 ${checked} 条，D1 独有 ${remoteOnly.length} 条`));
  return findings;
}

/** sessions 对账：只强制未过期会话；过期行缺失属正常清理，仅 info。 */
export function reconcileSessions(localDb, remoteDb, { now = Date.now() } = {}) {
  const findings = [];
  const remoteByToken = new Map(
    remoteDb.prepare('SELECT token_hash, user_id, expires_at FROM sessions').all().map((row) => [row.token_hash, row])
  );
  let active = 0;
  let expired = 0;
  for (const local of localDb.prepare('SELECT token_hash, user_id, expires_at FROM sessions').all()) {
    if (Date.parse(local.expires_at) <= now) { expired += 1; continue; }
    active += 1;
    const other = remoteByToken.get(local.token_hash);
    if (!other) {
      findings.push(finding('critical', 'SESSION_MISSING_REMOTE',
        `用户 ${local.user_id} 的未过期会话（${local.token_hash.slice(0, 12)}…）在 D1 缺失，登录事件未投递`));
      continue;
    }
    if (other.user_id !== local.user_id || other.expires_at !== local.expires_at) {
      findings.push(finding('critical', 'SESSION_MISMATCH',
        `会话 ${local.token_hash.slice(0, 12)}… 分叉：local(user=${local.user_id},exp=${local.expires_at}) d1(user=${other.user_id},exp=${other.expires_at})`));
    }
  }
  findings.push(finding('info', 'SESSIONS_CHECKED', `sessions 对账完成：未过期 ${active} 条已核对，本地过期 ${expired} 条不强制`));
  return findings;
}

/** 按 export-local.mjs 范式导出远端 D1 到暂存 SQLite，返回 { db, cleanup }。 */
export function exportRemoteD1(root, stagingDir) {
  const target = resolveD1Target(root);
  const sqlFile = join(stagingDir, `d1-${target.database_id}.sql`);
  const result = spawnSync(
    'npx',
    ['wrangler', 'd1', 'export', target.database_name, '--remote', `--config=${target.config}`, `--output=${sqlFile}`],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler d1 export 失败（exit=${result.status}）：${target.database_name}`);
  const db = new DatabaseSync(join(stagingDir, 'staging-remote.db'));
  db.exec(readFileSync(sqlFile, 'utf8'));
  return { db, target, cleanup: () => db.close() };
}

async function fetchHealth(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const args = {
    dbPath: process.env.AUTH_DB_PATH || DEFAULT_DB_PATH,
    healthUrl: process.env.AUTH_HEALTH_URL || DEFAULT_HEALTH_URL,
    pendingWarn: Number(process.env.AUTH_RECONCILE_PENDING_WARN || DEFAULT_PENDING_WARN),
    stagingDir: null,
    skipRemote: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') args.dbPath = argv[++i];
    else if (arg === '--health') args.healthUrl = argv[++i];
    else if (arg === '--pending-warn') args.pendingWarn = Number(argv[++i]);
    else if (arg === '--staging') args.stagingDir = argv[++i];
    else if (arg === '--skip-remote') args.skipRemote = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法: node scripts/auth-reconcile.mjs [--db PATH] [--health URL|none] [--pending-warn N] [--staging DIR] [--skip-remote] [--json]\n');
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(args.pendingWarn)) throw new Error('--pending-warn 必须是数字');
  if (args.healthUrl === 'none') args.healthUrl = null;
  return args;
}

function renderText(findings) {
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const label = { critical: 'CRITICAL', warning: 'WARN', info: 'INFO' };
  const lines = sorted.map((f) => `[${label[f.severity]}] ${f.code} ${f.message}`);
  const counts = findings.reduce((acc, f) => { acc[f.severity] += 1; return acc; }, { critical: 0, warning: 0, info: 0 });
  lines.push(`--- 汇总：critical=${counts.critical} warning=${counts.warning} info=${counts.info}`);
  return { text: lines.join('\n') + '\n', counts };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const findings = [];
  let localDb = null;
  let remote = null;
  let stagingDir = args.stagingDir;
  let ownsStaging = false;

  try {
    // 本地库先打开：DB 自身问题要以致命错误退出，不能被 /health 的 catch 吞成巡检失败。
    localDb = new DatabaseSync(args.dbPath, { readOnly: true });

    if (args.healthUrl) {
      try {
        const health = await fetchHealth(args.healthUrl);
        const dbStats = localDb.prepare('SELECT status, COUNT(*) AS n FROM sync_outbox GROUP BY status').all()
          .reduce((acc, row) => { acc[row.status] = row.n; return acc; }, {});
        findings.push(...evaluateHealth(health, { pendingWarn: args.pendingWarn, dbStats }));
      } catch (err) {
        findings.push(finding('critical', 'HEALTH_UNREACHABLE', `auth /health 巡检失败：${err?.name === 'AbortError' ? 'timeout' : (err?.message || err)}`));
      }
    }

    findings.push(...outboxFindings(localDb, { now: Date.now() }));

    if (!args.skipRemote) {
      if (!stagingDir) { stagingDir = mkdtempSync(join(tmpdir(), 'auth-reconcile-')); ownsStaging = true; }
      try {
        remote = exportRemoteD1(root, stagingDir);
        findings.push(...reconcileUsers(localDb, remote.db));
        findings.push(...reconcileSessions(localDb, remote.db, { now: Date.now() }));
      } catch (err) {
        findings.push(finding('critical', 'REMOTE_EXPORT_FAILED', `远端 D1 对账未能执行：${err?.message || err}`));
      }
    }
  } finally {
    remote?.cleanup();
    localDb?.close();
    if (ownsStaging && stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }

  const { text, counts } = renderText(findings);
  if (args.json) {
    process.stdout.write(JSON.stringify({ counts, findings }, null, 2) + '\n');
  } else {
    process.stdout.write(text);
  }
  process.exit(counts.critical > 0 ? 1 : 0);
}

// 仅在被直接执行时运行 CLI；被 node:test import 时只暴露纯函数。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`auth-reconcile 致命错误：${err?.stack || err}\n`);
    process.exit(2);
  });
}
