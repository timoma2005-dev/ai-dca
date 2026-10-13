# 全路由迁移 CN 主机计划

**目标**：CN 与 fast 域名的所有用户请求只走 CN 主机，不再路由到 CF worker。
**日期**：2026-10-12
**状态**：AUDIT + PLAN ONLY，未实施

---

## 1. 现状：nginx 路由表（cn 主机）

| 路径 | 目标 | 状态 |
|------|------|------|
| `/api/market-collector/` | 127.0.0.1:18080 | ✅ 本地 |
| `/api/market-collector/backtest` | 127.0.0.1:18080 (120s) | ✅ 本地 |
| `/api/fund-limit` | 127.0.0.1:18080 | ✅ 本地 |
| `/api/markets/` | 127.0.0.1:18080 | ✅ 本地 |
| `/api/fund-fee` | 127.0.0.1:18080 | ✅ 本地 |
| `/api/sync/auth/` | 127.0.0.1:8080 (auth) | ✅ 本地 |
| `/api/notify/` | 127.0.0.1:8081 (cn-data) | ⚠️ 部分 |
| `/api/account/` | 127.0.0.1:8081 (cn-data) | ⚠️ 部分 |
| `/api/sync` (exact) | 127.0.0.1:8081 (cn-data) | ⚠️ 部分 |
| `/wechat/` | 静态文件 | ✅ 本地 |
| `/api/` (catch-all) | https://api.freebacktrack.tech | ❌ CF |

### cn-data 已实现的端点（:8081）

- `GET /health`
- `/api/notify/rules` (GET/POST/DELETE)
- `/api/notify/configs` (GET/POST)
- `/api/notify/switch/config` (GET/POST)
- `/api/notify/switch/snapshot` (GET)
- `/api/notify/switch/run` (POST → 501)
- `/api/account/transactions` (GET/POST)
- `/api/account/resources` (GET/POST)
- `/api/sync/backup` (GET/PUT)

---

## 2. 仍走 CF 的路由清单

### 2.1 Notify Worker (`/api/notify/*` via catch-all)

| 路径 | 方法 | 用途 | 前端调用 | 迁移难度 |
|------|------|------|----------|----------|
| `/api/notify/status` | GET | 用户状态/规则汇总 | ✅ | 中 - 需聚合多表 |
| `/api/notify/events` | GET | 通知历史 | ✅ | 中 - 需 events 表 |
| `/api/notify/sync` | POST | 旧版同步 | ✅ | 低 - 可转调 cn-data |
| `/api/notify/test` | POST | 测试推送 | ✅ | 高 - 需推送通道 |
| `/api/notify/settings` | POST | 设置 | ? | 低 |
| `/api/notify/email/status` | GET | 邮箱状态 | ✅ | 中 |
| `/api/notify/email/send-code` | POST | 发验证码 | ✅ | 高 - 需邮件通道 |
| `/api/notify/email/verify` | POST | 验验证码 | ✅ | 中 |
| `/api/notify/email/save` | POST | 保存邮箱 | ✅ | 低 |
| `/api/notify/email/enable` | POST | 启用 | ✅ | 低 |
| `/api/notify/email/disable` | POST | 禁用 | ✅ | 低 |
| `/api/notify/holdings-rule` | GET/POST | 每日汇总规则 | ✅ | 低 - 已在 KV |
| `/api/notify/nasdaq-radar` | GET | 雷达数据 | ✅ | 中 - 需 KV |
| `/api/notify/nasdaq-radar/compute` | POST | 手动计算 | ✅ | 中 - 需计算逻辑 |
| `/api/notify/switch/test` | POST | 切换测试 | ✅ | 高 - 需完整逻辑 |
| `/api/notify/switch/test-nav` | GET | 测试 NAV | ? | 中 |
| `/api/notify/ws/register` | POST | WS 注册 | ✅ | 高 - 需 DO |
| `/api/notify/ws/unregister` | POST | WS 注销 | ✅ | 高 - 需 DO |
| `/api/notify/ws/*` | WS | WebSocket 升级 | ✅ | **不可迁移** - Durable Object |
| `/api/notify/quant/*` | * | 已移除 (410) | ❌ | 无需 |
| `/api/notify/gcm/*` | POST | GCM 推送 | ? | 高 |
| `/api/notify/gotify-account` | POST | Gotify 账号 | ? | 中 |
| `/api/notify/run` | POST | 手动触发 | ? | 高 - 需推送引擎 |
| `/api/notify/admin/*` | * | 管理接口 | ❌ | 低 |
| `/api/notify/health` | GET | 健康检查 | ❌ | 低 |
| Bark 路由 | GET/POST | Bark 推送回调 | ❌ | 中 |

### 2.2 Account Worker (`/api/account/v1/*` via catch-all)

**⚠️ 关键缺口**：nginx 的 `/api/account/` 转到 cn-data，但 cn-data 不处理 `/api/account/v1/*`，全部 404。前端靠 `apiUrlDirect` fallback 到 CF 才正常工作。

| 路径模式 | 用途 | 资源数 | 迁移难度 |
|----------|------|--------|----------|
| `/api/account/v1/{resource}/{name}` | 25 种资源读写 | 25 | **高** - 需完整 merge 逻辑 |
| `/api/account/v1/{resource}/{name}/items/{id}` | 单项读写 | - | 高 |
| `/api/account/v1/health` | 健康 | - | 低 |
| `/api/account/v1/manifest` | 清单 | - | 低 |
| `/api/account/v1/bundle` | 打包 | - | 中 |
| `/api/account/v1/exports/envelope` | 导出 | - | 中 |
| `/api/account/v1/migrations/legacy` | 迁移 | - | 中 |
| `/api/account/v1/migrations/legacy/skip` | 跳过迁移 | - | 低 |

25 种资源：holdings/ledger, holdings/state, holdings/allocation, holdings/accumulation, holdings/position-snapshot, trades/ledger, trades/archive, plans/store, plans/state, dca/store, dca/state, sell-plans/store, sell-plans/draft, vix/state, fund-switch/prefs, fund-switch/worker-config, notify/client-config, notify/web-config, notify/market-alerts, notify/holding-alerts, markets/watchlist, prefs/workspace, prefs/home-dashboard, prefs/analytics-opt-out, prefs/premium

### 2.3 Sync Worker (`/api/sync/*` via catch-all)

| 路径 | 方法 | 用途 | 迁移难度 |
|------|------|------|----------|
| `/api/sync/analytics/track` | POST | 埋点 | 低 - 可存本地 |
| `/api/sync/admin/analytics` | GET | 分析后台 | 低 |
| `/api/sync/meta` | GET | 元数据 | 低 |
| `/api/sync/versions` | GET | 备份版本 | 中 |
| `/api/sync/versions/rollback` | POST | 回滚 | 中 |
| `/api/sync/latest` | GET/PUT | 最新备份 | 中 |
| `/api/sync/health` | GET | 健康 | 低 |
| `/api/sync/probe` | GET | 探针 | 低 |

注意：`/api/sync/auth/*` 已走本地 :8080，不在此列。

### 2.4 OCR Proxy Worker

| 路径 | 用途 | 迁移难度 |
|------|------|----------|
| `/api/ocr` | OCR 识别（Workers AI） | **不可迁移** - 需 CF AI binding |
| `/api/holdings/ocr` | 持仓 OCR | **不可迁移** - 依赖 AI |
| `/api/holdings/nav` | 净值查询 | 中 - 需数据源 |
| `/api/holdings/nav-history` | 净值历史 | 中 - 需数据源 |

### 2.5 其他

| 路径 | 用途 | 迁移难度 |
|------|------|----------|
| `/api/geo` | 边缘国家码 | 低 - 简单逻辑，可用 IP 库替代 |
| `/api/wechat/*` | 微信相关 | 中 - 在 notify worker |

### 2.6 前端直连 CF（绕过 nginx）

`src/app/apiBase.js` 的 `apiUrlDirect()` / `apiUrlWithFallback()`：
- `accountApi.js:43` - `/api/account/v1` fallback
- `authClient.js:155` - `/api/sync` fallback
- `analytics.js:1041` - `/api/sync/admin/analytics` fallback
- `regionEnvironment.js` 注释提到 `api.freebacktrack.tech/api/geo`

用户要求"所有请求只走 CN"，这些 fallback 也要去掉（或改为仅 CN，失败即报错）。

---

## 3. 必须留在 CF 的（非用户请求）

| 项目 | 原因 |
|------|------|
| Notify worker cron 推送 | 后台定时任务，非用户请求；推送通道（Bark/邮件/Server酱）需 CF 网络 |
| Market-collector cron 采集 | 后台数据采集，非用户请求 |
| WebSocket Durable Object (`/api/notify/ws/*` 升级) | CF 特有，CN 主机无 DO |
| Workers AI (`/api/ocr`, `/api/holdings/ocr`) | 需 CF AI binding |
| `/internal/sync-*` 端点 | CN→CF 冗余同步接收端，必须留在 CF |
| Markets worker 数据采集 | 后台任务（但 `/api/markets/` 已走本地 :18080） |

---

## 4. 迁移计划

### Phase 1: Account v1 API（最高优先级，当前 404 靠 fallback 苟活）
- 在 cn-data 新增 `/api/account/v1/*` 完整实现
- 需移植 `workers/account/src/catalog.js` 的 25 种资源定义
- 需移植 merge 逻辑（`holdingsTransactions`, `arrayById`, `planStore`, `dcaStore`, `lww`, `watchlist`）
- 需移植 `exports/envelope`, `migrations/legacy`, `manifest`, `bundle`
- 预估：3-4 天（含测试）

### Phase 2: Notify 高频端点
- `/api/notify/status` - 聚合查询
- `/api/notify/events` - 需新建 events 表（当前只在 CF D1）
- `/api/notify/holdings-rule` - 简单 KV 读写
- `/api/notify/email/*` - 6 个端点，需邮件发送逻辑（或转调 CF）
- `/api/notify/nasdaq-radar*` - 需 KV + 计算
- 预估：2-3 天

### Phase 3: Sync 剩余端点
- `/api/sync/analytics/track`, `/api/sync/admin/analytics`
- `/api/sync/versions*`, `/api/sync/latest`, `/api/sync/meta`
- 预估：1-2 天

### Phase 4: 长尾端点
- `/api/notify/switch/test`, `/api/notify/switch/test-nav`
- `/api/notify/gotify-account`, `/api/notify/run`
- `/api/notify/settings`, `/api/notify/test`
- `/api/geo` - 简单实现
- `/api/wechat/*` - 评估是否仍需
- 预估：2 天

### Phase 5: 前端清理
- 去掉 `apiUrlDirect` fallback（或改为纯 CN）
- 去掉 `DIRECT_API_PREFIXES` 相关逻辑
- `fetchWithFallback` 改为直接 fetch（失败即报错）
- 预估：0.5 天

### Phase 6: nginx 收尾
- catch-all `/api/` 改为返回 404（或保留作最后兜底）
- 确认无流量再删

---

## 5. 风险

1. **Account v1 是最大块**：25 种资源的 merge 逻辑复杂，测不全会丢数据。必须逐资源写测试。
2. **Events 表缺失**：`/api/notify/events` 需要通知历史，cn-data 没有这张表，需新建并从 CF 导入。
3. **Email 通道**：验证码邮件需实际发送，CN 主机能否直连邮件服务商需验证。
4. **WebSocket**：PC 端实时推送依赖 CF DO，迁不走。用户要求"所有请求走 CN"，但 WS 升级必须走 CF，这是硬约束，需用户确认接受。
5. **OCR**：Workers AI 迁不走，同上需确认。

## 6. 待用户拍板

1. WebSocket 实时推送是否接受继续走 CF？（技术上无法迁移）
2. OCR（Workers AI）是否接受继续走 CF？（技术上无法迁移）
3. 邮件验证码发送：CN 主机直发还是继续走 CF？
4. Phase 1 的 Account v1 是否现在开工？

## 实施完成（2026-10-12 21:50 CST）

| Phase | 内容 | 提交 | 状态 |
|-------|------|------|------|
| 1 | /api/account/v1/* 25 种资源 | 6238e0c2 + d1833de3 + 657bb06b | 已部署 |
| 2 | /api/notify/status、events、holdings-rule | 1342e804 | 已部署 |
| 3 | /api/sync/analytics、versions、latest、meta | 1c053eb2 | 已部署 |
| 4 | 长尾：geo、gotify/gcm/quant（410）、wechat（410）、test/run（501） | 11ca43b5 | 已部署 |

额外：notify_user_records 43,487 条历史已回填到 cn-data。

留 CF 的（用户 21:08 拍板）：WebSocket（Durable Object）、OCR（Workers AI）、邮件（/api/notify/email/*）、cron 推送/采集、/internal/sync-*。

nginx 验证：6 个端点经 https://127.0.0.1:5000 全部正常（401/200 符合预期）。

待 push：本地 cn 分支领先远端，需 PAT。
