# cn 主机作为数据主本、CF 仅做异步冗余 —— 架构迁移计划

> 用户需求（2026-10-12）："调用cf worker太不稳定了，我需要cn分支的所有数据都保存在cn机器上，然后cf侧保留一份冗余，这个由cn机器异步调用cf worker"
>
> 状态：PLAN ONLY，未实施。实施前需用户逐阶段确认。
>
> 相关文档：`docs/plan-auth-local-sqlite.md`（auth 本地化先例）、`docs/plan-frontend-direct-api.md`（刚上线的直连方案，本计划会将其反转）

---

## 1. 现状盘点：数据在哪、谁在写、谁在读

### 1.1 cn 主机（rdfo1495558.bohrium.tech）

| 服务 | 端口 | 数据 | 存储 |
|---|---|---|---|
| nginx | 5000 | 静态前端、反代规则 | 配置文件 |
| services/auth (Node) | 8080 | users、sessions | SQLite `~/.ai-dca-auth/auth.db`（表：users、sessions、sync_outbox、sync_state） |
| services/market-collector (Python) | 18080 | 行情快照、回测计算 | 内存 + 本地文件？（待确认） |
| syncWorker (auth 内) | — | auth 变更事件 | SQLite sync_outbox → POST 到 worker |

nginx 反代现状（`/etc/nginx/sites-available/ai-dca-cn-5000`）：
- `location ^~ /api/sync/auth/` → 127.0.0.1:8080（本地 auth）
- `location /api/market-collector/` → 127.0.0.1:18080（本地行情，backtest 专用 location 120s 超时）
- `location /api/` → `https://api.freebacktrack.tech`（经 resolver 强制 IPv4，2026-10-12 修复）

### 1.2 Cloudflare Workers（api.freebacktrack.tech）

| Worker | 路由 | D1 | KV | R2 | Cron |
|---|---|---|---|---|---|
| sync | `/api/sync/*` | `ai-dca-sync-db`（users、sessions、sync_events、analytics_events、analytics_daily_stats、backups、backup_versions） | SYNC_BACKUPS | — | 每天 00:15 UTC |
| notify | `/api/notify/*`、`/api/wechat*` | SYNC_DB（notify_features、notify_links、notify_delivery_stats、notify_reliability_* 共 5 张表） | NOTIFY_STATE（`holdings-rule:<clientId>`、`switch:config:*`、`switch:snapshot:*`、`notify:queue:device:*`、`wechat:user:*`、`market-push-cache:*` 等） | — | 15:30/20:30/21:30（北京时间）+ 高频推送 |
| account | `/api/account/*` | DB（account_resources、account_resource_records、account_resource_history、account_holdings_transactions* 3 张表） | — | — | — |
| markets | `/api/markets/*` | — | MARKETS_KV、NAV_HISTORY_KV | MARKETS_R2（ai-dca-markets） | A股/美股盘中采集、K线批量保存 |
| ocr-proxy | （内部） | — | FUND_LIMIT_KV、NAV_HISTORY_KV | — | — |
| market-collector | `/api/mc/*` | — | ai-dca-market-collector-kv | — | 每分钟 |

### 1.3 数据主本现状（谁是 Source of Truth）

| 数据域 | 当前主本 | 写路径 | 读路径 |
|---|---|---|---|
| 用户/会话（auth） | **cn SQLite** ✅已本地化 | 注册/登录 → cn SQLite → syncWorker 异步 → worker D1 | cn 本地 8080；worker D1 做 token 校验（notify worker 查 sessions 表） |
| 通知规则/配置 | **CF D1+KV** ❌ | 浏览器 → `POST /api/notify/sync` → worker | worker cron 评估 |
| 持仓/交易（account） | **CF D1** ❌ | 浏览器 → `POST /api/account/*` → worker | 浏览器 ← worker |
| 同步备份（sync） | **CF D1+KV** ❌ | 浏览器 → `PUT /api/sync/latest` → worker | 浏览器 ← worker |
| 行情/回测 | **cn 18080** ✅已本地化 | cn 本地采集 | 浏览器 → cn nginx → 18080 |
| 市场数据（markets worker） | **CF KV+R2** ❌ | worker cron 独立采集 | 浏览器 → worker |
| 通知推送执行 | **CF**（必须在 CF，因为要调外部推送通道） | worker cron | — |

### 1.4 跨边界调用清单

| # | 方向 | 调用 | 频率 | 备注 |
|---|---|---|---|---|
| 1 | cn → CF | syncWorker POST `/api/sync/internal/sync-auth` | 事件驱动+退避 | 已从 api 域名改到 fast 域名（workaround） |
| 2 | 浏览器 → CF | `/api/notify/*`、`/api/account/*`、`/api/sync/*` | 用户操作时 | 2026-10-12 刚改成直连（`apiUrlDirect`） |
| 3 | 浏览器 → cn | `/api/market-collector/*`、`/api/markets/*`、`/api/fund-fee` 等 | 高频 | 经 nginx |
| 4 | CF → 外部 | notify worker 调腾讯/新浪/东财行情；调 Bark/Server酱/邮件/微信推送 | cron/事件 | 不经过 cn |
| 5 | CF → CF | notify 调 Durable Object ws-hub | 实时 | 内部 |

**关键观察**：notify worker 的推送执行（cron 评估 + 调外部通道）天然适合留在 CF（全球边缘、cron 可靠）。要搬的是**数据主本**，不是推送执行。

---

## 2. 目标架构

### 2.1 原则

1. **cn 主机是所有数据的 Source of Truth**：auth、notify 规则、account 持仓、sync 备份，全部以 cn 落盘为准。
2. **CF 只存冗余副本**：由 cn 异步推送（outbox 模式），CF 侧永不主动写主数据（除了下面第 4 条的例外）。
3. **推送执行仍在 CF**：notify worker 的 cron 评估和通道推送保留在 CF，但它读的是冗余副本。副本延迟容忍度：15:30/20:30/21:30 批次要求副本延迟 < 5 分钟。
4. **例外（CF 可写）**：推送执行产生的派生数据（delivery_stats、去重 watermark、quota 计数）允许 worker 本地写，不需要回同步到 cn（这些是运维数据，不是用户数据）。
5. **读路径**：浏览器默认读 cn；cn 不可用时降级读 CF 冗余副本（只读，不写）。

### 2.2 新架构图

```
浏览器
 ├─ 写（用户数据）: POST → cn nginx → cn 数据服务（SQLite/Postgres）→ 200 立即返回
 │                                                              ↓
 │                                                    sync_outbox（SQLite）
 │                                                              ↓
 │                                              syncDaemon（指数退避，重试）
 │                                                              ↓
 │                                              POST → CF worker /internal/sync-*（冗余写入）
 │
 ├─ 读（用户数据）: GET → cn nginx → cn 数据服务
 │     └─ cn 失败 → 降级 GET → api.freebacktrack.tech（CF 冗余副本，只读）
 │
 └─ 读（行情）: → cn 18080（不变）

CF Workers
 ├─ notify worker: cron 照常跑，读 CF 本地冗余副本（D1/KV），调外部推送通道
 ├─ 接收 /internal/sync-*：只写冗余副本，不做业务校验（幂等 upsert）
 └─ 读接口保留：供浏览器降级读取
```

### 2.3 cn 主机新增/改造的服务

| 服务 | 形态 | 职责 | 数据存储 |
|---|---|---|---|
| **cn-data**（新，Node） | 复用 services/auth 框架 | 统一用户数据 API：notify 规则、account 持仓、sync 备份的读写 | SQLite（新库 `cn-data.db`）或复用 auth.db 加表 |
| **syncDaemon**（新，或扩展 syncWorker） | 独立进程 | 扫 outbox，按数据类型路由到 CF 对应 worker 的 `/internal/sync-*`，指数退避 | 复用 sync_outbox 表（加 `target` 字段区分 worker） |
| auth（现有） | 不变 | 注册/登录/会话 | 不变 |
| market-collector（现有） | 不变 | 行情/回测 | 不变 |

**表设计**（cn-data.db 新增）：
```sql
-- 通知规则（替代 CF 的 notify_features + KV holdings-rule:*）
CREATE TABLE notify_rules (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  rule_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,          -- 'holding-alert' | 'market-alert' | 'preset'
  payload TEXT NOT NULL,            -- JSON
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id, rule_id)
);
-- 通知配置（替代 KV switch:config:* 等）
CREATE TABLE notify_configs (
  user_id TEXT NOT NULL,
  config_key TEXT NOT NULL,         -- 'switch-config' | 'channels' | 'holdings-rule' ...
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, config_key)
);
-- 持仓/交易（替代 account worker 的 D1 表，原样搬）
CREATE TABLE account_holdings_transactions (...);  -- 同 workers/account/src/transactions.js
CREATE TABLE account_resources (...);              -- 同 workers/account/src/store.js
-- 同步备份（替代 sync worker 的 backups 表）
CREATE TABLE sync_backups (
  user_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
-- 通用 outbox（替代 sync_outbox，或扩展它）
CREATE TABLE sync_outbox (
  event_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,             -- 'notify' | 'account' | 'sync'
  event_type TEXT NOT NULL,         -- 'upsert-rule' | 'delete-rule' | 'upsert-backup' ...
  payload TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 2.4 CF Worker 改造

每个 worker 新增 `/internal/sync-*` 接收端点（复用现有 `INTERNAL_SYNC_TOKEN` 鉴权）：

| Worker | 新增端点 | 行为 |
|---|---|---|
| notify | `POST /api/notify/internal/sync-rules` | 幂等 upsert 到 D1 notify_features + KV（保持现有表结构不变，worker 读路径零改动） |
| account | `POST /api/account/internal/sync` | 幂等 upsert 到 D1（表结构不变） |
| sync | `POST /api/sync/internal/sync-backup` | upsert backups 表 + KV |

**关键设计**：CF 侧表结构/KV key 完全不变，worker 的读路径和 cron 逻辑**一行不改**。变的只是"谁写"：从"浏览器直接写"变成"cn 同步写"。

浏览器写路径改完后，worker 的原写入端点（`/api/notify/sync`、`PUT /api/sync/latest`、`/api/account/*` POST）改为：
- 阶段一（双写过渡）：保留，但标记 deprecated
- 阶段二（切流后）：返回 410 或转代理到 cn（防止旧版前端写丢数据）

### 2.5 前端改造

反转 `docs/plan-frontend-direct-api.md`（2026-10-12 刚上线）：

| API | 现在 | 目标 |
|---|---|---|
| `/api/account/*` | 直连 CF | → cn（经 nginx `/api/account/` → cn-data） |
| `/api/sync/*`（除 auth 外） | 直连 CF | → cn |
| `/api/notify/*` | 直连 CF | → cn |
| `/api/sync/auth/*` | 经 cn（已本地化） | 不变 |

`src/app/apiBase.js`：
- 删除 `DIRECT_API_ORIGIN` / `apiUrlDirect` / `isDirectApiPath`（或保留做降级读）
- 新增 `apiUrlWithFallback(path)`：先试 cn，失败（网络错/5xx）则降级到 `https://api.freebacktrack.tech` 同路径（只读接口才降级，写接口不降级直接报错）

调用点：11 处 `apiUrlDirect` 改回 `apiUrl`（`44f38b3f` 的反向操作）。

### 2.6 nginx 改造

```nginx
# 新增：用户数据 API 反代到 cn-data（127.0.0.1:8081）
location /api/notify/ { proxy_pass http://127.0.0.1:8081/; ... }
location /api/account/ { proxy_pass http://127.0.0.1:8081/; ... }
location /api/sync/ {
    # 注意：/api/sync/auth/ 已有精确匹配到 8080，保持优先
    proxy_pass http://127.0.0.1:8081/;
}
# /internal/sync-* 端点只允许本机 syncDaemon 调，不对外暴露（或加 IP 白名单）
```

注意 location 优先级：`location ^~ /api/sync/auth/` 已存在且优先，新增的 `/api/sync/` 不会覆盖它。

---

## 3. 数据迁移方案

### 3.1 迁移清单（CF → cn，一次性）

| 数据 | 源 | 目标 | 工具 |
|---|---|---|---|
| notify D1 表（notify_features、notify_links） | `ai-dca-sync-db` | cn-data.db notify_rules | wrangler d1 export → sqlite import（需 connector 恢复，或用户本地跑） |
| notify KV（`holdings-rule:*`、`switch:*` 等） | NOTIFY_STATE | cn-data.db notify_configs | wrangler kv bulk get → 转换 → import |
| account D1 表 | ai-dca-sync-db | cn-data.db account_* | 同上 |
| sync backups D1+KV | ai-dca-sync-db + SYNC_BACKUPS | cn-data.db sync_backups | 同上 |
| users/sessions | 已在 cn（auth 本地化已完成） | — | 无需迁移 |

**阻塞点**：Cloudflare connector 被 authd 403 拦（2026-10-09 起），wrangler 无法从本机跑。迁移需要用户本地执行导出，或等 connector 恢复。

### 3.2 冲突解决

- 迁移窗口期：先停浏览器写（前端切到只读模式或维护页），导出 CF 数据，导入 cn，启动 syncDaemon 做首次全量同步，切前端到 cn 写。
- 冲突策略：cn 为准（Source of Truth）。迁移期间 CF 侧的写入直接丢弃（窗口期短，可接受）。
- 校验：按 user_id 对比两边记录数，抽样对比 payload hash。

### 3.3 回滚计划

每个阶段保留回滚开关：
- 前端：`apiBase.js` 保留 `apiUrlDirect` 做降级，环境变量 `VITE_DATA_PRIMARY=cf|cn` 一键切回。
- nginx：新 location 注释掉即回滚，reload 秒级。
- 数据：迁移前对 CF D1/KV 做完整导出备份（JSON），回滚时可重放。

---

## 4. 实施阶段

| 阶段 | 内容 | 交付物 | 预计 |
|---|---|---|---|
| 0 | 准备：确认 market-collector 18080 的数据存储细节；确认 connector 何时恢复（决定迁移工具链） | 调查报告 | 0.5 天 |
| 1 | cn-data 服务：搭框架（复用 services/auth）、建表、实现 notify/account/sync 读写 API | `services/cn-data/`、测试 | 2 天 |
| 2 | syncDaemon：扩展 outbox、实现三路同步（notify/account/sync worker）、指数退避、死信队列 | `services/cn-data/src/syncDaemon.js` | 1.5 天 |
| 3 | Worker 接收端：三个 worker 加 `/internal/sync-*` 端点（只写冗余，不改读路径） | worker 代码 + 部署 | 1 天 |
| 4 | 数据迁移：导出 CF → 导入 cn → 校验 | 迁移脚本 + 校验报告 | 0.5 天（等 connector） |
| 5 | 前端 + nginx：切写路径到 cn，加降级读 | 前端提交 + nginx 配置 | 1 天 |
| 6 | 联调：端到端（写→cn→outbox→CF→cron 推送）、故障演练（断 cn 写、断同步） | 验收报告 | 1 天 |

**总计**：约 7 天（不含等 connector 的时间）。

每阶段走标准流程：Codex plan → Codely 实现 → 测试/lint/refactor guard → 部署 → fast 站验收。

---

## 5. 风险清单

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **cn→CF 16s TTFB**（2026-10-12 实测） | syncDaemon 同步慢，冗余副本延迟大 | ① outbox 异步+批量（攒 10 条或 30s 一批）；② 推送只依赖副本做评估，延迟 <5min 可接受；③ 长期：换 cn 主机出口或 CF Enterprise |
| 2 | 同步期间 CF 推送读到旧副本 | 用户刚改的规则，15:30 批次没生效 | syncDaemon 高优先级队列（规则变更立即推，不批量）；前端写成功后提示"同步中" |
| 3 | 双写窗口的数据丢失 | 迁移时浏览器还在写 CF | 迁移窗口前端切维护模式；时间选凌晨 |
| 4 | cn 主机单点故障 | 所有写不可用 | ① cn 主机已有 supervisor 自愈；② 前端降级读 CF 副本（只读）；③ 写失败明确报错，不静默丢 |
| 5 | SQLite 并发写 | cn-data 高频写锁表 | WAL 模式；写操作短事务；必要时换 Postgres（阶段 1 预留抽象层） |
| 6 | Worker 部署依赖 connector | 阶段 3 卡住 | 用户本地 `wrangler deploy`（已有先例：推送合并 `c72d034b` 也是用户本地部署） |
| 7 | 通知推送的实时性 | 极端行情下用户期望秒级 | 推送执行仍在 CF，不受影响；只是规则同步有延迟 |
| 8 | 旧版前端缓存 | 用户浏览器还是旧 bundle，继续直写 CF | worker 原写入端点阶段二转代理到 cn（`fetch(cnHost + path)`），不丢数据 |

---

## 6. 不做的事（明确边界）

1. **不搬推送执行**：notify worker 的 cron、通道推送、Durable Object ws-hub 永久留在 CF。
2. **不搬 markets worker 的采集**：KV/R2 的行情采集留在 CF（它直调外部源，不经过 cn 瓶颈）。前端行情读路径不变。
3. **不碰 auth**：已经本地化，不动。
4. **不改 CF 表结构**：worker 读路径零改动，降低风险。
5. **localStorage 不动**：前端本地缓存策略不变。

---

## 7. 待用户拍板

1. **SQLite vs Postgres**：cn-data 用 SQLite（简单，复用现有）还是直接上 Postgres（为并发留余量）？推荐 SQLite 起步（WAL 模式），抽象好 DB 层以后换。
2. **sync 实时性要求**：规则变更后，冗余副本延迟容忍多少？推荐 <5 分钟（outbox 30s 批量 + 立即推高优先级）。
3. **迁移窗口**：选哪天凌晨做 CF→cn 的一次性迁移？需要 connector 恢复或用户本地配合导出。
4. **阶段 3 的 worker 部署**：用户本地 `wrangler deploy` 还是等 connector 恢复？
5. **是否接受"写只走 cn，cn 挂了写就不可用"**：还是要做浏览器直写 CF 的紧急逃生通道？推荐不做（复杂度爆炸），用明确报错代替。

---

## 附录：文件变更清单（初版）

**新增**：
- `services/cn-data/`（package.json、src/server.js、src/db.js、src/routes/notify.js、src/routes/account.js、src/routes/sync.js、src/syncDaemon.js、migrations/001-init.sql、test/）
- `scripts/migrate-cf-to-cn/`（导出/转换/导入/校验脚本）

**修改**：
- `src/app/apiBase.js`（删直连，加降级读）
- 11 处 `apiUrlDirect` 调用点（改回 `apiUrl`）
- `workers/notify/src/index.js`（加 `/internal/sync-rules`）
- `workers/account/src/`（加 `/internal/sync`）
- `workers/sync/src/index.js`（加 `/internal/sync-backup`）
- `/etc/nginx/sites-available/ai-dca-cn-5000`（加三个 location）
- `/etc/market-collector-supervisord.conf`（加 cn-data 和 syncDaemon）

**部署**：
- cn-data、syncDaemon 经 supervisor 常驻
- 三个 worker `wrangler deploy`
- 前端重新构建部署

---

## 8. 实施进度（2026-10-12）

> 用户决策：SQLite、分钟级同步、用户自行部署 worker、本地提交（不 push）、cn 挂写不可用可接受。
> 实现工具：Codex（用户明确要求不用 Codely）。

### Phase 1: services/cn-data/ ✅ 完成
- 新建 `services/cn-data/`：package.json、src/db.js（WAL、migration runner）、src/server.js（:8081）、src/outbox.js、src/syncDaemon.js、migrations/001-init.sql、test/、README.md
- 表：notify_rules、notify_configs、account_holdings_transactions、account_resources、sync_backups、sync_outbox、schema_migrations
- 23 个测试全过，零外部依赖

### Phase 2: Worker /internal/sync-* ✅ 完成（代码已写，未部署）
- `workers/shared/internalSync.js`：共享的认证+幂等框架（Bearer INTERNAL_SYNC_TOKEN、sync_events 去重表）
- `workers/notify/src/internalSyncRules.js`：POST /api/notify/internal/sync-rules（upsert-rule/delete-rule/upsert-config）
- `workers/account/src/internalSync.js`：POST /api/account/internal/sync
- `workers/sync/src/internalSyncBackup.js`：POST /api/sync/internal/sync-backup
- 三个 worker 的 index.js 已加路由
- **待用户操作**：本地运行 `npx wrangler deploy` 部署三个 worker

### Phase 3: 迁移脚本 ✅ 完成
- `scripts/migrate-cf-to-cn/`：README.md、export-cf.sh（用户本地跑 wrangler export）、export-local.mjs、import-to-cn.mjs（cn 主机跑）、migration.mjs、verify.mjs、migration.test.mjs
- **待用户操作**：本地跑 export-cf.sh 导出 D1/KV，scp 到 cn 主机后跑 import-to-cn.mjs

### Phase 4: 前端 ✅ 完成
- `src/app/apiBase.js`：新增 `apiUrlWithFallback()`、`fetchWithFallback()`（GET 失败降级到 CF，写操作不降级）
- 11 处调用点已改：读用 fallback，写走 cn
- `test/apiBase.test.mjs`：22 个测试全过

### 待办（需用户/运维配合）
1. **Worker 部署**：用户本地 `wrangler deploy`（notify、account、sync）
2. **数据迁移**：用户本地导出 → cn 主机导入 → verify.mjs 校验
3. **cn-data 部署**：supervisor 加 [program:ai-dca-cn-data]（:8081）+[program:ai-dca-sync-daemon]，nginx 加三个 location（/api/notify/、/api/account/、/api/sync/ → 127.0.0.1:8081，注意 /api/sync/auth/ 已有精确匹配优先）
4. **前端部署**：VITE_API_ORIGIN='' 重新构建部署（反转直连方案后，写走 cn）
5. **联调**：端到端测试写→cn→outbox→CF→cron 推送
