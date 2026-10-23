import { openDb, closeDb } from './db.js';
import { registerUser, loginUser, sha256Hex, SESSION_TTL_SECONDS } from './auth.js';
import { outboxStats } from './outbox.js';
import {
  authenticateRequest,
  buildAuthPayload,
  clearSessionCookie,
  requirePerm,
  sessionCookie,
} from './rbac.js';
import {
  RbacError,
  createMenu,
  createPermission,
  createRole,
  deleteMenu,
  deleteRole,
  grantUserRole,
  listAudit,
  listGuests,
  listMenus,
  listPermissions,
  listRoles,
  revokeUserRole,
  searchUsers,
  setRolePermissions,
  updateMenu,
  updateRole,
} from './rbacAdmin.js';

const MAX_BODY_BYTES = 64 * 1024;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function normalizeResult(result) {
  if (result?.error) {
    const { error, status, ...rest } = result;
    return { status: status || 400, body: { message: error, ...rest } };
  }
  const { status, ...body } = result;
  return { status: status || 200, body };
}

function sessionCookieHeader(body) {
  if (!body?.accessToken) return {};
  const ttl = body.expiresAt ? Math.floor((Date.parse(body.expiresAt) - Date.now()) / 1000) : SESSION_TTL_SECONDS;
  return { 'Set-Cookie': sessionCookie(body.accessToken, ttl) };
}

const ADMIN_PREFIX = '/api/sync/auth/admin';

// 管理路由表：[method, RegExp, handler(db, access, match, body, url)]
const ADMIN_ROUTES = [
  ['GET', /^\/users$/, (db, _a, _m, _b, url) => ({ users: searchUsers(db, { q: url.searchParams.get('q') || '', limit: url.searchParams.get('limit') }) })],
  ['GET', /^\/guests$/, (_db, _a, _m, _b, url) => listGuests({ limit: url.searchParams.get('limit') })],
  ['POST', /^\/users\/([^/]+)\/roles$/, (db, a, m, b) => grantUserRole(db, a, { userId: m[1], role: b.role, expiresAt: b.expiresAt })],
  ['DELETE', /^\/users\/([^/]+)\/roles\/([^/]+)$/, (db, a, m) => revokeUserRole(db, a, { userId: m[1], role: m[2] })],
  ['GET', /^\/roles$/, (db) => ({ roles: listRoles(db) })],
  ['POST', /^\/roles$/, (db, a, _m, b) => createRole(db, a, b)],
  ['PATCH', /^\/roles\/([^/]+)$/, (db, a, m, b) => updateRole(db, a, m[1], b)],
  ['DELETE', /^\/roles\/([^/]+)$/, (db, a, m) => deleteRole(db, a, m[1])],
  ['PUT', /^\/roles\/([^/]+)\/permissions$/, (db, a, m, b) => setRolePermissions(db, a, m[1], b.perms)],
  ['GET', /^\/permissions$/, (db) => ({ permissions: listPermissions(db) })],
  ['POST', /^\/permissions$/, (db, a, _m, b) => createPermission(db, a, b)],
  ['GET', /^\/menus$/, (db) => ({ menus: listMenus(db) })],
  ['POST', /^\/menus$/, (db, a, _m, b) => createMenu(db, a, b)],
  ['PATCH', /^\/menus\/([^/]+)$/, (db, a, m, b) => updateMenu(db, a, m[1], b)],
  ['DELETE', /^\/menus\/([^/]+)$/, (db, a, m) => deleteMenu(db, a, m[1])],
  ['GET', /^\/audit$/, (db, _a, _m, _b, url) => ({
    entries: listAudit(db, {
      limit: url.searchParams.get('limit'),
      before: url.searchParams.get('before'),
      action: url.searchParams.get('action') || '',
      target: url.searchParams.get('target') || '',
    }),
  })],
];

async function handleAdmin(db, req, res, url) {
  const sub = url.pathname.slice(ADMIN_PREFIX.length) || '/';
  const route = ADMIN_ROUTES.find(([method, pattern]) => method === req.method && pattern.test(sub));
  if (!route) {
    sendJson(res, 404, { message: 'Not found' });
    return;
  }
  // 权限每次由服务端按 token 重新计算。
  const auth = requirePerm(db, req.headers, 'api:rbac-admin');
  if (!auth.ok) {
    sendJson(res, auth.status, { message: auth.status === 403 ? '需要管理员权限' : auth.message });
    return;
  }
  const match = sub.match(route[1]).map((part, index) => (index === 0 ? part : decodeURIComponent(part)));
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJsonBody(req) : {};
  const result = route[2](db, auth.access, match, body || {}, url);
  sendJson(res, 200, { ok: true, ...result });
}

export function createApp(db) {
  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, outbox: outboxStats(db) });
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/api/sync/auth/register' || url.pathname === '/api/sync/auth/login')) {
        const body = await readJsonBody(req);
        const fn = url.pathname.endsWith('/register') ? registerUser : loginUser;
        const result = fn(db, { username: body.username, clientPasswordHash: body.passwordHash });
        const { status, body: responseBody } = normalizeResult(result);
        sendJson(res, status, responseBody, status === 200 ? sessionCookieHeader(responseBody) : {});
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sync/auth/logout') {
        const { token } = authenticateRequest(db, req.headers);
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/sync/auth/me') {
        const { token, user } = authenticateRequest(db, req.headers);
        if (!user) {
          sendJson(res, 401, { message: token ? '登录状态已失效，请重新登录' : '请先登录' });
          return;
        }
        // 迁移期：旧登录只有 localStorage token，没有会话 cookie。用 Bearer 调 /me 时补发 cookie，
        // 让同源 iframe（竞价看板）与 nginx auth_request 能识别同一会话。
        const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256Hex(token));
        const cookieHeader = row?.expires_at ? sessionCookieHeader({ accessToken: token, expiresAt: row.expires_at }) : {};
        sendJson(res, 200, { userId: user.id, username: user.username, ...buildAuthPayload(db, user) }, cookieHeader);
        return;
      }

      // 游客或当前登录者的菜单（未登录/无效 token 都返回 guest 菜单）。
      if (req.method === 'GET' && url.pathname === '/api/sync/auth/menus') {
        const { user } = authenticateRequest(db, req.headers);
        const payload = buildAuthPayload(db, user);
        sendJson(res, 200, { loggedIn: Boolean(user), username: user?.username || '', ...payload });
        return;
      }

      // nginx auth_request：200 放行 / 401 未登录 / 403 权限不足。只返回状态与少量头，不回显权限明细。
      if (req.method === 'GET' && url.pathname === '/api/sync/auth/check') {
        const perm = url.searchParams.get('perm') || '';
        const result = requirePerm(db, req.headers, perm);
        const headers = result.user ? { 'X-Auth-User-Id': result.user.id, 'X-Auth-Username': result.user.username } : {};
        sendJson(res, result.ok ? 200 : result.status, result.ok ? { ok: true } : { message: result.message }, headers);
        return;
      }

      if (url.pathname === ADMIN_PREFIX || url.pathname.startsWith(`${ADMIN_PREFIX}/`)) {
        await handleAdmin(db, req, res, url);
        return;
      }

      sendJson(res, 404, { message: 'Not found' });
    } catch (err) {
      if (err instanceof RbacError || err?.status) {
        sendJson(res, err.status || 400, { message: err.message });
        return;
      }
      console.error('[auth-service] request failed:', err);
      sendJson(res, 500, { message: '服务器内部错误' });
    }
  };
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.AUTH_PORT || 8080);

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const db = openDb();
  const { createServer } = await import('node:http');
  const server = createServer(createApp(db));
  server.listen(PORT, HOST, () => {
    console.log(`[auth-service] listening on http://${HOST}:${PORT}`);
  });
  const shutdown = () => {
    console.log('[auth-service] shutting down');
    server.close(() => closeDb(db));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
