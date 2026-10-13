# ai-dca cn 分支重构方案
基于完整代码快照的现状盘点、问题诊断与分阶段落地路线图

timoma2005-dev/ai-dca
branch: cn
commit 91bff4ba
快照 2026-10-09
968 files / 130,614 lines
报告生成 2026-10-10

## 执行摘要

一句话结论：这不是一个「烂摊子项目」，而是一个工程纪律明显高于平均水平、但安全网刚刚被拆掉的高速迭代项目。它已经有 159 个测试文件、自研架构护栏和良性拆分过的回测内核；真正的风险集中在四处「同一业务规则被复制成多份实现」以及CI 被整体删除。因此重构的第一步不是动代码，而是把门禁装回去。

- 130,614 源码总行数
- 21,961 测试代码行（159 文件）
- 51 超 500 行的源文件
- 4 份交易日历实现
- 18+ 份 round() 实现
- 238 处 localStorage 直写
- 0 条 CI 流水线

### 必须知道的 5 件事

1. A 股交易日历有 4 份独立实现，并且已经漂移。notify worker 的假期表缺整个 2024 年，而两年期溢价回测恰好依赖 2024 假期数据。前端与边缘推送在该区间会算出不同结果。阻塞级
2. round() 被复制了 18+ 份，语义已经不一致。带 Number.EPSILON 的版本 round(1.005)=1.01，不带的版本 =1。同一笔金额在回测页与持仓页可能落到不同的分位。项目没有引入任何 Decimal 库。阻塞级
3. 凭据文件.internal_sync_token 已提交进仓库且不在.gitignore 内。另有「记住本设备」把原始数据密钥以明文写进 localStorage。阻塞级
4. CI 已被整体删除（commit 06363f1d「移除所有 GitHub Actions workflows」）。现成的 159 个测试文件、ESLint、Prettier、架构护栏、Playwright 视觉回归全部不会自动运行，在一周约 30 次提交、6 个并行分支的节奏下极其危险。阻塞级
5. 两个功能分支各落后 633 个提交（codex/collector-premium-wip、feat/holdings-daily-push-entry），且都重写了 NotifyExperience.jsx（-847 行）。任何触及 notify 的重构都会硬冲突 —— 必须先决策这两个分支的去留。高

### 推荐执行顺序

共 6 个阶段，每个阶段都可独立合并上线，不做一次性大爆炸重写：

| 阶段 | 目标 | 工作量 | 风险 |
|------|------|--------|------|
| 0 | 恢复安全网：最小 CI + 凭据止血 + lint 扩面 | 0.5–1 人天 | 极低 |
| 1 | 交易日历唯一真源（先补一致性测试再替换） | 1–1.5 人天 | 中 |
| 2 | 金额精度唯一入口（只收口，不改语义） | 1.5–2 人天 | 中高 |
| 3 | 存储层与事件总线收口 | 2–3 人天 | 中低 |
| 4 | 拆解超大文件 + 扩展护栏覆盖 | 3–5 人天 | 中 |
| 5 | 数据访问层统一 + 可选类型化 | 5–8 人天 | 中高 |

工作量为估算，依据文件规模与改动面推算，非实测。

## 证据等级说明

本报告刻意区分「实读代码得出的事实」与「推断」，便于你判断每条结论的可信度。

### 分析方式
- 通过 GitHub MCP 连接器列目录确认仓库结构，再用 codeload tarball 完整下载 cn 分支快照（commit 91bff4ba3e8c6766b9b57ed1ecfe68486cc8f267，2026-10-09），本地读到全部 968 个文件。
- 行数、重复定义、调用分布等统计均由本地脚本实测，非目测估计。
- 精度差异、FIFO 守恒、假期表缺失等结论通过实际运行 Node 脚本与项目测试验证。
- 分支差异通过 GitHub compare API（SHA 对 SHA）实测。
- 本次仅做分析。未修改仓库任何内容，未创建分支、提交或 PR，未改动任何远端配置。

### 标注为的结论（仅此三类）
- index.html 与 home.html「疑似重复」—— 依据是两者字节数相同（均 3,640 字节），未逐字节比对内容。
- feat/notify-preset-switches「几乎是空分支、可直接关掉」—— 依据是其变更仅为删除 workflow 文件，处置建议仍需你本人确认。
- 各阶段工作量估算 —— 基于文件规模与改动面推算，非实测。

### 未深读的部分
- package-lock.json（288KB 依赖锁）—— 仅确认存在，未逐项审计依赖树与已知漏洞。
- 各 wrangler.toml 中的 database_id 等机密值 —— 刻意未读取、未展示。
- docs/ 目录仅 1 个文件 74 行，信息量有限。
- 本报告不包含任何 token 或密钥的实际值。

## 代码现状盘点

### 总体规模（实测）

| 目录 | 文件数 | 行数 | 说明 |
|------|--------|------|------|
| src/ | 386 | 78,696 | 前端 React 应用（.js/.jsx/.css） |
| workers/ | 152 | 35,630 | 7 个 Cloudflare Workers |
| scripts/ | 15 | 2,541 | 部署、诊断、数据脚本 |
| services/ | 9 | 1,345 | auth（Node+SQLite）、market-collector（Python） |
| test/ + 各 worker test | 159 | 21,961 | 原生 node --test 单测 |
| 源码合计 | | 130,614 | 含.js/.jsx/.mjs/.ts/.py |

src/app/ 共 116 个.js 文件、24,836 行，平均 205 行/文件。超过 500 行的源文件共 51 个。

### 超大文件 TOP 15（实测行数）

| 行数 | 文件 | 性质判断 |
|------|------|----------|
| 2,059 | src/components/markets/BacktestSidePanel.jsx | UI + 回测配置 + 结果渲染混杂，且不在护栏预算内 |
| 1,831 | workers/markets/src/fetchers.js | 多数据源抓取全塞一个文件 |
| 1,562 | src/pages/markets/MarketSymbolDetailPanel.jsx | 22 useState / 17 useEffect |
| 1,377 | src/pages/MarketsExperience.jsx | 51 useState / 24 useEffect，状态最失控 |
| 1,299 | src/pages/HoldingsExperience.jsx | 22 useState / 11 useEffect |
| 1,266 | workers/notify/src/switchStrategy.js | 边缘侧策略计算 |
| 1,254 | src/pages/markets/MarketListTable.jsx | 表格渲染 + 列定义 |
| 1,237 | src/pages/TradePlansExperience.jsx | 13 useState |
| 1,151 | src/app/holdingsLedgerCore.js | 核心台账聚合，单函数 aggregateByCode 约 258 行 |
| 1,111 | workers/sync/src/index.js | 同步 worker 入口 |
| 1,099 | src/pages/SwitchStrategyExperience.jsx | 17 useState / 14 useEffect |
| 1,055 | src/app/analytics.js | 埋点，被 31 个文件引用（扇入最高） |
| 943 | src/pages/HomeExperience.jsx | 20 useState |
| 885 | src/app/holdingTransactionsSync.js | 行级持仓台账同步 |
| 876 | src/pages/NotifyExperience.jsx | 30 useState；被两个分支重写 |

### 技术栈与构建配置（实读）

- 框架：React 19.2 + Vite 5.4，type: module
- UI 库：Tailwind 4.2、Radix UI 全家桶、recharts 3.8、@tanstack/react-table 8、lucide-react
- 移动端：Capacitor 8（Android 打包）
- 埋点：posthog-js
- 加密：tweetnacl / tweetnacl-util + 原生 WebCrypto
- TypeScript：基本缺失，全仓库仅 1 个.ts，无 tsconfig、无类型检查
- Lint：已有 ESLint 9 flat config，但 ignores 排除 scripts/**，no-unused-vars 仅 warn
- 格式化：已有 Prettier，但 format 只覆盖 src
- 测试：原生 node --test；Playwright（含 Pixel 7 视觉回归，阈值 0.02）
- CI：无。.github/workflows 已被整体删除

### 值得肯定的既有工程化

**自研架构护栏 scripts/check_refactor_guard.mjs**：接在 npm run build 之前，包含必需模块清单、行数预算和「禁止旧实现回流」的正则。实测运行：Refactor guard passed.

**回测内核已做过良性拆分**：src/app/backtest/ 下 core/ + engines/ 分层清晰，共 1,486 行。实测 test/backtest-engine.test.mjs：22 条测试全部通过。

**FIFO 成本结转正确**：通过分段四舍五入实现守恒，多场景验证差额为 0。重构时不可直接换库，必须先用测试锁死现有行为。

## 问题诊断（按严重程度分级）

### 阻塞级

**B1 · A 股交易日历存在 4 份独立实现，且已发生数据漂移**

| # | 位置 | 覆盖年份 |
|---|------|----------|
| ① | src/app/holidaysCN.js:16 HOLIDAY_RANGES | 2024 / 2025 / 2026 |
| ② | workers/notify/src/holdingsNavSupport.js:48 内联 rangesByYear | 仅 2025 / 2026 —— 缺 2024 |
| ③ | services/market-collector/market_collector/calendar_cn.py:9 | 2024 / 2025 / 2026 |
| ④ | 独立仓库 fund_collector/market_collector/calendar_cn.py | 2024 / 2025 / 2026，但已与 ai-dca 内副本 diff 不一致 |

为何是阻塞级：节假日判断直接喂给 NAV 滞后判定、推送触发条件、回测跳空处理三条关键链路。两年期溢价回测依赖 2024 假期数据，而 notify worker 恰好缺这一年，前端与 worker 在 2024 区间会算出不同结果。

**B2 · round() 有 18+ 份独立实现，语义已不一致**

18 处重复定义，两种语义已分歧：
- A 类（无 EPSILON，占多数）：`Math.round((Number(value) || 0) * factor) / factor`，round(1.005)=1
- B 类（backtest/core/math.js，带 EPSILON）：先查有限性再加 EPSILON 补偿，round(1.005)=1.01，Infinity→0

后果：同一笔金额在回测页与持仓页可能落到不同的分位。默认精度也不统一（多数 2 位，costTracker 与 marketsHoldingsSnapshot 为 4 位）。项目没有引入任何 Decimal 库。

反面证据：FIFO 成本结转目前是正确的（实测守恒），重构时必须先用测试锁死现有每个输出数字，绝不可直接换 Decimal 库。

**B3 · 凭据文件已入库；设备密钥与 token 明文存 localStorage**

① 根目录存在.internal_sync_token（65 字节），且.gitignore 中搜不到该文件名 → 已进入版本库。
② 「记住本设备」把原始数据密钥明文写入 localStorage（src/app/secureVault.js:396，key 名 aiDcaSecureSyncRememberedKey）。
③ saveCloudSession() 把 accessToken 写入 localStorage（src/app/authSession.js:35）。

处置建议：立即轮换.internal_sync_token；git rm --cached + 写入.gitignore，改走 wrangler secret / 环境变量；历史清理需 git filter-repo（改写历史，需单独确认）；中期令牌改用 httpOnly cookie，「记住本设备」改用不可导出的 WebCrypto CryptoKey 存 IndexedDB。

**B4 · 无 CI，所有质量门禁靠人工**

.github/workflows 已被整体删除（commit 06363f1d）。159 个测试文件、ESLint、Prettier、架构护栏、Playwright 全部不会自动运行。在一周约 30 次提交的节奏下极其危险。这是所有其它重构的前置条件。

### 高

**H1 · 单文件过大 + 状态爆炸**：51 个文件超 500 行。BacktestSidePanel.jsx 2,059 行且不在护栏预算内；MarketsExperience.jsx 1,377 行 / 51 useState / 24 useEffect。

**H2 · 架构护栏覆盖不全**：5 个文件只差 1～4 行就撞上限（HoldingsExperience 1299/1300 等）；20 个超 700 行文件完全不在预算内。

**H3 · 数据访问层缺统一抽象**：localStorage 238 处/66 文件无门面；fetch 37 处/20 文件存在直连旁路；D1/SQLite/localStorage/WebDAV 四套读写路径并存；14 个 sync 模块并存，syncMerge.js 无直接测试。

**H4 · 错误处理静默化**：534 处 catch 中 81 处空 catch；src/app 下无 logger 模块，全靠 99 处裸 console.*。

### 中

**M1 · 多部署目标配置分叉**：三套产物目录；api.freebacktrack.tech 硬编码散落 18 个文件；DEFAULT_SITE_ORIGIN_CN 带端口硬编码。

**M2 · 策略阈值与魔法数字散落**：加仓阈值、切换规则阈值、TTL 等散在各模块。

**M3 · 基金品种判定逻辑分散**：QDII/LOF/OTC/场内判定散在 14+ 文件，worker 侧是异步版本，行为边界不同。

**M4 · 命名与现实脱节**：package.json name 仍是 us-stock-strategy；美股遗留模块与 CN 功能并存。

### 低

**L1**：Lint/format 覆盖不全（workers/services/scripts 在检查之外）。
**L2**：无 TypeScript / 类型检查。
**L3**：文档堆在仓库根目录，docs/ 只有 1 个文件。
**L4**：测试目录扁平含临时文件。

## 目标架构

设计前提：在现有 src/app 基础上渐进分层。把 src/app 混合层剖成 domain（纯计算）与 infra（所有 IO），四类重复真源收敛为唯一来源。

```
src/
domain/ # 纯函数业务核心：零 IO、零 window、可直接 node --test
money/ # 统一精度：money.js —— 唯一 round 入口
calendar/ # 统一交易日历：tradingCalendar.js —— 唯一真源
holdings/ # 持仓台账聚合
backtest/ # 已有良好结构，整体平移
strategy/ # DCA / 轮动 / 卖出策略 + 阈值集中配置
fund/ # 品种判定唯一入口
infra/ # 所有 IO 收口
storage/ # localStorage 唯一出入口 + key 注册表
http/ # apiUrl + fetch 封装 + 统一重试/超时
sync/ # 14 个 sync 模块收敛为 repository + mergeStrategy
crypto/ # secureVault
logger/ # 统一日志 + 错误上报
events/ # 事件名常量 + 类型化发布订阅
features/ # 按业务域组织 UI
holdings/ markets/ backtest/ notify/ switch/ plan/
components/ui/ # 纯展示组件（保留现有 Radix 封装）
shared/ # 前端与 workers 共享真源，构建期注入
tradingCalendar/ # 假期区间 JSON + 读取器
money/ # 精度规则
fundKind/ # 品种判定规则
```

禁止的依赖（可由 check_refactor_guard.mjs 强制）：
- domain → infra
- features → infra/storage
- features → infra/sync

## 分阶段路线图

核心策略：先补测试再动刀，每阶段可独立合并上线。

### 阶段 0 · 恢复安全网（0.5–1 人天，风险极低）
- 恢复最小 CI（GitHub Actions，PR 触发：check_refactor_guard + test:unit + lint）
-.internal_sync_token 移出索引并轮换
- lint/format 脚本扩到 workers、services、scripts
- 验证：故意推超预算改动确认 CI 变红
- 分支协调：不碰业务代码，零冲突，必须第一个做

### 阶段 1 · 交易日历唯一真源（1–1.5 人天，风险中）
- 建 shared/tradingCalendar/，假期区间 JSON + JS 读取器
- 先补「4 份实现一致性测试」，再替换调用方
- Python 侧由同一 JSON 生成
- 注意：给 worker 补 2024 年数据是行为变更，需先确认是修 bug 还是保持现状
- 验证：一致性测试全绿 + backtest-engine 22 条全绿 + 全年日期快照对比

### 阶段 2 · 金额精度唯一入口（1.5–2 人天，风险中高）
- 先给现有行为补「金额快照测试」锁住每个输出数字
- 建 domain/money/money.js 作为唯一 round 入口
- 逐个替换 18+ 份本地 round，只统一实现不改语义
- 语义差异（EPSILON、Infinity）单独 PR 并记录预期变化
- 本阶段不引入 Decimal
- 验证：金额快照逐值比对；holdingsLedgerCore 相关测试全绿

### 阶段 3 · 存储层与事件总线收口（2–3 人天，风险中低）
- 建 infra/storage/ 唯一门面 + 59 个 key 注册表
- 建 infra/events/ 事件名常量（16 种）
- 从外围文件开始逐 PR 替换（每 PR 约 10 个文件）
- 门面层加「未注册 key 抛错」开发期断言；迁移期保留读旧 key 兼容
- 验证：storage 门面单测 + Playwright e2e + 手工验证云端恢复链路

### 阶段 4 · 拆解超大文件 + 扩展护栏（3–5 人天，风险中）
- 把 20 个超 700 行文件纳入护栏预算
- 按优先级拆分：BacktestSidePanel.jsx → MarketsExperience.jsx → aggregateByCode → fetchers.js
- 把 5 个贴上限文件的预算下调
- 验证：拆前后 Playwright 视觉回归 diff 在阈值内；guard 通过

### 阶段 5 · 数据访问层统一 + 可选类型化（5–8 人天，风险中高）
- 14 个 sync 模块收敛为 repository 模式
- 补 syncMerge.js 直接测试并完成门面脱离
- 统一错误处理 + infra/logger/，清 81 处空 catch
- 评估 tsconfig + checkJs / JSDoc 类型化（先 domain/）
- 评估是否引入 Decimal
- 验证：syncMerge 直接单测 + cloudSyncConflict 全绿 + 多设备手工对账

## Quick Wins（前 5 件，每件 1–2 小时，风险低）

1. **.internal_sync_token 移出索引并轮换**（30 分钟）：git rm --cached +.gitignore + 云端轮换，改走环境变量/wrangler secret。
2. **给 notify worker 假期表补 2024 年**（30 分钟）：照抄前端 holidaysCN.js 的 2024 七段区间。注意这是行为变更，需确认。
3. **恢复最小 CI**（1 小时）：.github/workflows/ci.yml 跑 guard + test:unit + lint。
4. **lint/format 扩到 workers 与 scripts**（1 小时）：先设宽松 --max-warnings，只卡 error。
5. **加最小 logger 并消最危险的 4 处空 catch**（1.5 小时）：CnHomeExperience.jsx:31、NotifyEventDetailDialog.jsx:72、DataRepairExperience.jsx:43/:144。

这 5 件都不碰业务逻辑，与在飞分支零冲突，可随时插入执行。

---
报告基于 commit 91bff4ba（2026-10-09）快照。本次仅做分析，未修改仓库内容。
