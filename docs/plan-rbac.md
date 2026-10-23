# RBAC 角色 / 菜单权限方案（分支 cn-rbac）

> 状态：已在 `cn-rbac` 分支实现，**未合并、未发布**。上线步骤见第 8 节。

## 1. 目标

- 用服务端角色 / 菜单 / 权限替换前后端写死的管理员名单（`services/auth/src/auth.js` 的 `ADMIN_USERNAMES`、前端 `analytics.js` 的 `lovexl` / 竞价看板白名单、`screens.js` 的 `adminOnly`）。
- 菜单（侧边栏、移动底部导航、全局搜索）由服务端下发；前端只保留 `key → 组件` 映射。
- 所有权限每次请求由服务端根据 token 重新计算，**客户端提交的 roles / perms / locked / isAdmin 一律不信任**。
- 后端拦截：auth 服务 `requirePerm`、cn-data（8081）按接口校验、nginx `auth_request` 保护代理到 CF 的雷达接口、量化模拟盘接口与静态竞价看板。

## 2. 数据模型（`services/auth/migrations/002-rbac.sql`）

| 表 | 字段 | 说明 |
|---|---|---|
| `roles` | code, name, parent_code, level, is_system, is_virtual, description | `parent_code` 表示继承：子角色拥有父角色全部权限 |
| `user_roles` | user_id, role_code, expires_at（可空）, granted_by, created_at | 只存额外授予的角色；所有登录用户**隐式**拥有 `user`；过期行计算时自动忽略（保留做审计） |
| `menus` | key, label, tab, icon, group_name, sort, parent_key, subtitle, enabled | group：`primary` 主导航 / `admin` 管理分组 |
| `permissions` | code, kind, menu_key, description | `menu:<key>:view`（可见）、`menu:<key>:access`（可访问）、`api:<name>` |
| `role_permissions` | role_code, perm_code | 只写本级新增，继承由 `parent_code` 计算 |
| `audit_log` | actor_id, actor_username, action, target_type, target_id, detail(JSON), created_at | 所有管理变更 + 迁移 + 种子授予 |

`sync_state.rbac_version`：任何管理变更 +1，参与 `permVersion` 计算。

### 2.1 角色继承

```
guest(虚拟，未登录) ← user(所有登录用户) ← vip ← svip ← admin ← superadmin
                       ↖ auction_viewer（自定义角色，只开放竞价看板）
```

多角色取并集；`topRole` = 有效直接角色中 level 最高者。

### 2.2 种子权限

| 角色 | 本级新增 |
|---|---|
| guest | home / markets / shares / articles：view + access；holdings / tradePlans / fundSwitch / notify / dataRepair：**仅 view（锁住）** |
| user | 上述 5 个 user 菜单 access；adminRadar / adminAuction / adminQuant：**仅 view（锁住）**；api:account / api:notify / api:fund-switch / api:sync |
| vip | adminRadar access；api:nasdaq-radar |
| svip | adminAuction、adminQuant access；api:paper-trade |
| admin | 新菜单 adminRbac（权限管理）view + access；api:rbac-admin；api:nasdaq-radar-compute |
| superadmin | api:rbac-grant-admin（唯一可任命 / 撤销管理员） |
| auction_viewer | adminAuction access（迁移原前端竞价看板单独白名单 `551668745qq.com`） |

种子账号：`lovexl` = superadmin；`wanghao0902`、`de88903` = admin；`551668745qq.com` = auction_viewer；其余用户默认 user。
迁移时已在本地库的账号直接写入 `user_roles`；之后才进入本地库的账号在注册 / 登录时由 `applyBootstrapGrants` 补发**一次**（`sync_state` 记 `rbac_bootstrap:<username>`，撤销后不会被重新授予）。

### 2.3 「可见但锁住」的约定（已按此实现）

- 有 `menu:<key>:view` 无 `menu:<key>:access` → 菜单出现，`locked: true`，并给出 `requiredRole`（拥有该 access 权限的**最低系统角色**）。
- 游客：能看到 user 菜单（带锁）；**看不到** VIP / SVIP / 管理员菜单。
- 普通用户：能看到 VIP / SVIP 菜单（带锁，提示「需要 VIP / SVIP」）；**看不到**「权限管理」。
- 是否对低角色展示锁住的高级菜单完全由 `role_permissions` 中的 `:view` 决定，管理员可在「权限管理 → 角色权限」里随时取消（取消后即对该角色隐藏）。

## 3. 接口（services/auth，127.0.0.1:8080，nginx `/api/sync/auth/` 前缀）

| 方法 / 路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/sync/auth/register`、`/login` | — | 原 session 字段 + `roles[{code,name,expiresAt}]`、`topRole`、`menus` 树（每项含 `locked`、`requiredRole`、`children`）、`perms`、`permVersion`、`isAdmin`（兼容：有 admin 或 superadmin）。额外 `Set-Cookie: aidca_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax` |
| `POST /api/sync/auth/logout` | token 可选 | 删除本地 session 行并清除 cookie（`Max-Age=0`） |
| `GET /api/sync/auth/me` | Bearer 或 cookie，必需 | 同上载荷；无效 → 401。用 Bearer 调用时补发会话 cookie（迁移期让旧登录也拿到 cookie） |
| `GET /api/sync/auth/menus` | 可选 | 游客或当前用户的菜单（无效 token 按游客） |
| `GET /api/sync/auth/check?perm=xxx` | Bearer 或 cookie | 200 放行 / 401 未登录或 token 无效 / 403 权限不足 / 400 权限编码非法；供 nginx `auth_request`。200 时带 `X-Auth-User-Id`、`X-Auth-Username` |
| `GET /api/sync/auth/admin/users?q=` | api:rbac-admin | 用户搜索（含全部角色、到期、是否已过期） |
| `POST /api/sync/auth/admin/users/:userId/roles` `{role, expiresAt}` | api:rbac-admin（特权角色需 api:rbac-grant-admin） | 授予 / 更新到期 |
| `DELETE /api/sync/auth/admin/users/:userId/roles/:role` | 同上 | 撤销 |
| `GET/POST /api/sync/auth/admin/roles`、`PATCH/DELETE /admin/roles/:code` | api:rbac-admin | 角色 CRUD（系统角色不可删，继承关系 / 等级不可改） |
| `PUT /api/sync/auth/admin/roles/:code/permissions` `{perms}` | api:rbac-admin | 勾选权限（整体替换本级权限） |
| `GET/POST /api/sync/auth/admin/permissions` | api:rbac-admin | 列表 / 新增 `api:*` 权限 |
| `GET/POST /api/sync/auth/admin/menus`、`PATCH/DELETE /admin/menus/:key` | api:rbac-admin | 菜单 CRUD（新建自动生成 view/access 权限；adminRbac 不可删 / 停用） |
| `GET /api/sync/auth/admin/audit?limit&before&action&target` | api:rbac-admin | 审计日志（id 倒序分页） |

防越权规则（`rbacAdmin.js`）：
- 「特权角色」= 继承链含 admin / superadmin，或有效权限含 `api:rbac-admin` / `api:rbac-grant-admin`。授予 / 撤销 / 修改特权角色、创建继承特权角色的自定义角色、给任意角色增删特权权限、设置 level ≥ 90 —— 都需要 superadmin。
- `superadmin` 角色不能通过接口授予或撤销（防自锁、防越权），只能通过迁移 / 运维修改。
- `guest` 不可授予；`user` 隐式拥有，不可授予。

可复用鉴权：`services/auth/src/rbac.js` 导出
- `requirePerm(db, headers, perm)` → `{ok, status(401|403|400), message, user, access}`；
- `withPerm(db, perm, handler)`：Node http 中间件包装；
- `computeAccess` / `buildAuthPayload` / `authenticateRequest` / `readRequestToken`（Bearer 优先，其次 cookie）。

## 4. 后端拦截

### 4.1 cn-data（8081，`services/cn-data/src/rbacGuard.js`）

cn-data 部署在 `/opt/ai-dca-cn-data`，不能跨目录 import auth 源码，因此共享 auth SQLite（只读）并保留一份同口径的权限计算（`test/rbac-guard.test.mjs` 校验与 auth 服务结果一致）。

| 路径 | 权限 |
|---|---|
| `/api/account/*` | api:account |
| `/api/notify/switch/*` | api:fund-switch |
| `/api/notify/*`（health 除外） | api:notify |
| `/sync`、`/api/sync/backup`、`/api/sync/*`（health/probe/analytics 除外） | api:sync |
| `/api/geo`、`/health` | 公开 |

语义：无 token / token 无效 → 交给原路由（它们返回 401）；auth 库没有 RBAC 表（未迁移）→ 放行并告警一次；token 有效但缺权限 → 403。

### 4.2 nginx（仅改仓库 `deploy/cn/nginx-ai-dca-cn-5000.conf`，未应用）

- 新增 internal location `/_rbac/<name>` → `http://127.0.0.1:8080/api/sync/auth/check?perm=...`，透传 `Authorization`、`Cookie`，不带 body。每个权限一个 location，不依赖父子请求共享变量。
- `= /api/notify/nasdaq-radar` → `auth_request /_rbac/nasdaq-radar`（api:nasdaq-radar）
- `= /api/notify/nasdaq-radar/compute` → api:nasdaq-radar-compute
- 新增 `/api/market-collector/api/paper-trade/`（量化模拟盘）→ api:paper-trade
- 新增 `= /auction-board.html` → menu:adminAuction:access（同源 iframe 靠会话 cookie）
- 已用 `nginx -t -c <临时 nginx.conf>`（引用 /etc/nginx/conf.d 的 upstream/map）验证语法；并在临时端口起了一套 nginx + 分支 auth 服务做过功能验证：游客 401、普通用户 403、SVIP 200、SVIP 调 compute 403。

### 4.3 已知缺口（后续）

- 雷达 GET 走 `fetchWithFallback`：CN 返回 5xx（例如 auth 服务挂了导致 auth_request 500）时会回退到 `https://api.freebacktrack.tech` 直连 CF，CF Worker 本身未鉴权。完全保护需要 CF Worker 侧也校验（或去掉该接口的 CF 回退）。
- `workers/sync` 的 CF 登录接口仍写死 `ADMIN_USERNAMES`（只影响 CN auth 不可用时走 CF 登录的 `isAdmin` 字段）。

## 5. D1 同步

本次**未**把 RBAC 表同步到 D1：`workers/sync/src/internalAuthSync.js` 只接受 `user.register` / `user.login`，未知事件返回 400 会进死信。
已预留：`rbacAdmin.js` 的每次变更在环境变量 `AUTH_RBAC_SYNC_ENABLED=1` 时入队 `rbac.change` 事件（默认关闭）。后续步骤：
1. D1 加同构表（roles / user_roles / menus / permissions / role_permissions）；
2. internalAuthSync 增加 `rbac.change`（或按表全量快照 `rbac.snapshot`）的幂等 applier；
3. 先发 Worker，再打开 `AUTH_RBAC_SYNC_ENABLED`；
4. CF 侧 `/api/sync/auth/*` 兜底登录改为读 D1 角色。

## 6. 前端

- `src/app/rbac/menuModel.js`：纯函数——游客 / 已登录兜底菜单、`evaluateTabAccess`（路由守卫：ok / login / forbidden）、侧边栏分组、头像角标。
- `src/app/rbac/rbacStore.js`：菜单缓存（localStorage `aiDcaRbacMenus_v1`，按会话 + `permVersion`，版本不变不重渲染）；登录 / 注册响应直接写入；之后 `/me`（已登录）或 `/menus`（游客）刷新，60 秒去重、并发共享；`/me` 401 时按游客展示；网络失败保留缓存 / 兜底。
- `useRbac()` hook；`WorkspacePage`：侧边栏 / 移动底部导航 / 全局搜索都改用服务端菜单（与本地 `isWorkspaceGroup` 求交——服务端新增但前端没有组件的菜单不显示），`?tab=` 守卫不再静默回退：游客 → 登录守卫页（自动弹一次登录），角色不足 → 403「需要 VIP / SVIP」页；点击锁住菜单：游客弹登录，已登录进入 403 页。旧 `?tab=adminRadar#shares` 份额链接保持公开。
- `isAnalyticsAdmin` 改读角色（session.roles/topRole/isAdmin 或菜单缓存），`canAccessAdminAuction` 改读 `menu:adminAuction:access`；雷达页改为 VIP 可读、管理员才显示「手动计算」按钮；量化页改为 `menu:adminQuant:access`，请求带 Bearer。
- 右上角头像角标（VIP 金色皇冠、SVIP 钻石、管理员盾牌），账户下拉列出全部角色与到期日；退出时调用 `/logout` 清 cookie。
- 新页面「权限管理」（`?tab=adminRbac`）：用户角色（搜索 → 授予 / 设到期 / 撤销）、角色权限（CRUD + 菜单可见 / 可访问勾选 + 接口权限，继承项灰显）、菜单 CRUD、审计日志。全部为页内表单，没有从底部弹出的浮窗，不涉及 `setMobileBottomSheetOpen`。

## 7. 测试

- `services/auth/test/rbac.test.mjs`：角色继承、多角色并集、过期、permVersion、种子账号只发一次、Bearer/cookie、check 401/403/200、篡改 locked/roles/isAdmin 字段无效、伪造 token、管理员不能任命管理员 / 不能通过自定义角色或特权权限越权、superadmin 限制、全部管理接口与审计。
- `services/cn-data/test/rbac-guard.test.mjs`：路由映射、与 auth 服务权限一致、403/放行/未迁移跳过。
- 前端：`test/rbacMenuModel.test.mjs`、`test/rbacStore.test.mjs`、`test/rbacUiRender.test.mjs`（rolldown 打包真实组件 + react-dom/server 渲染：侧边栏锁图标、移动底部导航、搜索、守卫页、角标）、`test/sharesWorkspaceRedirect.test.mjs`（路由守卫与面板渲染）、`test/mobileBottomNavConfig.test.mjs`。

## 8. 上线步骤（手动，按顺序）

> 前端必须**最后**发：前端依赖 `/me`、`/menus`；nginx 的 auth_request 依赖 `/check`。

1. **备份**：`sqlite3 /var/lib/ai-dca-auth/auth.sqlite ".backup /var/lib/ai-dca-auth/auth.sqlite.bak-$(date +%Y%m%d%H%M%S)"`（或停写后 `cp` 含 `-wal/-shm`）。
2. **auth 服务**：把 `services/auth/` 同步到 `/opt/ai-dca-auth/`（`src/`、`migrations/`），`supervisorctl -c /etc/market-collector-supervisord.conf restart ai-dca-auth`。启动时 `openDb` 自动执行 `002-rbac.sql`（单事务）。验证：
   - `curl --noproxy '*' -s http://127.0.0.1:8080/api/sync/auth/menus | jq .topRole` → guest；
   - `curl --noproxy '*' -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8080/api/sync/auth/check?perm=api:nasdaq-radar'` → 401；
   - `sqlite3 ... "select u.username, r.role_code from user_roles r join users u on u.id=r.user_id"` 应含 lovexl/superadmin 等。
   - `ai-dca-auth-sync`（outbox worker）无需重启（未新增事件类型；`AUTH_RBAC_SYNC_ENABLED` 保持未设置）。
3. **cn-data**：把 `services/cn-data/src/` 同步到 `/opt/ai-dca-cn-data/src/`，重启 `ai-dca-cn-data`。旧库或 auth 未迁移时自动跳过校验。
4. **nginx**：`cp deploy/cn/nginx-ai-dca-cn-5000.conf /etc/nginx/sites-enabled/ai-dca-cn-5000`（先备份原文件），`nginx -t && systemctl reload nginx`。验证：未登录访问 `/auction-board.html` → 401；`/api/notify/nasdaq-radar` 未登录 → 401。
5. **前端**：评审后把 `cn-rbac` 合入 `cn` 并 push（autorelease 自动发布），按规范第 3 节验收 `home.html?tab=adminRbac`、`?tab=adminRadar`、游客 `?tab=holdings`，手机 390px 也看一遍。
6. 已登录老用户没有会话 cookie：首次打开页面时前端调用 `/me`（Bearer）会补发 cookie；在此之前竞价看板 iframe / 雷达可能 401，刷新一次即可。

## 9. 回滚

- 前端：`bash scripts/cn-frontend/rollback.sh <上一个时间戳>`（或 revert 合并提交后 push）。
- nginx：恢复备份的站点配置，`nginx -t && systemctl reload nginx`。
- cn-data / auth：把 `/opt/...` 换回旧版本代码并重启。`002-rbac.sql` 只新增表和行，旧代码完全忽略，**无需回滚 schema**；如需彻底清除：停服务后从第 1 步备份恢复 sqlite。
- 注意顺序：先回滚前端与 nginx，再回滚 auth（否则 nginx auth_request 会因 `/check` 404 返回 500）。

## 10. 未完成 / 后续

- D1 同步（第 5 节）与 CF Worker 侧鉴权（第 4.3 节）。
- e2e（playwright）未跑；`test/e2e` 中如有依赖旧侧边栏写死顺序的用例需随合并调整。
- 自定义菜单只在前端存在对应组件时才会显示（`isWorkspaceGroup`），新增页面仍需前端发版。
