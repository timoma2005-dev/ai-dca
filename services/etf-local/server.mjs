// ai-dca ETF 份额本机采集（bohrium，国内 IP）：直接复用 workers/etf-shares 的代码，KV 换成本机 SQLite。
// - 定时：工作日北京时间 08:30 主跑、08:45 / 09:00 当天不完整才补抓（与 CF worker 同一套 cron 语义）。
// - HTTP 127.0.0.1:8083：与 worker 相同路由（/api/etf-pcf-shares、/api/etf-pcf-limit、/api/etf-pcf-events），
//   etf-mirror 优先读这里，CF worker 只做备份并用于完整性核对。
// - 手动补跑：curl -X POST 'http://127.0.0.1:8083/__run?cron=30%200%20*%20*%20MON-FRI'
import http from 'node:http';
import { SqliteKV } from './kv.mjs';
import worker from '../../workers/etf-shares/src/index.js';

const PORT = Number(process.env.ETF_LOCAL_PORT || 8083);
const DB = process.env.ETF_LOCAL_DB || '/var/lib/ai-dca-etf-local/kv.sqlite';
const env = { FUND_LIMIT_KV: new SqliteKV(DB) };
const SCHEDULE = [
  { hm: '08:30', cron: '30 0 * * MON-FRI' },
  { hm: '08:45', cron: '45 0 * * MON-FRI' },
  { hm: '09:00', cron: '0 1 * * MON-FRI' }
];

function makeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(Promise.resolve(p).catch((e) => console.log('[etf-local] waitUntil error', e?.message || e))), passThroughOnException() {} };
}

let running = null;
async function runCron(cron, scheduledTime = Date.now()) {
  if (running) { console.log(`[etf-local] skip ${cron}: previous run still going`); return running; }
  running = (async () => {
    const t0 = Date.now();
    console.log(`[etf-local] run start cron=${cron}`);
    const ctx = makeCtx();
    try {
      await worker.scheduled({ cron, scheduledTime }, env, ctx);
      await Promise.all(ctx.pending);
    } catch (e) {
      console.log('[etf-local] run crashed', e?.stack || e);
    }
    console.log(`[etf-local] run done cron=${cron} ${Date.now() - t0}ms`);
  })().finally(() => { running = null; });
  return running;
}

function shanghaiParts(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

const fired = new Set();
setInterval(() => {
  const { date, hm, weekday } = shanghaiParts();
  if (weekday === 'Sat' || weekday === 'Sun') return;
  for (const s of SCHEDULE) {
    const id = `${date} ${s.cron}`;
    if (s.hm === hm && !fired.has(id)) {
      fired.add(id);
      runCron(s.cron); // 交易日判断、完成标记跳过都在 worker.scheduled 内部
    }
  }
}, 15 * 1000);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__run' && req.method === 'POST') {
      const cron = url.searchParams.get('cron') || SCHEDULE[0].cron;
      runCron(cron);
      res.writeHead(202, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, cron, alreadyRunning: Boolean(running) }));
    }
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, running: Boolean(running) }));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;
    const request = new Request('https://api.freebacktrack.tech' + req.url, { method: req.method, headers: req.headers, body });
    const ctx = makeCtx();
    const response = await worker.fetch(request, env, ctx);
    const buf = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(response.headers.entries());
    delete headers['content-encoding'];
    headers['content-length'] = String(buf.length);
    res.writeHead(response.status, headers);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'local_worker_error', detail: String(e?.message || e).slice(0, 200) }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[etf-local] listening 127.0.0.1:${PORT} db=${DB}`));
