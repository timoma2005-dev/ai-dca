# auth-service（本地认证服务）

cn 主机上的本地注册/登录服务。用户数据先落本地 SQLite 并立即返回，
后台 `syncWorker` 再把变更异步同步到 Cloudflare Worker（D1），
避免注册/登录完全依赖 CF 链路。

## 运行

```bash
cd services/auth
npm install
npm test

# HTTP 服务（127.0.0.1:8080）
AUTH_DB_PATH=/var/lib/ai-dca-auth/auth.sqlite AUTH_PORT=8080 npm start

# 后台同步 worker（独立进程）
SYNC_WORKER_URL=https://api.freebacktrack.tech/api/sync/internal/sync-auth \
INTERNAL_SYNC_TOKEN=<token> \
AUTH_DB_PATH=/var/lib/ai-dca-auth/auth.sqlite npm run sync-worker
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_DB_PATH` | `/var/lib/ai-dca-auth/auth.sqlite` | SQLite 文件路径 |
| `AUTH_PORT` | `8080` | HTTP 监听端口（只绑 127.0.0.1） |
| `SYNC_WORKER_URL` | `https://api.freebacktrack.tech/api/sync/internal/sync-auth` | CF Worker 内部同步接口 |
| `INTERNAL_SYNC_TOKEN` | 空 | 同步接口的 Bearer token |

## 接口

- `POST /api/sync/auth/register` `{username, passwordHash}` → session JSON（409 用户名已存在）
- `POST /api/sync/auth/login` `{username, passwordHash}` → session JSON（401 用户名或密码不正确）
- `GET /health` → `{ok: true, outbox: {...}}`

### RBAC（角色 / 菜单 / 权限，详见 docs/plan-rbac.md）

登录 / 注册响应额外返回 `roles`、`topRole`、`menus`（含 `locked`、`requiredRole`）、`perms`、`permVersion`、`isAdmin`，
并 `Set-Cookie: aidca_session=<token>; HttpOnly; Secure; SameSite=Lax`。

- `POST /api/sync/auth/logout` → 删除 session 并清 cookie
- `GET /api/sync/auth/me` → 当前用户权限载荷（Bearer 或 cookie；无效 401）
- `GET /api/sync/auth/menus` → 游客 / 当前用户菜单
- `GET /api/sync/auth/check?perm=<code>` → 200 / 401 / 403，供 nginx `auth_request`
- `/api/sync/auth/admin/*`（需 `api:rbac-admin`；任命管理员需 `api:rbac-grant-admin`）：
  `users`、`users/:id/roles[/:role]`、`roles[/:code[/permissions]]`、`permissions`、`menus[/:key]`、`audit`

可复用鉴权：`import { requirePerm, withPerm } from './src/rbac.js'`。
权限每次请求按 token 在服务端重新计算，不信任客户端字段。
`AUTH_RBAC_SYNC_ENABLED=1` 时 RBAC 变更会入队 `rbac.change`（D1 消费端未实现，默认关闭）。

密码哈希口径与 `workers/sync` 完全一致（双端同构，D1 灾备副本可独立验密）：

- 浏览器先做一轮 `clientHash = sha256(小写用户名 + ':' + 密码)`，原始密码不离开设备；
- 服务端对 clientHash 做 **PBKDF2-HMAC-SHA256 慢哈希（310000 次、16 字节随机盐、32 字节派生）**，
  存为自描述 PHC：`$pbkdf2-sha256$310000$<saltB64url>$<hashB64url>`，盐内嵌、无需 schema 迁移；
- 存量用户是旧格式 `stored = sha256(salt + ':' + clientHash)`（不含 `$` 的 64 位 hex，盐在
  `password_salt` 列），登录验证通过后在同一事务内**惰性轮转**成 PHC，并发出
  `user.credential_rotated` 事件同步 D1；验证失败一律 401，不改动凭证；
- 实现见 `src/password.js`（Node）与 `workers/sync/src/password.js`（Web Crypto），两者参数逐一对齐；
- session 有效期 30 天，token 以 `acc_`/`ref_` 开头，DB 只存 token 的 SHA256。

> 发布注意：部署后避免回滚到不识别 PHC 的旧版本，否则已轮转用户会登录失败（旧版把 PHC 当 legacy hex 验不过），靠前滚修复。

## nginx 接线（下一阶段）

```nginx
location /api/sync/auth/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

其余 `/api/` 保持代理到 CF Worker 不变。

## 同步语义

- 注册/登录在同一事务内写 `users`/`sessions` 并入 `sync_outbox` 队列
- 同步成功删除事件；网络错误/5xx/429 按指数退避重试（5s 起，最大 30min，429 尊重 Retry-After）
- 4xx（非 429）进入死信（`status='dead'`），不再重试，需人工处理
- 认领租约：claim 时写入 `claimed_at`，超过 10 分钟仍处于 `processing` 的事件（含迁移前 `claimed_at` 为空的遗留行）会在下次 claim 时重置回 `pending` 重新投递，避免 syncWorker 崩溃后事件永久卡死（迁移 `003-outbox-lease.sql`）
