# ai-dca

`ai-dca` 是一个面向基金、ETF 和个人持仓的策略工作台。本仓库的 `cn` 分支是**国内专线（CN）分发版本**，与以 Cloudflare 为中心的全球版有一个关键差异：

> **CN 机上的本地 SQLite 是数据主存，Cloudflare D1 是异步副本。**
> 账户、通知规则、加密备份等写入先在 CN 机本地事务落库并立即返回，再由后台 outbox 守护进程通过内部鉴权接口幂等同步到 D1；跨境链路抖动不影响注册、登录和读写。

前端仍是 React + Vite 单页应用，运行时通过**同源相对路径**请求 `/api/...`，由 CN 机 nginx 按路径把请求分流到本机各服务或 Cloudflare 上游。

---

## 功能概览

控制台左侧主菜单默认进入「行情中心」。当前主菜单为：

- **行情中心** `markets`：A 股 / 美股自选、行情搜索、指数、热点、新闻、财务、基金详情、场内 ETF 溢价、场外净值/费率/限购。
- **持仓总览** `holdings`：手工交易、截图 OCR、持仓聚合、收益拆分、切换交易配对、NAV/实时价刷新、清仓分析与交易记录。
- **交易计划** `tradePlans`：建仓、定投、卖出、VIX 信号与回测工具；旧 `home` / `dca` 入口重定向到此。
- **基金切换** `fundSwitch`：H/L 分组、worker/本地监控、切换信号、快捷记录与历史切换收益复盘。
- **通知设置** `notify`：提醒规则同步、测试通知、最近提醒，通道为 Bark / Server酱³ / 邮件 / PC WebSocket。

账户菜单提供登录、加密云同步、冲突合并、本地备份预览；管理员账号额外看到「数据」入口。所有时间戳按 Asia/Shanghai（UTC+8）渲染。

---

## 系统架构（CN 分支）

### 进程与端口

所有业务进程只绑定 `127.0.0.1`，唯一对外入口是 nginx 的 5000（SSL）。

| 端口 | 进程 | 技术 | 存储 / 说明 |
| --- | --- | --- | --- |
| 5000 | **nginx** | — | 公网入口，TLS 终结、路径分流、`auth_request` RBAC |
| 4173 | 前端 `vite preview` | Node/Vite | 静态托管发布软链 `/var/www/ai-dca-cn`，仅本机 |
| 8080 | `services/auth` | Node 内置 `node:sqlite` | 认证库 `/var/lib/ai-dca-auth/auth.sqlite`：注册/登录、session、RBAC |
| 8081 | `services/cn-data` | Node 内置 `node:sqlite` | 业务库 `/var/lib/ai-dca-cn-data/cn-data.db`：账户资源、通知、备份；以只读方式打开认证库做鉴权 |
| 8082 | `services/etf-mirror` | Python 标准库 | ETF PCF 份额/限额本地镜像，SQLite `ETF_MIRROR_DB`，命中本地毫秒返回、失败宁旧勿断 |
| 18080 | `services/market-collector` | Python 3 | 行情采集/回测/模拟交易，SQLite 主存 + 可选 TiDB 副本 |
| — | Cloudflare 上游 | Workers + D1/KV/R2 | nginx upstream `ai_dca_cf_api_v4`，承担 D1 副本与部分跨境 API |

### nginx 分流（`deploy/cn/nginx-ai-dca-cn-5000.conf`）

`server_name cn.freebacktrack.tech fast.freebacktrack.tech`，`listen 5000 ssl`。

| 路径前缀 | 去向 | 鉴权 |
| --- | --- | --- |
| `/`、`/react-assets/`、`/asset-cache-sw.js`、`/auction-board.html` | 前端 4173 | 竞价看板另挂 `auth_request` |
| `/api/sync/auth/` | auth 8080（注册/登录/会话/RBAC） | 路由内 Bearer / httpOnly cookie |
| `/api/notify/`（除 nasdaq-radar） | cn-data 8081 | RBAC `api:notify` / `api:fund-switch` |
| `/api/account/` | cn-data 8081 | RBAC `api:account` |
| `/api/sync` | cn-data 8081 `/sync`（备份/埋点） | RBAC `api:sync`，健康/探活/埋点匿名 |
| `/api/etf-pcf-shares`、`/api/etf-pcf-limit` | etf-mirror 8082 | 透传 |
| `/api/market-collector/`、`/api/markets/`、`/api/fund-limit`、`/api/fund-fee` | market-collector 18080 | 模拟交易 `auth_request` |
| `/api/notify/nasdaq-radar[/compute]` | **Cloudflare** `ai_dca_cf_api_v4` | `auth_request`（`api:nasdaq-radar[-compute]`） |
| 其它 `/api/` | Cloudflare 上游兜底 | 由对应 Worker 决定 |

RBAC 通过 nginx `auth_request` 子请求调用 auth 服务的 `GET /api/sync/auth/check?perm=<code>`：200 放行、401 未登录、403 权限不足。会话 cookie 为 `aidca_session`，属性 `HttpOnly; Secure; SameSite=Lax`。

### 数据存储与 outbox 同步

两个 Node 服务都使用 `node:sqlite` 的 `DatabaseSync`，统一开启 `PRAGMA journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`，迁移为前向式 SQL 文件且每个迁移在独立事务内提交。

**事务性 outbox**：每一笔业务写入和对应的 `sync_outbox` 入队在同一个 `BEGIN IMMEDIATE` 事务里提交，因此不会出现「库已改但事件丢失」。后台守护进程轮询 claim 事件并投递到 CF Worker 的内部接口：

| 来源服务 | 守护进程 | 事件 | CF 内部接口 |
| --- | --- | --- | --- |
| `services/auth` | `syncWorker.js` | `user.register` / `user.login`（含 `token_hash` 会话快照） | `POST /api/sync/internal/sync-auth` |
| `services/cn-data` | `syncDaemon.js` | `upsert-rule` / `delete-rule` / `upsert-config` | `POST /api/notify/internal/sync-rules` |
| `services/cn-data` | `syncDaemon.js` | `upsert-resource` / `upsert-transaction` / `delete-transaction` | `POST /api/account/internal/sync` |
| `services/cn-data` | `syncDaemon.js` | `upsert-backup` | `POST /api/sync/internal/sync-backup` |

投递与一致性语义：

- 每个内部请求带 `Authorization: Bearer <INTERNAL_SYNC_TOKEN>`；Worker 侧未配置 token 时 **fail-closed 返回 503**，并使用恒定时间比较。
- Worker 以 `event_id` + 规范 JSON 的 `payload_hash` 做幂等，D1 侧用 `sync_events` 去重并在单批次原子提交；同一事件重放不会重复落库。
- 原始访问 token 不进入同步事件，只传它的 SHA-256；会话到期时间复用建行值，不重新计算 30 天。
- 失败重试：网络错误 / 429 / 5xx 指数退避（5s 起、上限 30min、±10% 抖动），429 至少等 60s 并尊重 `Retry-After`；其它 4xx 进入死信（`status='dead'`）不再自动重试。
- `cn-data` 的 outbox 带 `claimed_at` 租约，claim 时会把卡在 `processing` 超过 10 分钟的事件重置回 `pending`，守护进程崩溃可自愈。
- 语义为**至少一次投递**，因此接收端必须按事件 ID 去重并拒绝过期版本/时间戳。每个数据库只运行一个守护进程。

其它两条数据链路：

- **market-collector**：SQLite 为主存，可选 TiDB 副本（`storage_backend=dual`），TiDB 失败进 `replica_outbox` 重试；快照发布走本地 `publish-outbox` 推送到 Worker。
- **etf-mirror**：后台线程定期从 CF `etf-shares` Worker 拉取投影/限额原样落本地 SQLite，HTTP 读本地；未命中的历史日期/非目标 code 同步回源并落库，CF 不可达时持续返回最近一次成功数据。

### 数据存储与加密

**账户资源主路径（当前）**：`/api/account/v1` 的 REST 请求体为明文 JSON，鉴权复用登录 Bearer 会话（见 `src/app/accountApi.js`），传输安全依赖 HTTPS，cn-data SQLite 与 D1 直接保存明文资源。因此服务端静态存储安全（DB 文件权限、磁盘/备份加密、日志脱敏、访问审计）是这条链路的主要控制点。

**登录口令**：原始密码不离开浏览器——前端先算 `clientHash = sha256(小写用户名 + ':' + 密码)`；服务端再对 clientHash 做 PBKDF2-HMAC-SHA256（31 万次、随机盐），存为自描述 PHC `$pbkdf2-sha256$...`。Node（`services/auth/src/password.js`）与 Cloudflare Worker（`workers/sync/src/password.js`）参数逐一对齐、可互验；旧单轮 SHA-256 用户首登验证通过后惰性轮转。

**旧版端到端加密（仅迁移保留）**：`src/app/secureVault.js` 的 AES-GCM-256 + PBKDF2（31 万次）KEK 包裹随机 DEK 方案只用于解开历史备份（`legacyMigration.js` 按 `password` / `device-key` / `plaintext` 分类导入到新的明文资源结构）。新数据不再产生这类密文信封；存量迁移完成前该模块不能下线。

---

## 目录结构

```text
src/                     React 前端（页面、组件、app 业务逻辑、加密 vault）
workers/                 Cloudflare Workers（D1 副本侧 + 跨境 API）
  sync/                  注册/登录（PBKDF2 PHC）、备份、内部 sync-auth/sync-backup 接收端
  account/               账户资源 v1、交易行、内部 sync 接收端
  notify/                推送、规则同步、cron、WsHub、内部 sync-rules 接收端
  markets/               行情、K 线、基金指标、新闻/财务
  ocr-proxy/             截图 OCR、持仓 NAV、限购
  etf-shares/            ETF PCF 份额/限额（etf-mirror 的上游）
  markets-agent/         行情研究/回测 Agent（Worker + Container）
  apex-redirect/         旧 tools 域名跳转
services/                CN 机本地服务（本分支的数据主存）
  auth/                  认证服务（8080）：node:sqlite + outbox，见其 README
  cn-data/               账户/通知/备份服务（8081）+ syncDaemon，见其 README
  etf-mirror/            ETF 份额本地镜像（8082，纯标准库 Python）
  market-collector/      行情采集与回测（18080，Python），见其 README
deploy/cn/               nginx 与 supervisor 配置
scripts/cn-frontend/     CN 前端发布/回滚/守护脚本
docs/                    架构、运维、归档设计文档
test/                    前端与共享逻辑单测（Node node:test）
```

---

## 本地开发

### 前端

```bash
npm install
npm run dev          # Vite 开发服务器
npm run lint         # ESLint
npm run check:refactor   # 文件行数/拆分守卫，构建前必须通过
```

前端构建默认把 `VITE_API_ORIGIN` 留空，产出的资源走同源相对路径，由部署环境的 nginx 分流；需要指向特定后端时再显式覆盖该变量。

### 本地服务（需要 Node >= 22.5，使用 `node:sqlite`；22.5–22.12 可能需要 `NODE_OPTIONS=--experimental-sqlite`）

两个 Node 服务只用 Node 内置模块，**无需 `npm install`**。HTTP 服务与同步守护进程是两个独立进程，共用同一个绝对路径的数据库文件。

```bash
# 认证服务（127.0.0.1:8080）
cd services/auth
AUTH_DB_PATH=/tmp/auth.sqlite npm start
# 另开进程：把注册/登录事件同步到 D1
INTERNAL_SYNC_TOKEN=<token> SYNC_WORKER_URL=https://<worker>/api/sync/internal/sync-auth \
  AUTH_DB_PATH=/tmp/auth.sqlite npm run sync-worker

# 业务数据服务（127.0.0.1:8081）
cd services/cn-data
CN_DATA_DB_PATH=/tmp/cn-data.db npm start
# 另开进程：同步 notify/account/sync 三类事件
INTERNAL_SYNC_TOKEN=<token> \
  SYNC_DAEMON_NOTIFY_URL=https://<worker> \
  SYNC_DAEMON_ACCOUNT_URL=https://<worker> \
  SYNC_DAEMON_SYNC_URL=https://<worker> \
  CN_DATA_DB_PATH=/tmp/cn-data.db npm run sync
```

Python 服务：

```bash
# 行情采集（18080）
cd services/market-collector
pip install -r requirements.txt
python3 -m market_collector --root . --config config.json          # 守护采集
python3 -m market_collector.product_http_server --host 127.0.0.1 --port 18080 ...

# ETF 镜像（8082，仅标准库）
ETF_MIRROR_DB=/tmp/etf.db python3 services/etf-mirror/service.py
```

### Cloudflare Workers

Worker 仍是 D1 副本侧与跨境 API 的承载者，本地可用 wrangler 调试；**不要在本机执行 `wrangler deploy`**，部署凭证只存在于受控的 CI 密钥中。

---

## 部署（CN 机）

> 本分支不包含 `.github/workflows`，CN 前端与本地服务**不走 GitHub Actions 发布**，而是由 CN 机上的 supervisor + 发布脚本管理。

### 前端发布（唯一合法入口）

`scripts/cn-frontend/` 提供完整的不可变发布链路：

- `release.sh`：栅栏校验（工作区干净且 HEAD 已 push 到 origin）→ Vite 构建到带时间戳的新目录 → 生成 `MANIFEST.sha256` 并置只读 → 原子切换 `/var/www/ai-dca-cn` 软链 → 重启 `vite preview` → 健康检查，失败自动回滚。
- `guard.sh`（supervisor `ai-dca-frontend-guard`）：每 60s 校验线上目录指纹，被篡改或损坏时自动回滚到最近一个校验通过的版本。
- `autorelease.sh`（supervisor `ai-dca-frontend-autorelease`）：每 60s `git fetch`，当 origin 有涉及前端路径的新提交且工作区干净时 fast-forward 并触发 `release.sh`。
- `rollback.sh <时间戳>`：手动回滚到指定发布目录（必须先通过 `verify.sh`）。

强制栅栏：禁止直接修改 `/var/www/ai-dca-cn*`、发布目录、`react-assets` 等构建产物；`.claude/settings.json` 的钩子会拦截对产物的编辑。详见 `docs/ops/线上开发规范.md`。

### 进程托管

`deploy/cn/` 下的 supervisor 配置托管前端 `vite preview`、自动发布与守护进程；`services/*` 与 Python 采集服务各自有 supervisor 配置（见 `services/market-collector/deploy/supervisor.conf` 及各服务 README）。nginx 配置变更后 `nginx -t` 再 reload。

---

## CF Worker 与本地服务 API 边界

Worker 源码仍在 `workers/`，其中带 `internal` 的路径是 CN outbox 的接收端（token 鉴权、幂等），其余是端侧或 nginx 兜底调用的业务 API。

| Worker | 主要职责 | CN 分流情况 |
| --- | --- | --- |
| `sync` | 注册/登录、加密备份、埋点、`internal/sync-auth`、`internal/sync-backup` | 认证/备份由本机 8080/8081 主处理，D1 为副本 |
| `account` | 账户资源 v1、交易行、`internal/sync` | 本机 8081 主处理，D1 为副本 |
| `notify` | 推送、规则、cron、WsHub、`internal/sync-rules`、nasdaq-radar | 规则本机 8081；nasdaq-radar 仍走 CF |
| `markets` | 行情/K 线/基金指标/新闻/财务/AI | 列表与常用指标走本机 18080，兜底走 CF |
| `ocr-proxy` | 截图 OCR、持仓 NAV、限购 | CF 侧能力 |
| `etf-shares` | ETF PCF 份额/限额 | 经 etf-mirror 8082 本地化 |
| `markets-agent` | 行情研究/回测 Agent + Container | CF 侧 |
| `apex-redirect` | 旧 `tools` 域名 302 | CF 侧 |

域名：主站 `https://freebacktrack.tech`，CN 专线 `https://cn.freebacktrack.tech:5000`，Worker API `https://api.freebacktrack.tech`。

---

## 行情与净值

- **CN 链路**：market-collector（18080）从腾讯、东方财富、蛋卷、雪球等源采集，落本地 SQLite 并提供列表/指标/K 线/首页聚合；ETF 份额走 etf-mirror。
- **CF 链路**：`markets` Worker 负责跨境源（Yahoo、CBOE、FRED、雪球等）与 AI 能力，作为 nginx 的 `/api/` 兜底与全球版数据源。
- 纳指候选池与 QDII 识别表内置在 `src/app/nasdaqCatalog.js`、`src/app/qdiiFundCodes.js`；QDII NAV 规则见 `docs/reference/qdii-nav-rules.md`。

---

## 测试

```bash
# 前端 / 共享逻辑（Node 内置 test runner）
node --test test/*.test.mjs
npm run lint
npm run check:refactor

# CN 本地服务（各自目录，使用 glob，内存 SQLite）
cd services/auth    && npm test     # 94 个用例
cd services/cn-data && npm test     # 路由 / outbox / 守护进程 / RBAC

# Python 采集服务（stdlib unittest）
cd services/market-collector
python3 -m unittest discover -s tests -p "test_*.py"

# 端到端
npm run test:e2e:smoke
```

服务测试以内存 SQLite 覆盖路由、outbox  claim/重试/死信/租约回收与守护进程投递；Worker 侧测试位于各 `workers/*/test` 目录。

---

## 知识库

Cloudflare Vectorize 索引 `ai-dca-kb`（1024 维 cosine）由 `scripts/build_kb.mjs` 基于 README、AGENTS、`docs/**`、Worker README 等构建，属于 CF 侧能力，CN 分支不直接参与其发布。

---

## 备注

- 旧 Android GCM/FCM 接收端已废弃；当前通知通道为 Bark、Server酱³、邮件与 PC WebSocket。
- 旧 `home` / `dca` / `quant*` 入口映射到当前工作台，不再作为独立主菜单。
- 时区统一为 Asia/Shanghai（UTC+8）。

## 社区支持

感谢 [LinuxDo](https://linux.do/) 各位佬的支持。欢迎加入 LinuxDo，这里有技术交流、AI 前沿资讯和实战经验分享。
