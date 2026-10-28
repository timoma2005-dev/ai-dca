/* global process, console, Buffer, setInterval, setTimeout, clearInterval */
// 纳指雷达快照本机缓存（SQLite）。
//
// 背景：CN 机到 Cloudflare 的跨境 TLS 经常 10～40 秒甚至被重置，前端读雷达有 15 秒超时，
// 直接反代 CF 会频繁出现「雷达快照读取失败」。这里把 CF Worker 的雷达快照定时同步到本机 SQLite，
// nginx（仍做 RBAC auth_request）把 GET 指到本服务，读本地库即时返回；手动计算 POST 也经本服务转发，
// 成功后立即写入本地库。
//
// - 上游：https://api.freebacktrack.tech/api/notify/nasdaq-radar[/features|/compute]，带 X-Radar-Key
//   （/etc/ai-dca/radar-proxy-key），按 DNS + 固定 CF IPv4 轮试，SNI/Host 始终为真实域名。
// - 表：radar_snapshot（latest / features 各一行）、radar_history（按快照日期留档）、radar_sync_log（最近 500 次同步）。
// - 每 5 分钟同步一次；GET 时距上次尝试超过 2 分钟会在后台补一次，不阻塞响应。
// - 本地库为空时 GET 会等一次同步（最多约 45 秒）；仍失败返回 503 JSON。
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RADAR_PATH = '/api/notify/nasdaq-radar';
export const FEATURES_PATH = `${RADAR_PATH}/features`;
export const COMPUTE_PATH = `${RADAR_PATH}/compute`;
const UPSTREAM_HOST = 'api.freebacktrack.tech';

export function openDb(DatabaseSync, path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS radar_snapshot (
      name TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      snapshot_date TEXT,
      computed_at TEXT,
      fetched_at INTEGER NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS radar_history (
      snapshot_date TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      computed_at TEXT,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS radar_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      name TEXT NOT NULL,
      ok INTEGER NOT NULL,
      target TEXT,
      ms INTEGER,
      message TEXT
    );
  `);
  return db;
}

/** 校验上游响应：ok:true 且 data 可消费（latest 需要 etfs ≥ 2 只；features 需要数组）。 */
export function validBody(name, json) {
  if (!json || json.ok !== true) return false;
  if (name === 'features') return Array.isArray(json.data);
  return Boolean(json.data && Array.isArray(json.data.etfs) && json.data.etfs.length >= 2);
}

export function createRadarCache({ db, fetchUpstream, now = () => Date.now(), staleMs = 120000, log = console }) {
  const getRow = db.prepare('SELECT body, snapshot_date, computed_at, fetched_at, source FROM radar_snapshot WHERE name = ?');
  const putRow = db.prepare(`INSERT INTO radar_snapshot (name, body, snapshot_date, computed_at, fetched_at, source) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET body = excluded.body, snapshot_date = excluded.snapshot_date, computed_at = excluded.computed_at, fetched_at = excluded.fetched_at, source = excluded.source`);
  const putHistory = db.prepare(`INSERT INTO radar_history (snapshot_date, body, computed_at, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(snapshot_date) DO UPDATE SET body = excluded.body, computed_at = excluded.computed_at, fetched_at = excluded.fetched_at`);
  const putLog = db.prepare('INSERT INTO radar_sync_log (at, name, ok, target, ms, message) VALUES (?, ?, ?, ?, ?, ?)');
  const trimLog = db.prepare('DELETE FROM radar_sync_log WHERE id <= (SELECT MAX(id) - 500 FROM radar_sync_log)');
  const lastAttempt = { latest: 0, features: 0 };
  const pending = {};

  function store(name, json, source) {
    const body = JSON.stringify(json);
    const date = name === 'latest' ? String(json.data.date || '') || null : null;
    const computedAt = name === 'latest' ? String(json.data.computedAt || '') || null : null;
    const at = now();
    putRow.run(name, body, date, computedAt, at, source);
    if (name === 'latest' && date) putHistory.run(date, body, computedAt, at);
  }

  function sync(name) {
    if (pending[name]) return pending[name];
    lastAttempt[name] = now();
    const path = name === 'features' ? FEATURES_PATH : RADAR_PATH;
    const t0 = now();
    pending[name] = (async () => {
      try {
        const { json, target } = await fetchUpstream('GET', path);
        if (!validBody(name, json)) throw new Error(`upstream invalid: ${String(json?.error || json?.code || 'no data').slice(0, 120)}`);
        store(name, json, 'sync');
        putLog.run(now(), name, 1, target || null, now() - t0, null);
        return true;
      } catch (error) {
        putLog.run(now(), name, 0, error?.target || null, now() - t0, String(error?.message || error).slice(0, 300));
        log.warn?.(`[radar-cache] sync ${name} failed: ${error?.message || error}`);
        return false;
      } finally {
        trimLog.run();
        pending[name] = null;
      }
    })();
    return pending[name];
  }

  function rowResponse(row, hit) {
    return {
      status: 200,
      headers: {
        'x-radar-cache': hit,
        'x-radar-cache-age': String(Math.max(0, Math.round((now() - row.fetched_at) / 1000))),
      },
      body: row.body,
    };
  }

  async function read(name) {
    let row = getRow.get(name);
    if (row) {
      if (now() - lastAttempt[name] >= staleMs) sync(name).catch(() => {});
      return rowResponse(row, 'hit');
    }
    await sync(name);
    row = getRow.get(name);
    if (row) return rowResponse(row, 'miss');
    return { status: 503, headers: {}, body: JSON.stringify({ ok: false, error: 'radar cache empty: upstream unreachable' }) };
  }

  async function compute(body) {
    try {
      const { json, status } = await fetchUpstream('POST', COMPUTE_PATH, body, 150000);
      if (validBody('latest', json)) store('latest', json, 'compute');
      return { status: status || 200, headers: {}, body: JSON.stringify(json) };
    } catch (error) {
      return { status: 502, headers: {}, body: JSON.stringify({ ok: false, error: `radar upstream: ${error?.message || error}` }) };
    }
  }

  function health() {
    const latest = getRow.get('latest');
    const lastLog = db.prepare('SELECT at, name, ok, target, ms, message FROM radar_sync_log ORDER BY id DESC LIMIT 5').all();
    return {
      ok: Boolean(latest),
      latest: latest ? { date: latest.snapshot_date, computedAt: latest.computed_at, fetchedAt: new Date(latest.fetched_at).toISOString(), source: latest.source } : null,
      recent: lastLog,
    };
  }

  return { sync, read, compute, health, store };
}

/** 上游请求：先走 DNS（family 4），再轮试固定 CF IPv4；SNI/Host 始终为真实域名。上次成功的目标排在最前。 */
export function createUpstream({ keyFile, ips, timeoutMs = 45000 }) {
  let preferred = null;
  function once(target, method, path, body, timeout) {
    const key = (() => { try { return readFileSync(keyFile, 'utf8').trim(); } catch { return ''; } })();
    return new Promise((resolve, reject) => {
      const headers = { host: UPSTREAM_HOST, accept: 'application/json' };
      if (key) headers['x-radar-key'] = key;
      const payload = body && body.length ? body : null;
      if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
      const req = httpsRequest({ host: target === 'dns' ? UPSTREAM_HOST : target, servername: UPSTREAM_HOST, family: 4, port: 443, method, path, headers, timeout }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          if (res.statusCode >= 500 || json == null) { const e = new Error(`upstream ${res.statusCode}${json == null ? ' non-json' : ''}`); e.target = target; reject(e); return; }
          resolve({ json, status: res.statusCode, target });
        });
      });
      req.on('timeout', () => req.destroy(new Error('upstream timeout')));
      req.on('error', (e) => { e.target = target; reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  }
  return async function fetchUpstream(method, path, body = null, timeout = timeoutMs) {
    const order = ['dns', ...ips];
    if (preferred) order.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
    // 计算接口不自动重试（避免重复触发计算），只试第一个目标
    const targets = method === 'POST' ? order.slice(0, 1) : order;
    let lastError = null;
    for (const target of targets) {
      try {
        const out = await once(target, method, path, body, timeout);
        preferred = target;
        return out;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('no upstream target');
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createHandler(cache) {
  return async function handler(req, res) {
    const send = (out) => {
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...out.headers });
      res.end(out.body);
    };
    try {
      const path = String(req.url || '').split('?')[0];
      if (req.method === 'GET' && path === RADAR_PATH) return send(await cache.read('latest'));
      if (req.method === 'GET' && path === FEATURES_PATH) return send(await cache.read('features'));
      if (req.method === 'POST' && path === COMPUTE_PATH) return send(await cache.compute(await readBody(req)));
      if (req.method === 'GET' && path === '/healthz') return send({ status: 200, headers: {}, body: JSON.stringify(cache.health()) });
      return send({ status: 404, headers: {}, body: JSON.stringify({ ok: false, error: 'not found' }) });
    } catch (error) {
      return send({ status: 500, headers: {}, body: JSON.stringify({ ok: false, error: String(error?.message || error) }) });
    }
  };
}

async function main() {
  const { DatabaseSync } = await import('node:sqlite');
  const env = process.env;
  const db = openDb(DatabaseSync, env.RADAR_CACHE_DB || '/var/lib/ai-dca-radar-cache/radar.sqlite');
  const fetchUpstream = createUpstream({
    keyFile: env.RADAR_CACHE_KEY_FILE || '/etc/ai-dca/radar-proxy-key',
    ips: String(env.RADAR_CACHE_CF_IPS || '104.21.38.17,172.67.217.77').split(',').map((s) => s.trim()).filter(Boolean),
  });
  const cache = createRadarCache({ db, fetchUpstream });
  const port = Number(env.RADAR_CACHE_PORT) || 8084;
  const syncMs = Number(env.RADAR_CACHE_SYNC_MS) || 5 * 60 * 1000;
  const server = createServer(createHandler(cache));
  server.listen(port, '127.0.0.1', () => console.log(`[radar-cache] listening 127.0.0.1:${port}`));
  const tick = () => { cache.sync('latest'); cache.sync('features'); };
  tick();
  const timer = setInterval(tick, syncMs);
  const stop = () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
