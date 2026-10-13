import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from './db.js';
import { outboxStats } from './outbox.js';
import { handleAccountV1Route } from './account/routes.js';
import { handleSyncRoute } from './sync/routes.js';
import { handleNotifyRoute } from './notify/routes.js';
import { badRequest, handleDataRoute } from './routes/data.js';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
};
function sendJson(res, status, body, headers) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(headers?.['Content-Type']?.startsWith('text/html') ? body : JSON.stringify(body));
}
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!oversized) reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { reject(badRequest('Invalid JSON')); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reject(badRequest('Body must be a JSON object')); return;
      }
      resolve(body);
    });
    req.on('error', reject);
    req.on('aborted', () => reject(badRequest('Request aborted')));
  });
}
export function createApp(db, { maxBodyBytes = MAX_BODY_BYTES } = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, outbox: outboxStats(db) }); return;
      }
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJsonBody(req, maxBodyBytes) : {};
      const result = handleNotifyRoute(db, req.method, url, body, req.headers)
        ?? handleAccountV1Route(db, req.method, url, body, req.headers)
        ?? handleSyncRoute(db, req.method, url, body, req.headers)
        ?? await handleDataRoute(db, req.method, url, body, req.headers);
      sendJson(res, result?.status ?? (result ? 200 : 404), result?.body ?? { message: 'Not found' }, result?.headers);
    } catch (error) {
      if (!error.status) console.error('[cn-data] request failed:', error);
      sendJson(res, error.status || 500, { message: error.status ? error.message : 'Internal server error' });
    }
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const port = Number(process.env.CN_DATA_PORT || 8081);
  const server = createServer(createApp(db));
  server.listen(port, '127.0.0.1', () => console.log(`[cn-data] listening on 127.0.0.1:${port}`));
  const shutdown = () => server.close(() => closeDb(db));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
