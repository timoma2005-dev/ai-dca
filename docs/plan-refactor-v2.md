# ai-dca cn 分支重构详细计划 v2

> 编写日期：2026-10-11，UTC。
> 当前规划基线：`cn`，`3c02056ae3ff9463e6574fd9267034659507dbe3`。
> 分析报告基线：`91bff4ba3e8c6766b9b57ed1ecfe68486cc8f267`。
> 状态：待实施的计划。本次交付只新增本文档，没有修改源码、配置或凭据，没有创建分支、提交、PR，也没有执行轮换、部署或通知操作。
> 本文所有修改片段、命令和新文件均为后续实施说明。出现的凭据名称只是标识符，全文不包含实际密钥值。

## 1. 计划定位与当前依据

### 1.1 与旧计划的关系

本计划继承 [plan-refactor.md](plan-refactor.md) 的生产边界、行为保持原则、测试流程和回滚约束，替代它尚未实施的阶段 1 至 7 的执行顺序。旧计划继续作为运行边界和历史分析的参考，本文不移动或修改它。

用户已确认旧阶段 0“冻结基线”完成，其成果直接作为输入。v2 阶段 0“恢复安全网”属于新增工程任务，包含凭据止血、CI 恢复、检查覆盖和日志入口，不能把旧阶段 0 的完成状态理解为这些工作也已完成。

对应关系如下。

| 旧计划内容 | v2 的处理位置 |
| --- | --- |
| 阶段 0：冻结基线 | 继承；仅核对后续 PR 相对冻结提交的增量 |
| 阶段 1：检查入口、文档和脚本整理 | 检查入口进入 v2 阶段 0；文档大规模归档另行安排 |
| 阶段 2：遗留清理 | 只在 v2 阶段 4 清理被拆模块中已证明无消费者的代码；不统一删除旧页面 |
| 阶段 3：纯函数、常量去重 | 日历、金额分别进入 v2 阶段 1、2；`mapLimit`、纯预设在阶段 4、5 按消费者迁移 |
| 阶段 4：前端拆分 | v2 阶段 4 |
| 阶段 5、6：计算与行情适配器拆分 | v2 阶段 2、4、5 |
| 阶段 7：sync、notify 内部拆分 | 前端同步职责进入 v2 阶段 5；服务端投递、认证和存储迁移继续排除，纯叶子函数抽取单独审查 |

旧计划“不恢复已删除 workflows”的限制，在 v2 中只对最小质量检查 CI 作明确调整。Q3 给出待实施内容，它不恢复发布流水线、部署 secret、定时任务或自动上线。用户当前授权范围仍只有编写计划。

### 1.2 为什么需要 v2

[第三方分析报告](refactor-analysis-2026-10-10.md) 发现了直接影响数据结果的问题：notify 日历缺 2024 年，金额舍入在跨模块计算中出现分位差异。凭据入库和 CI 缺失又降低了修复时的安全保障。执行顺序因此调整为：恢复安全网，确认数据口径，锁定输出，再进行存储、页面和数据访问职责重构。

报告中的目录组织建议作为方向，实施优先保留已有 façade、`src/app` 和 `src/pages/markets` 边界。不整体搬迁到 `features/`，不引入第二套行情缓存或同步注册表。

### 1.3 本次核对结果与报告差异

四份指定输入已完整阅读：分析报告、旧计划、[AGENTS.md](../AGENTS.md)、[架构护栏](../scripts/check_refactor_guard.mjs)。下述代码定位来自当前规划基线，后续修改前用函数名重新定位，行号只用于定位当前版本。

| 项目 | 当前证据 | 对计划的影响 |
| --- | --- | --- |
| 分支 | 用户已清理，仅保留 `main`、`cn`；当前 `cn` 相对 `origin/cn` ahead 5 | 不再把报告提到的两个落后 633 次提交的功能分支作为前置阻断；不操作 `main` |
| 日历 | `src/app/holidaysCN.js:17` 有 2024；`workers/notify/src/holdingsNavSupport.js:53` 从 2025 开始 | Q2 仍适用；需经过 B1 行为决策 |
| 舍入 | 除 EPSILON 差异，还有严格数值判断、无效值返回 `null`、空值处理和默认精度差异 | 阶段 2 至少保留七种明确策略，不能用一个默认公式直接替换全部调用 |
| 凭据 | `git ls-files --error-unmatch .internal_sync_token` 成功；只检查路径，没有读取内容 | Q1 必须覆盖 Worker 接收端和本地 outbox 发送端 |
| Worker 入口 | notify：`src/accountEntry.js`；sync：`src/optimizedEntry.js`；account：`src/entry.js` | 测试、打包和发布核对实际入口，保留 wrapper 与 fallback |
| Node 检查 | 当前 `npm run test:unit` 在 Node `v24.20.0` 下报 `Cannot find module .../test` | Q3 前修正测试文件发现方式，不能直接使用当前脚本宣称测试已运行 |
| 完整 Node 集合 | 发现 158 个 `.test.mjs`，含 `test/returns`、三个 Worker 的 test 和本地 auth；显式运行 917 项，875 通过，42 失败 | 与报告的统计口径不同；阶段 0 先分类实际失败，不沿用旧计划的“11 项失败” |
| 前端 lint | ESLint JSON 诊断：12 个 error、203 个 warning | Q5 能处理四处空 catch；其余错误另做等价修正或独立 Bug 前置任务 |
| 架构护栏 | `npm run check:refactor` 通过 | 通过只证明现有预算、文件和正则规则满足 |
| 视觉检查 | `app-visual.spec.js` 调用 `page.screenshot`，没有 `toHaveScreenshot` 对比断言 | 阶段 4 补实际图像断言；配置中 0.02 阈值目前不足以证明视觉一致 |
| 外部采集器 | 本工作区未找到独立 `fund_collector` checkout | 可设计第四实现的导出契约；不能宣称已经完成四方一致性验证 |

完整 Node 基线的失败涉及账户资源同步、通知账户隔离、通知配置、静态页面约束、雷达等。`test/marketsWatchData.test.mjs` 中“可用 quote 不请求 OTC NAV 快照”也失败。它属于 AGENTS 请求边界要求，相关调度抽取必须等待独立纠偏。本文不根据失败名称自行判断应修改实现还是测试。

## 2. 风险红线与行为决策

### 2.1 绝对冻结的生产契约

下表中的内容不能在行为保持重构 PR 中修改。发现只有改变这些内容才能继续时，停止受影响步骤，提交独立 Bug 或迁移方案；其余可独立工作继续。

| 冻结项 | 具体边界 |
| --- | --- |
| 数据源 | 腾讯、雪球、东财、蛋卷、NAV 和价格来源、来源优先级、fallback 顺序、header/cookie/解码方式；不把 notify 切到 collector `/api/mc`，不修改 `FORCE_COLLECT` |
| 通知路径 | 账户和设备兼容分派、Bark、Server酱、邮件、WS、PC outbox、cron、queue、ack/retry、claim、去重和每日上限；`queued` 与 `delivered` 保持区别 |
| 缓存 | KV/R2/localStorage/IndexedDB key、prefix、version、TTL、source 接受规则、stale 口径、live 写回顺序；不清 KV、不扫 R2、不回填或迁移生产数据 |
| API | URL、method、路由顺序、参数、响应字段、状态码、错误文案、CORS、legacy 路由、重定向和 410 行为；不换域名或 base override 优先级 |
| 运行入口 | 各 `wrangler.toml` 的 `main`、bindings、数据库路径、cron、queue 和 compatibility 设置；实际入口表见 2.2 |
| 认证语义 | 账户/设备身份、Bearer 校验、恒定时间比较、session 期限、传播重试、权限名单、登出清理、cookie/CORS、加密算法和密文格式 |
| 业务结果 | FIFO 舍入位置、手续费、收益公式、基金分类、QDII 日期对齐、交易时段、阈值、默认参数，以及 `null`、`0`、空串和缺失字段的区别 |
| 产品表现 | UI、文案、深链接、hash、表格列 ID/排序/作用域、组件挂载身份、浮层关闭和移动导航行为 |

允许进入专门修复流程的例外只有明确说明的 Q1 凭据轮换、B1 日历修复、B2 舍入口径修复，以及已批准的基线 Bug。例外不得扩大到认证架构、缓存迁移或通知渠道切换。

B3 中 `secureVault.js:398` 的记住设备原始密钥、`authSession.js:35` 的 accessToken 持久化风险继续登记。httpOnly cookie、不可导出 CryptoKey、IndexedDB 密钥迁移会影响认证和恢复流程，排除于六阶段重构。Q1 完成只能关闭“内部同步凭据入库及有效旧凭据”这一子问题，不能宣布 B3 全部解决。

工程组织约束也沿用旧计划：根目录通用 Markdown 仅保留 `README.md`、`CLAUDE.md`、`AGENTS.md`；新单测放 `test/`，检查和生成脚本放 `scripts/`；本次文档路径遵从用户明确指定。保留 `public/` 与 `docs/` 静态资源的发布复制关系，不依据静态无引用删除 legacy 页面、动态 skill 或其他运行入口。不做整库重写、全量格式化、全仓 TS，不升级 React、Vite、Node、Wrangler 或状态库，不合并覆盖 main/cn 的不同生产实现。

### 2.2 实际 Worker 入口清单

| 配置 | 必须保留的 main |
| --- | --- |
| `workers/account/wrangler.toml` | `src/entry.js` |
| `workers/markets/wrangler.toml` | `src/index.js` |
| `workers/notify/wrangler.toml` | `src/accountEntry.js` |
| `workers/sync/wrangler.toml` | `src/optimizedEntry.js` |
| `workers/ocr-proxy/wrangler.toml` | `src/index.js` |
| `workers/markets-agent/wrangler.toml` | `src/index.ts` |
| `workers/apex-redirect/wrangler.toml` | `src/index.js` |

`services/auth`、`services/market-collector` 和 Container 有独立运行、安装和打包边界。根 Vite build 不代表它们已经通过；日历和金额共享不能引用镜像中不存在的仓库路径。

### 2.3 AGENTS 约束落地为验收断言

1. 列表仅调用 `/quotes`、正在展示的增强接口和缓存小元数据。未选详情时 K 线、NAV 历史、财务、雪球 raw detail、AI summary 请求数均为 0；隐藏列增强请求数为 0。
2. 请求范围继续由 `useVisibleMarketSymbols`、可见行和 active list 决定。增强先读组件 inflight/memory，再读 localStorage 缓存，只请求缺失集；相同 render 周期有 inflight、abort、去重或缓存保护。
3. 缓存保持组件缓存、localStorage 列表增强、Worker KV 小对象、详情按需 R2、源站的优先级。列表不通过 R2 大对象推导字段；派生高点使用 `kline-high:<market>:<symbol>:1d` 小对象。
4. 单/批 quote 复用现有 `quote:<code>` key 和短 TTL。CN 场内高点只使用 1d K 线派生的 `highPoint` / `yearHigh`；缺失显示既有空值占位符，不用 `high52w`、`highest` 兜底；`/quotes` 不带 candles。
5. OTC 有可用 quote 时 `getNavSnapshots` 调用为 0；只对 quote 缺失或无价格的缺失集兜底。限额只在场外列表展示时请求，ETF、指数、美股调用为 0。
6. 外部请求保留数量和并发上限，优先 `mapLimit`；live fetch 成功写回原 KV/R2 key。缓存验证覆盖 source、时间和形态；涉及验证策略变更先独立确认 Bug 口径。
7. `forceRefresh` / `forceLive` 仅由明确刷新入口传入。无数据源模块前端本地短路，无消费 props/state/effect/刷新链删除，禁止保留后台预取。
8. `MarketsExperience` 保持调度职责。重逻辑放 `src/pages/markets/*` 或 `src/app/*`，不使用新的巨型 hook 吸收全部状态。
9. 底部 Dialog/Sheet 打开、关闭、卸载分别正确调用 `setMobileBottomSheetOpen(source, true/false)`，使用 `src/app/mobileBottomSheet.js`。保留现有 `useClickOutside` 和 Radix 行为。
10. 每个步骤运行相关 Node、guard、quiet lint 和 diff check。请求修复补“不会调用”；缓存修改补 hit、expired、source mismatch、坏形态、错误写入 key；列表字段修改补缺缓存空值。

### 2.4 B1、B2 的决策门

实施前由 dudu 在对应 PR 中记录下表选择、影响范围、预期输出和回滚方式。编写本文不代表这些行为改变已获批准。

| 问题 | 保持现状的路径 | 修 Bug 的路径 |
| --- | --- | --- |
| B1 日历 | 共用同一假期数据；notify adapter 显式保留 `supportedYears: ['2025', '2026']` 的历史覆盖；2024 差异登记为未关闭 Bug | 先执行独立 Q2 修复 PR，再以修复后快照完成阶段 1；全年一致性测试覆盖 2024 至 2026 |
| B2 舍入 | 阶段 2 默认执行此路径：单一实现入口，调用者显式选择原策略、原默认精度，逐值输出一致 | 独立于阶段 2 的后续 Bug PR，说明 EPSILON、负半值、Infinity、无效值和默认位数的目标语义；先新增目标断言，再变更业务口径 |

未取得选择时，不执行 Q2，也不把非 EPSILON 调用自动改成 EPSILON。B1 若选择保留覆盖差异，阶段 1 可以完成内部结构收口，B1 数据正确性问题仍保持开放。B2 阶段 2 完成也不等于金额口径已经统一。

不引入 Decimal。后续可以做脱离生产的输入输出评估，采用 Decimal、重算历史金额或回填用户账本都需要单独方案。

## 3. 共同执行、测试与合并规则

### 3.1 PR 和发布规则

六个阶段各有独立、面向 `cn` 的主 PR，命名建议见阶段说明。PR 内按步骤形成可回退提交，不把后续阶段混进当前阶段。Q2 和 B2 的行为修复使用独立 Bug PR，Q1、Q3、Q4、Q5 属于阶段 0 的提交组。

后续实施采用 Codex 计划、Codely 实现、diff 审查、测试、必要构建/浏览器检查、已确认发布机制、fast 验收的流程。本文不执行这些操作，也不创建任何分支。每个未来工作分支从当时已通过检查的 `cn` 建立；需要前序模块的阶段等待它合并，不让未合并分支成为运行依赖。

一次阶段 PR 可以同时保留旧路径 re-export 和新实现，使上一版本消费者仍可工作。跨入口变更分别构建、分别发布；前端、markets、OCR、本地采集器、notify 按受影响入口推进，通知最后。不要求六阶段一起部署。

上线使用旧阶段 0 已冻结的发布入口，不自行执行 `publish:*`、部署脚本、`wrangler deploy` 或真实通知。验收站为 `https://fast.freebacktrack.tech`；主站/API 只读对照依冻结运行清单处理。留存提交 SHA、检查结果、脱敏请求证据、旧产物或 Worker Version ID。

### 3.2 每个步骤必须追加的命令

相关测试命令列在每阶段表中；随后统一执行以下四条，本文后续称为“共同门禁”。

```bash
npm run test:unit
npm run check:refactor
npm run lint -- --quiet
git diff --check
```

Q3 实施前，完整 Node 命令使用当前真实文件集合的显式匹配。

```bash
node --test test/*.test.mjs test/returns/*.test.mjs workers/*/test/*.test.mjs services/auth/test/*.test.mjs
```

Q3 将 `test:unit` 修正为同一集合。新增测试统一位于 `test/`，命名 `.test.mjs`；沿用已有 Worker/auth test 路径，避免本轮搬动整个测试目录。Python 原有测试保留在子项目；新增跨语言日历验证用 Node 调用 Python，不新建 `tests/`。

前端改动追加以下命令；E2E 使用本地、固定夹具和隔离浏览器，不连接真实账户写入。

```bash
npm run build:app
npm run test:e2e:smoke
```

测试不得使用 `skip`、删除断言、把所有未知 API 变成 `{}` 200、扩大权限或接受重复投递来换取绿色。基线红灯先分类为测试环境缺失、失效的静态组织约束、真实契约 Bug；真正需要改变行为的修复单独提出预期。相关模块基线未全绿时停止该模块的重构和上线。

### 3.3 Worker 的本地打包验证

根包没有锁定 Wrangler。当前可复用的锁位于 `workers/markets-agent/package-lock.json`，其中 Wrangler 是 `4.86.0`。后续先与冻结运行工具版本核对，使用已批准的版本，不能由裸 `npx wrangler` 自动安装最新版。

若冻结清单确认使用该锁版本，实施环境准备与一次受影响 Worker 的检查命令如下。

```bash
npm --prefix workers/markets-agent ci
REFACTOR_WRANGLER="$PWD/workers/markets-agent/node_modules/.bin/wrangler"
"$REFACTOR_WRANGLER" --version
REFACTOR_BUNDLE_DIR=$(mktemp -d /tmp/ai-dca-refactor-bundle.XXXXXX)
"$REFACTOR_WRANGLER" deploy --dry-run --config workers/notify/wrangler.toml --outdir "$REFACTOR_BUNDLE_DIR"
```

其他 Worker 替换为本表的对应 config；保留 dry-run 参数。Container 需要单独镜像测试，不能据仓库 import 成功认定镜像可运行。纯前端阶段不执行无关 Worker 打包。

### 3.4 架构护栏机制与收紧原则

当前脚本有 15 个基础必需文件、8 个由 `activationFile` 存在触发的阶段、9 个基础预算以及禁止旧实现回流的正则。激活阶段的预算与基础预算取较小值。行数通过 `text.split(/\r?\n/).length` 计算，末尾换行也计数。

五个临界文件当前有效行数为：Holdings `1300/1300`、SwitchStrategy `1100/1100`、NewPlan `650/650`、markets Worker index `850/850`、Notify `877/880`。不使用 `wc -l` 的差一行结果调整预算。

不得删除 activationFile、调高已有预算、压缩排版或把大文件体积转移到一个新 hook。只在抽取和验证完成的同一提交中收紧预算。shared/domain 不访问 DOM、localStorage、fetch 或 env binding；UI 通过已有 app façade 访问存储和同步，不新增绕过 façade 的 import。

## 4. 六阶段实施计划

### 阶段 0：恢复安全网、凭据止血与最小日志

**目标**：恢复能发现全部 Node 测试的 CI，扩大 JS 检查范围，移出并轮换内部同步 token，建立不会泄露私密数据的 logger。

**前置条件**：继承旧阶段 0 冻结清单；核实 cn 的 ahead 5 提交属于本轮基线；分类当前 42 项 Node 失败和 12 个前端 lint error。生产轮换前确认 sync Worker 所有者、本地 auth-sync 运行管理器、版本与在途 outbox 处理方式。

| 步骤 | 先补测试，再改哪些代码 | 验证命令 |
| --- | --- | --- |
| 0.1 测试发现与错误分类 | 对比 `rg --files` 的 `.test.mjs` 集合和实际运行集合；修正 `package.json` 的 `test:unit`，显式加入 notify、auth、returns。复现 `test/accountResourceSync.test.mjs`、`test/syncRegistry.test.mjs` 的模块加载失败，先核实导出契约；不直接添加同名空导出 | `node --test test/accountResourceSync.test.mjs test/syncRegistry.test.mjs`；完整显式 Node 命令；共同门禁 |
| 0.2 凭据止血 | 复用 `workers/sync/test/auth-sync.test.mjs`、`services/auth/test/outbox.test.mjs` 锁定无 token 503、错误 token 401、正确 token、幂等、事件冲突和 session 不延期。执行 Q1；修改 `.gitignore`、索引与 `scripts/deploy-auth-manual.sh` 的凭据注入方式；保留 `handleInternalAuthSync()`、`internalToken()`、`processOnce()` 语义 | `node --test workers/sync/test/auth-sync.test.mjs services/auth/test/outbox.test.mjs services/auth/test/auth.test.mjs`；`bash -n scripts/deploy-auth-manual.sh`；Q1 路径检查；共同门禁 |
| 0.3 最小 logger | 新建 `test/logger.test.mjs` 和隔离 E2E `test/e2e/logger-fallback.spec.js`；先锁定配额/JSON/剪贴板错误下的原返回、乐观 copied 状态和请求数，再执行 Q5。新增 `src/app/logger.js`，只改指定四处 catch | `node --test test/logger.test.mjs test/holdingsDataRepairAndSmartPaste.test.mjs test/cnHomeSeriesHeader.test.mjs`；本地 build；`npx playwright test test/e2e/logger-fallback.spec.js --project=chromium`；共同门禁 |
| 0.4 lint 扩面 | 先运行 Q4 的配置诊断，按文件分类新增 error；更新 `eslint.config.js` 和 `package.json`，不批量 `--fix`。对等价删除转义、冗余 global 声明、纯 handler 改名先补已有契约断言 | Q4 命令；`node --test test/sourceSiteMigrationOption.test.mjs test/accountDataMigrationNotice.test.mjs`；共同门禁 |
| 0.5 恢复 CI | `test:unit` 与 lint 已可运行后按 Q3 添加 `.github/workflows/ci.yml`；先本地运行同一门禁，再用可回退的超预算试验验证 guard 拒绝；CI 不含发布和生产凭据 | Q3 命令；共同门禁；未来 PR 的 `quality` job 检查成功 |

已定位的 lint 错误具体处理顺序：Q5 消除四处 `no-empty`；`NewPlanSelectionCards.jsx:154` 改为 JSX 字符串表达式，显示文本不变；`account-data-migration-modal.jsx:195/399` 的 `useSourceSite()` 是普通点击处理函数，核实后改名 `handleUseSourceSite()`，回调与跳转语义不变。`networkTrace.js:176/182/186/193/197` 的 `isCnHost`、`currentHost` 未定义属于潜在运行 Bug，先新增 `test/networkTrace.test.mjs` 再决定修复口径，不能把两个名字登记成 globals 来隐藏错误。

扩面还会发现 `workers/account/src/index.js:512` 的重复 `resource` key、`workers/markets/src/index.js` 的未定义引用，以及 Worker/脚本空 catch 和冗余 global 声明。重复 key 当前由最后一个值生效，删前一个字段需锁定实际 409 响应。真正未定义的引用和 42 项基线行为失败单独修复；此阶段不承诺全部能在报告的 1 人天内解决。

**回滚**：CI、lint、logger 提交可分别 revert。凭据移除和轮换保持生效，不能回退到泄露的旧 token，也不能重新跟踪该文件；如回退其他阶段 0 提交，继续应用凭据止血提交。本地同步恢复只使用当前有效的新凭据，不清 outbox 或死信。

**工作量**：安全网与日志 1 至 2 人天；现有真实 Bug 分类和修复单独估算，未完成时阶段 0 门禁保持阻断。

**分支/合并**：未来 `refactor/cn-v2-0-safety`，独立 PR 到 `cn`；五个步骤分别提交。先完成 Q1 的受控轮换，再合并不含部署的 CI。该 PR 全绿后其他阶段开始；无需发布整个应用才能启用 CI。

### 阶段 1：交易日历单一数据来源

**目标**：仓库内 JS/Python 使用同一份假期数据；保留不同运行时的日期解析和交易时段 adapter；通过 B1 决策处理 notify 的 2024 缺失。

**前置条件**：阶段 0 全绿；B1 选择已记录。若选择修 Bug，独立 Q2 已合并并取得修复后基线；独立 fund_collector 的维护者、代码版本和部署范围已经核实，不能由本仓库 PR 自动更改外部运行环境。

| 步骤 | 先补测试，再改哪些文件和函数 | 验证命令 |
| --- | --- | --- |
| 1.1 固定旧结果 | 新增 `test/tradingCalendarParity.test.mjs`，固定 2024 至 2026 共 1096 天的 holiday/trading-day/前后交易日/NAV 预期快照；修复前明确记录 notify 的 2024 已知差异。覆盖周末调休仍休市、闰日、跨年、30 天回溯、60 天 gap 限制、格式错误和空输入；不通过 JSON 丢弃特殊返回值 | `node --test test/tradingCalendarParity.test.mjs workers/notify/test/tradingCalendar.test.mjs test/backtestGapOptimization.test.mjs test/holdingsTodayProfit.test.mjs`；共同门禁 |
| 1.2 提取数据与 JS 读取器 | 新增 `shared/tradingCalendar/holidays-cn.json`，内容逐项复制前端现表，不新增年份、不更改 2025/2026；新增 `shared/tradingCalendar/tradingCalendar.js` 的 `isChinaMarketHoliday()`、`isWeekendShanghai()`、`isTradingDayShanghai()`、前后/最近交易日和 `countHolidayWorkdaysBetween()`。先搬原函数，不强化日期合法性规则 | `node --test test/tradingCalendarParity.test.mjs test/incomeDateUtils.test.mjs test/transactionDraftState.test.mjs`；共同门禁 |
| 1.3 替换 JS 消费者 | `src/app/holidaysCN.js` 保留原导出 façade；`workers/notify/src/holdingsNavSupport.js` 改用共享函数，保留 `getExpectedLatestNavDate()`、`getShanghaiDateParts()` 等 adapter。检查 `holdingsLedgerBasics.getExpectedLatestNavDate()`、`fundPremiumNav`、`marketFundMetrics`、`transactionDraftState`、`incomeDateUtils`、两处 backtest `premiumPanel.js` 的消费链；不统一美股日历或交易时段 | `node --test test/tradingCalendarParity.test.mjs workers/notify/test/tradingCalendar.test.mjs test/backtest-engine.test.mjs test/backtestGapOptimization.test.mjs test/marketsFundMetrics.test.mjs test/holdingsLedgerCore.test.mjs`；前端 build；notify dry-run；共同门禁 |
| 1.4 生成 Python 数据 | 新增 `scripts/generate-trading-calendar.mjs` 的 `generatePythonCalendarData()` 和 `--check`；输出 `services/market-collector/market_collector/calendar_data_generated.py`，保留 Python 运行时自包含。`calendar_cn.py` 导入生成表，保留 `shanghai_datetime()`、`is_market_holiday()`、`is_trading_day()`、`quote_snapshot_cache_ttl()` 的签名和时段逻辑 | `node scripts/generate-trading-calendar.mjs --check`；`node --test test/tradingCalendarParity.test.mjs`；`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/market-collector python3 -m unittest discover -s services/market-collector/tests -p 'test_aggregates.py'`；共同门禁 |
| 1.5 第四实现对齐与防漂移 | 新增 `scripts/export-trading-calendar.mjs` 的 `exportCalendarContract()`，输出标准 JSON 和数据 SHA256；经独立任务授权后，在 fund_collector 的 `market_collector/calendar_cn.py` 使用同样生成表。`tradingCalendarParity` 通过 `FUND_COLLECTOR_ROOT` 调用其 Python，比较有效日期输出。CI 检查本仓库生成文件，外部流水线检查同一哈希 | `FUND_COLLECTOR_ROOT=/已核实的checkout node --test test/tradingCalendarParity.test.mjs`；`node scripts/generate-trading-calendar.mjs --check`；共同门禁 |

跨语言测试通过 Python subprocess 输出全年的 holiday/trading-day 数组；日期字符串限定为合法 `YYYY-MM-DD` 后比较，Python datetime adapter 自身保留原异常语义。外部 checkout 未提供时，仓库内三实现检查仍执行，输出“外部一致性未验收”；不得添加永久 skip 并宣称四方全绿。

JS 直接打包 JSON；Python 读取生成的本地模块，不依赖部署目录之外的 JSON。新 shared 文件需进入 Q4 lint 的匹配范围。生成器按确定性格式输出，`--check` 只比较，不写文件。

Python 生成表保持原 dict 和每段 tuple 形态。现有前端/Worker 日期格式检查、未知年份返回值、Intl 时区和 Python datetime 异常由各自 adapter 保持；原函数对无效日期的宽松行为不在此次抽取中纠正。

**回滚**：共享数据、读取器、生成文件及消费者作为一个提交组回退；Python 同时回退 import 和生成文件。独立 Q2 若已经批准并上线，保留修复或单独回退该 Bug PR，不在结构回滚时顺带删除 2024。外部采集器可回退自己的代码，无需切换数据源或重算缓存。

**工作量**：仓库内 1.5 至 2 人天；Q2 和外部部署协调另计。

**分支/合并**：未来 `refactor/cn-v2-1-calendar`，一个独立 PR 到 `cn`，先于前端/notify 生产发布保留全部旧导出。外部采集器使用其自身独立 PR；本仓库可以独立上线，但只有取得四方有效输出证据才关闭 B1 全部整改项。

### 阶段 2：金额精度单一入口，保留调用者策略

**目标**：消除运行中重复的 round 公式，集中政策实现，锁定每笔金额、份额、成本和收益输出；此次结构 PR 默认保持全部现行口径。

**前置条件**：阶段 0 全绿；阶段 1 的已确认日历基线可复用；B2 明确选择结构收口，语义修复另建 Bug PR。相关 holdings/backtest/quote 套件先通过。

当前策略清单如下，名字为拟新增的显式策略常量。

| 策略 | 原语义 | 当前消费者和默认精度 |
| --- | --- | --- |
| `COERCE_OR_ZERO` | 先 `Number(value)` 转换，falsy 值归 0；不加 EPSILON，Infinity 保留 | `accumulation.round`、`cashYield.round`、`demoData.round`、`fundSwitchCore.round`、`holdingsCore.round`、`holdingsLedgerBasics.round`、`marketIndices.round` 默认 2；`marketsHoldingsSnapshot.round` 默认 4；OCR `imageOcrRoutes.round` 默认 2；notify `getNav.roundNumber` 默认 2 |
| `STRICT_FINITE_ZERO` | 先 `Number.isFinite(value)`；字符串数值也返回 0 | `accountManager.round`、`clearedLotsAnalytics.round`、`dcaCalculator.round`、`positionManager.round` 默认 2；`costTracker.round` 默认 4 |
| `COERCE_EPSILON_ZERO` | Number 转换，无限/NaN 返回 0，有限值加 EPSILON | 前端与 notify `backtest/core/math.js:roundTo` 默认 2 |
| `COERCE_FINITE_NULL` | Number 转换，无效值返回 null，`null` 会转成 0 | markets `fetchers.round`、`newsFetchers.round`、notify `marketDataPush.roundNumber` 默认 4 |
| `NULLISH_FINITE_NULL` | 先拒绝 null/undefined，再 Number 转换 | markets `marketRuntime.roundNumber` 默认 4 |
| `EMPTY_FINITE_NULL` | 先拒绝 null/undefined/空串，再 Number 转换 | notify `nasdaqRadar.roundNumber` 默认 4 |
| `RAW_MULTIPLY` | 原始乘法，未设默认精度，不做有限性过滤 | Container `skills/fund-backtest/lib/stats.js:39` 的局部 round；保持镜像边界 |

这个表只覆盖已定位公式；实施前再次搜索 `round`、`roundTo`、`roundNumber` 和内联 `Math.round`，将新增发现加入矩阵。日期天数取整、UI 格式化和百分位取整不自动归入金额规则。

| 步骤 | 先补测试，再改哪些文件和函数 | 验证命令 |
| --- | --- | --- |
| 2.1 锁定金额快照 | 新增 `test/moneySnapshots.test.mjs` 与固定夹具 `test/fixtures/money-behavior.mjs`，保存 `aggregateByCode()`、`buildSoldLots()`、`calculateCostBasis()`、`buildMarketsHeldAggregates()`、`runBacktest()` 的完整数值结果。覆盖多批 FIFO、分次卖出、卖空截断、费用、待确认 OTC 买卖、同日排序、负有效成本和清仓尾差；夹具只用合成数据 | `node --test test/moneySnapshots.test.mjs test/holdingsLedgerCore.test.mjs test/costTracker.test.mjs test/cashYield.test.mjs test/clearedLotsAnalytics.test.mjs test/backtest-engine.test.mjs`；共同门禁 |
| 2.2 建唯一政策实现 | 新增 `shared/money/rounding.js` 的 `roundWithPolicy()`；新增 `src/domain/money/money.js` façade 和 `test/moneyPolicy.test.mjs`。上表七策略集中实现，precision 不增加新校验，Number 转换异常保留。测试 1.005、2.675、负半值、负零、数值字符串、null/undefined/空串、NaN、正负 Infinity、0/2/3/4 位与超大值 | `node --test test/moneyPolicy.test.mjs test/moneySnapshots.test.mjs`；共同门禁 |
| 2.3 替换前端公式 | 逐个替换上表 `src/app` 调用；公开 `round` / `roundTo` 继续导出原名和默认值。私有调用改为适用 policy 的绑定函数。`holdingsLedgerCore.consumeCostLots()` 中原有分段舍入时机不动，不能把每段舍入改为最终一次舍入 | `node --test test/moneySnapshots.test.mjs test/holdingsLedgerCore.test.mjs test/holdingsTransactionProcessing.test.mjs test/marketsHoldingsSnapshot.test.mjs test/costTracker.test.mjs test/positionManager.test.mjs test/accountAllocation.test.mjs test/backtest-engine.test.mjs`；前端 build；共同门禁 |
| 2.4 替换 Worker 公式 | markets、notify、OCR 直接依赖 `shared/money/rounding.js`，不依赖 React/app。先测试 quote/NAV/OCR 的 null 和 0 边界，再替换相应 round；notify backtest 副本不删除、不顺带替换不同算法 | `node --test test/moneyPolicy.test.mjs test/xueqiuQuote.test.mjs test/yahooMarketSummary.test.mjs test/notifyHoldingsContent.test.mjs test/holdingsOcrNavEnv.test.mjs workers/notify/test/nasdaqRadar.test.mjs`；三个受影响 Worker dry-run；共同门禁 |
| 2.5 处理独立镜像与防复制 | 新增 `scripts/generate-money-runtime.mjs` 的确定性生成与 `--check`，把同一政策文件生成到 `workers/markets-agent/container/lib/rounding.generated.js`；stats 改用 `RAW_MULTIPLY`，先补 `test/containerMoneyContract.test.mjs`。生成副本标记来源和哈希。护栏禁止上表已迁移文件重新定义金额 round | `node scripts/generate-money-runtime.mjs --check`；`node --test test/containerMoneyContract.test.mjs test/moneyPolicy.test.mjs test/moneySnapshots.test.mjs`；在隔离环境构建镜像并 import stats；共同门禁 |

快照比较使用 `assert.deepStrictEqual`、`Object.is` 和显式 NaN/Infinity 标记，不用 JSON stringify 把 Infinity 变成 null，也不用“误差小于一分钱”掩盖差异。FIFO 校验各段金额之和与原成本精确守恒，原 golden 不随迁移自动更新。

`roundWithPolicy(value, precision, policy)` 本身不设全局默认 precision，默认位数在各兼容 wrapper 中保持；`RAW_MULTIPLY` 收到 undefined precision 时继续保留原结果。护栏禁止公式回流，允许同名公开 wrapper 委托新入口，不用禁止所有 `function round` 的粗规则拦截兼容 API。

2.5 的镜像验证在生成检查和 Node 契约测试之后执行，命令如下；只 import 纯 stats，不启动服务或调用动态基金 skill。Dockerfile 与原 Node 22 镜像选择保持原样，基础镜像版本核对冻结记录。

```bash
REFACTOR_MONEY_IMAGE="ai-dca-refactor-money:$(git rev-parse --short HEAD)"
docker build -f workers/markets-agent/Dockerfile -t "$REFACTOR_MONEY_IMAGE" workers/markets-agent
docker run --rm -i --network none --entrypoint node "$REFACTOR_MONEY_IMAGE" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { computeStats } from './skills/fund-backtest/lib/stats.js';
assert.deepEqual(computeStats([1, 1, 1], '1d'), {
  cum_return: 0, ann_return: 0, vol: 0, max_dd: 0, sharpe: 0,
});
JS
```

**回滚**：每批消费者与其 façade 同组回退，保留前面已验证策略模块；完整阶段回退不涉及用户金额或存储迁移。任何数值差异停止该批替换，作为 B2 语义 Bug 证据处理。

**工作量**：2 至 3 人天，包含 Worker 和 Container 构建边界；B2 语义决策/修复另计。

**分支/合并**：未来 `refactor/cn-v2-2-money`，独立 PR 到 `cn`；前端、Worker、Container 消费者分提交，保留旧导出，允许各入口分别上线。B2 语义修复使用另外的 `fix/cn-money-policy` PR，不能混入本阶段。

### 阶段 3：存储门面与事件出口收口

**目标**：逐步集中浏览器持久化 IO、key 注册与同步事件分发；复用 `marketCacheKeys.js`、`syncRegistry.js`，保持已有用户数据和远端账户运行存储语义。

**前置条件**：阶段 0 全绿；当前账户的 `accountRuntimeStore`、remote read guard、holding journal、旧 key 读取与认证清理测试通过。报告的“59 个 key、16 种事件”仅作为盘点起点，实际数量由当前代码登记结果决定。

| 步骤 | 先补测试，再改哪些文件和函数 | 验证命令 |
| --- | --- | --- |
| 3.1 盘点并注册 | 检查全部 `localStorage`、`sessionStorage`、CustomEvent 和 `storage` 监听；新增 `src/infra/storage/storageKeyRegistry.js` 的 `resolveStorageKeyDescriptor()`，引用原 `marketCacheKeys` 和 `SYNC_REGISTRY`，登记 owner、静态 key/动态 prefix、格式、敏感标记和原 TTL。新增 `test/storageKeyRegistry.test.mjs`，覆盖 table scope、journal userId、日期动态 key、未知和空 key | `rg -n -e localStorage -e sessionStorage -e CustomEvent -e dispatchEvent -e addEventListener src`；`node --test test/storageKeyRegistry.test.mjs test/syncRegistry.test.mjs test/accountRemoteReadGuard.test.mjs`；共同门禁 |
| 3.2 原始 IO 门面 | 新增 `src/infra/storage/storageAccess.js` 的 `createStorageAccess()`、`getItem()`、`setItem()`、`removeItem()` 和 UI 使用的 `src/app/browserStorage.js` façade；依赖惰性 getter，不在 import 时取 window。先补 `test/storageAccess.test.mjs`：无 DOM、storage getter 抛错、QuotaExceededError、JSON 由调用者处理、字节/次数/异常保持。门面不统一吞错，caller 的 try/catch 和 fallback 保留 | `node --test test/storageAccess.test.mjs test/storageKeyRegistry.test.mjs test/groupMode.test.mjs`；共同门禁 |
| 3.3 外围 key 迁移 | 先替换 `groupModeStore.createGroupModeStore()`、`marketsWatchlistStorage.loadWatchlist/saveWatchlist()`、`src/pages/markets/MarketListTable.jsx` 的 `readJsonStorage/writeJsonStorage()`，再替换 `marketsWatchData.readOtcWatchCache/writeOtcWatchCache()` 和 `directMarketData` 的缓存 IO。UI 经 app façade 调用，不直接 import infra。JSON 形态、scope、默认列表版本、有效期和缺失集不变 | `node --test test/groupMode.test.mjs test/marketsWatchlistDefaults.test.mjs test/marketsWatchData.test.mjs test/marketsLayoutState.test.mjs test/directMarketData.test.mjs`；前端 build；`npx playwright test test/e2e/watchlist-otc-defaults.spec.js --project=chromium`；共同门禁 |
| 3.4 敏感存储 adapter | 用 `src/app/accountRuntimeStore.js` 的 `readAccountRuntimeStorageRaw/setAccountRuntimeStorageRaw()` 建业务存储 adapter；再接 `holdingsLedger.readLedgerState/persistLedgerState()`、`tradeLedger.readArray/writeArray()`、`resourceSync` 和 `holdingTransactionsSync` 的 storage 函数。登录账户内存态与游客持久态保持区别；`authSession`、`secureVault` 只经原 façade，不改持久化介质 | `node --test test/accountRemoteReadGuard.test.mjs test/accountResourceSync.test.mjs test/accountLoadingState.test.mjs test/holdingTransactionEventState.test.mjs test/holdingsTransactionRows.test.mjs test/secureVault.test.mjs test/authClient.test.mjs`；共同门禁 |
| 3.5 事件出口与守护 | 新增 `src/infra/events/eventNames.js`、`appEvents.js` 的 `emitAppEvent()`、`onAppEvent()`；保留 `BACKUP_APPLIED_EVENT`、`ACCOUNT_AUTH_OPEN_EVENT`、session/meta、holdings/resource 事件原名和 payload。先补 `test/appEvents.test.mjs`，测同步顺序、仅发一次、listener cleanup、StrictMode 重装；逐个替换原 dispatch，不引入广播跨标签的新行为 | `node --test test/appEvents.test.mjs test/holdingTransactionEventState.test.mjs test/notifyWsClient.test.mjs test/cloudSyncConflict.test.mjs`；前端 build 和 smoke；共同门禁 |
| 3.6 完成其余原始 IO 收口 | 按盘点批次接入 `plan.persistPlanStore/readPlanStore()`、`dca.persistDcaStore/readDcaStore()`、`accountManager.readAccountAllocationSettings/writeAccountAllocationSettings()`、`notifySync.readNotifyClientConfig/persistNotifyClientConfig()`、`switchStrategySync.readSwitchConfigCache/writeSwitchConfigCache()`、`cloudSync.loadCloudSyncMeta/saveCloudSyncMeta()`、`analytics.storageGetItem/storageSetItem/storageRemoveItem()`；其余页面和 app 调用按同一注册表逐项替换。只改原始 IO，不提前做阶段 5 的 merge/transport 拆分 | `node --test test/tradePlans.test.mjs test/accountAllocation.test.mjs test/notifySync.test.mjs test/switchStrategyConfigSync.test.mjs test/cloudSyncConflict.test.mjs test/analyticsPrivacy.test.mjs`；`rg -n -e localStorage -e sessionStorage src` 对照已审查 adapter 白名单；共同门禁 |

迁移以约 8 至 10 文件一个提交组执行，仍属于同一阶段 PR。未知 key 只在迁移清单完整后启用开发期断言；生产路径不因注册表遗漏新增异常。安全缓存写入 key 防御按现有合同测试，新增拒绝策略走独立 Bug。不新增读取所谓“新 key”再迁移旧数据的流程，注册表值保持原样。

列表请求边界 Bug 未关闭时只迁移等价原始 IO，不移动对应网络调度。原生跨标签 `storage` 事件、远端账户 read guard、auth/secureVault 介质访问保留明确白名单；无窗口初始化与现有异常策略由 caller 维持。

**回滚**：保留原 app 导出，每组替换可独立回退；存储 key 与序列化不变，旧版本直接读取原数据。不要删除 localStorage、IndexedDB 或 journal 来回滚。

**工作量**：3 至 4 人天；覆盖范围大于报告粗略 key 数时按提交组补估。

**分支/合并**：未来 `refactor/cn-v2-3-storage-events`，独立 PR 到 `cn`。默认先从阶段 2 已合并 cn 建分支，减少 holdings 冲突；若只做外围 storage，可与阶段 1/2 在不同文件上并行，合并前 rebase 后重跑完整门禁。

### 阶段 4：拆分超大模块并扩大护栏

**目标**：按回测侧栏、Markets 调度、持仓聚合、行情 provider 顺序拆分，再处理列表/详情和临界页面；给所有接收模块加预算，保持 UI、请求和数值行为。

**前置条件**：阶段 1、2、3 已合并；相关列表边界 Bug 已独立修复，尤其可用 OTC quote 多拉 NAV、列表读 R2 和详情级 OTC fallback。若某项未关闭，展示抽取可以独立进行，对应 effect/provider 调度保持停止。

| 步骤 | 先补测试，再改哪些文件和函数 | 验证命令 |
| --- | --- | --- |
| 4.1 护栏覆盖与真实视觉基线 | 新增 `test/refactorGuard.test.mjs`，验证缺 required、缺 activation 配套、超预算、禁止旧模式和新层依赖失败。扩展 `check_refactor_guard.mjs`，抽 `checkRefactorGuard({ root })` 供隔离目录测试；默认 root 不变。`app-visual.spec.js` 保留截图，追加 `expect(page).toHaveScreenshot()`，先在改 UI 前生成受审阅基线，固定时钟/数据/字体 | `node --test test/refactorGuard.test.mjs`；前端 build；`npx playwright test test/e2e/app-visual.spec.js --project=chromium --project=mobile-chrome`；共同门禁 |
| 4.2 回测侧栏 | `BacktestSidePanel.jsx` 的 `MetricCard()`、`SectionLabel()`、`DecimalInput()`、`GridMatrixModal()`、参数表单、结果、交易导出分别进入 `src/components/markets/backtest/*`；`deriveBacktestDateRange()`、`makeRotationResult()`、`pickBetterBacktest()`、`optimizePremiumSpread()` 进入该目录的纯 helper。运行 effect 保留唯一 sequence owner，展示先拆、effect 后移到 `useBacktestRun()`，原引擎与参数不动 | `node --test test/marketBacktestSidePanelState.test.mjs test/backtestSwitchRecords.test.mjs test/backtestDataFetcher.test.mjs test/backtest-engine.test.mjs`；build；视觉和 `markets-otc-compare.spec.js`；共同门禁 |
| 4.3 Markets 调度 | 在 `src/pages/markets/` 提取 `useMarketSearch()`、`useSelectedMarketData()`，搬迁选中详情的完整请求/取消组；保留 `useVisibleMarketSymbols()`、`useMarketsWatchRefresh()` 和 `handleColumnVisibilityStateChange()` 调度边界。`refreshFundLimits()`、news/earnings/summary 刷新按实际消费控制，不扩张强刷或预取。先补 `test/e2e/markets-request-boundaries.spec.js` 真实 mounted 请求计数 | `node --test test/marketsWatchData.test.mjs test/marketDetailDataPolicy.test.mjs test/marketsWatchRefresh.test.mjs test/marketHighDrawdown.test.mjs test/marketsLayoutState.test.mjs`；build；`npx playwright test test/e2e/markets-request-boundaries.spec.js --project=chromium`；共同门禁 |
| 4.4 持仓聚合 | 从 `holdingsLedgerCore.js` 提取 `pushCostLot()`、`consumeCostLots()`、`summarizeCostLots()` 到 `src/domain/holdings/costLots.js`，`aggregateByCode()` 到 `src/domain/holdings/aggregateByCode.js`，已收口金额/日历经纯模块引入。`buildLotMetrics()`、`summarizePortfolio()`、sold lots/notify digest 分职责放独立模块；原 façade 保留全部导出 | `node --test test/moneySnapshots.test.mjs test/holdingsLedgerCore.test.mjs test/holdingsTodayProfit.test.mjs test/holdingsTransactionProcessing.test.mjs test/clearedLotsAnalytics.test.mjs test/dailyFundBreakdown.test.mjs`；共同门禁 |
| 4.5 行情 providers | 先加 `test/marketProviderContracts.test.mjs`，锁字段、URL/header、错误和回退次序。把 `fetchers.js` 的腾讯 parse/fetch、雪球 normalize/fetch、Yahoo normalize/fetch、蛋卷、Finnhub、指标、东财搜索分别放 `workers/markets/src/providers/{tencent,xueqiu,yahoo,danjuan,finnhub,indicators,eastmoneySearch,sina}.js`；fetchers re-export 原名。三个等价 `mapLimit()` 抽到 `workers/shared/mapLimit.js`，保留 `{__error}`、顺序和并发语义 | `node --test test/marketProviderContracts.test.mjs test/xueqiuQuote.test.mjs test/xueqiuBatchQuotes.test.mjs test/yahooMarketSummary.test.mjs test/marketsKlineFallback.test.mjs test/marketsBatchQuotesFallback.test.mjs test/quoteCache.test.mjs test/klineHighPoint.test.mjs`；markets/OCR dry-run；共同门禁 |
| 4.6 列表、详情和临界页面 | `MarketListTable.jsx` 的高点/限额/收益 cells、view storage 和 toolbar 进入 `marketListColumns.jsx`、`marketTableViewState.js`、`MarketListToolbar.jsx`；`SymbolDetailPanel()` 的 header/picker/tab 展示进入 `pages/markets/detail/*`，state owner 和挂载身份先保持。Holdings、NewPlan、SwitchStrategy、Notify 只抽展示/已确认纯 helper，TradePlans 到 `pages/tradePlans/*`；无消费的 props/state/effect 成组删除 | `node --test test/marketTableFilters.test.mjs test/marketHighDrawdown.test.mjs test/marketsFundMetrics.test.mjs test/marketDetailHistory.test.mjs test/tradePlans.test.mjs test/transactionDraftState.test.mjs test/mobileBottomNavConfig.test.mjs`；build；smoke；桌面/移动视觉和 `test/e2e/trade-plans-layout.spec.js`；共同门禁 |
| 4.7 预算与层依赖锁定 | 已迁移热点按下表下调；新增模块默认不超过 500 行，provider/独立展示最多 700。新增 `checkLayerImports()` 检查静态 import/re-export、字面量 dynamic import 和 `@/` 路径：domain/shared 禁止 IO，pages/components 禁止新增直接 infra/storage、infra/sync import；旧 app façade 保留。测试验证路径别名和多行 import 不能绕过 | `node --test test/refactorGuard.test.mjs`；共同门禁 |

4.3 的 mounted 请求测试至少覆盖：未选详情，隐藏高点/收益列，缓存命中和缺失，ETF/指数/美股无 OTC 限额，OTC 可用 quote，active list 切换，可见行变化，重复 mount/StrictMode，快速切 symbol，旧 abort 结果不落入新状态。设置特定 route 的失败断言，未知 route 直接报错；不能把已有所有接口 `{}` 兜底沿用为请求验收。

domain 中涉及默认日期/时间的函数由原 app façade 解析默认值后注入，纯模块不自行读取当前时钟。`aggregateByCode()` 的参数签名和默认行为在 façade 中保留；同样避免纯 helper 间接 import 带浏览器 IO 的整个 app 模块。

现阶段应新增预算覆盖的 21 个超 700 行 JS 文件如下。左列是本次按 guard 公式得到的上限初值；有明确本阶段拆分目标的文件以右列最终目标为准，其他文件本阶段只冻结，留给对应后续任务。

| 路径 | 当前冻结上限 | 本阶段最终目标 |
| --- | ---: | ---: |
| `src/components/markets/BacktestSidePanel.jsx` | 2060 | 700 |
| `workers/markets/src/fetchers.js` | 1832 | 250 |
| `src/pages/markets/MarketSymbolDetailPanel.jsx` | 1563 | 700 |
| `workers/notify/src/switchStrategy.js` | 1267 | 1267，纯策略拆分另行审查 |
| `src/pages/markets/MarketListTable.jsx` | 1255 | 700 |
| `src/pages/TradePlansExperience.jsx` | 1238 | 700 |
| `src/app/holdingsLedgerCore.js` | 1152 | 500 |
| `workers/sync/src/index.js` | 1112 | 1112，服务端路由拆分不混入 |
| `src/app/analytics.js` | 1056 | 1056，阶段 5 再收紧 |
| `src/pages/HomeExperience.jsx` | 944 | 944 |
| `src/app/holdingTransactionsSync.js` | 886 | 886，阶段 5 再收紧 |
| `src/pages/StrategyGuideExperience.jsx` | 838 | 838 |
| `src/pages/markets/MarketChartPanel.jsx` | 826 | 826 |
| `src/components/account-menu.jsx` | 818 | 818 |
| `src/app/directMarketData.js` | 813 | 813，阶段 5 再收紧 |
| `workers/markets/src/fundMetricsRoutes.js` | 785 | 785 |
| `src/pages/WorkspacePage.jsx` | 761 | 761 |
| `src/app/qdiiFundCodes.js` | 746 | 746，数据清单不为压行重排 |
| `workers/notify/src/getNav.js` | 733 | 733 |
| `workers/ocr-proxy/src/holdingsNavRoutes.js` | 710 | 710 |
| `workers/ocr-proxy/src/fundLimit.js` | 703 | 703 |

额外覆盖实际入口 `workers/notify/src/accountEntry.js`、`workers/sync/src/optimizedEntry.js`、`workers/account/src/entry.js` 及所有新接收模块，上限采用实施前 `lineCount` 结果，不凭空填写统一 1300。Python 的 storage/aggregates/core/paper_trade/backtest/http_server 大文件先记录预算，拆分在独立采集器任务进行。

已有预算收紧目标：Markets 1200、Holdings 1100、SwitchStrategy 900、NewPlan 550、Notify 750、markets Worker index 750。此处对应页面先完成抽取和验证，再收紧；不能先降低导致全仓失败后一次性大改。

**回滚**：展示、effect、纯聚合、provider 每组分别回退；共享文件和使用方成组回退。新 guard 预算随其抽取提交回退到原有效上限，不高于原值。回滚只恢复代码和旧产物，不清缓存/账本，不更新视觉基线掩盖差异。

**工作量**：5 至 7 人天；包含真正视觉基线和边界 E2E。未关闭的列表 Bug、Python 大文件拆分不计入。

**分支/合并**：未来 `refactor/cn-v2-4-modules`，独立 PR 到 `cn`；按 4.2、4.3、4.4、4.5 顺序形成提交组，再完成 4.6/4.7。发布按前端与受影响 Worker 分开执行，此阶段不依赖阶段 5 才能运行。

### 阶段 5：统一数据访问职责、错误记录与可选类型检查

**目标**：在已有 transport、同步注册表和远端运行存储上统一机制；把同一 domain 的持久化、远端读写和 merge 放到可测 repository；保留不同协议、路由和 merge 政策。

**前置条件**：阶段 3 的 storage/events、阶段 4 的稳定 façade 已合并；账户同步、conflict、holding journal 和会话切换相关基线全绿。`cloudSync.js` 当前已经是资源同步兼容 façade，不能按旧报告再次设计整包加密上传路径。

| 步骤 | 先补测试，再改哪些文件和函数 | 验证命令 |
| --- | --- | --- |
| 5.1 补 merge 直接测试 | 新增 `test/syncMerge.test.mjs`，直接覆盖 `compareRecordVersions()`、`mergePayloadValue()`、`mergePayloadValueRemoteWins()`、`mergeRemoteAuthoritative()`、`mergeBackupEnvelopes()`：revision/timestamp/origin、同版本、删除记录、坏 JSON、重复 ID、local/remote authoritative 差异。先固定输出，再将纯 merge 放 `src/domain/sync/mergeStrategies.js`，原文件保留导出 | `node --test test/syncMerge.test.mjs test/cloudSyncMerge.test.mjs test/cloudSyncConflict.test.mjs test/syncRegistry.test.mjs`；共同门禁 |
| 5.2 transport 机制 | 新增 `test/httpTransportContracts.test.mjs`，锁 `apiTransport.fetchWithGetRetry()` 的 GET 仅一次重试、非 GET 无重试、abort、错误属性、base/header。移机制到 `src/infra/http/transport.js`，保持旧 apiTransport façade；`marketsApi.getJson/postJson()`、`accountApi.performRequest()`、`notifySync.requestNotify()`、`switchStrategySync.requestSwitch()` 各保留协议 adapter | `node --test test/httpTransportContracts.test.mjs test/apiTransport.test.mjs test/authClient.test.mjs test/marketsApi.test.mjs test/accountApiForwarding.test.mjs test/notifySync.test.mjs test/switchStrategyConfigSync.test.mjs`；共同门禁 |
| 5.3 按资源 repository | 新增 `src/infra/sync/repositories/{resourceRepository,holdingTransactionRepository,notifySettingsRepository,switchConfigRepository}.js`，入口用 `create*Repository()`；分别接 `resourceSync.pushResource/pullResources()`、`holdingTransactionsSync.runPullHoldingTransactions/runPushHoldingTransactionRows()`、通知和切换配置原 adapter。先补 `test/repositoryContracts.test.mjs`：CAS/If-Match、tombstone、session identity、pending journal 恢复、取消、幂等写入次数和端点完整 URL | `node --test test/repositoryContracts.test.mjs test/accountResourceSync.test.mjs test/holdingsTransactionRows.test.mjs test/holdingTransactionEventState.test.mjs test/notifyAccountOwnership.test.mjs test/switchStrategyConfigSync.test.mjs`；共同门禁 |
| 5.4 保留调度和兼容入口 | `cloudSync.startCloudAutoSync()`、`resourceSync.startAccountAutoSync()`、`holdingTransactionsSync.startHoldingTransactionAutoSync()`、`postAuthSync.coordinatePostAuthSync()` 各自保留 timer/listener/session owner，仅依赖 repository。`syncClient` 保留客户端身份；`syncRegistry` 保留策略注册；`rangeUrlSync` 属 URL，`syncDebugger` 属诊断，不并入数据同步 repository；`switchStrategyTestSync.testSwitchConfig()` 保留显式测试动作，不转成自动调度 | `node --test test/cloudSyncConflict.test.mjs test/accountLoadingState.test.mjs test/accountMigrationGate.test.mjs test/syncClient.test.mjs test/notifySync.test.mjs test/switchStrategyConfigSync.test.mjs`；build 和 smoke；共同门禁 |
| 5.5 错误记录和客户端解析 | 将 Q5 的日志核心移动为 `src/infra/logger/logger.js`，`src/app/logger.js` re-export；扩充静态事件码。逐项盘点 catch，把有必要观察的失败接 logger，合法可选探测保留带原因注释；不一律改成 throw、toast 或网络上报。`analytics.sanitizeMeta()`、`readStoredEventArray()`、`flushAnalyticsEvents()` 分成纯隐私、存储、transport 模块；directMarketData parse/cache 分开，来源与 TTL 保留 | `node --test test/logger.test.mjs test/analyticsPrivacy.test.mjs test/directMarketData.test.mjs test/httpTransportContracts.test.mjs`；build；对应 E2E；共同门禁 |
| 5.6 纯预设和基金合同 | 从 `marketsWatchlistStorage.js` 提取静态 `CN_ETF_WATCHLIST_PRESETS`、`CN_OTC_WATCHLIST_PRESETS` 等到 `shared/marketPresets.js`；旧文件 re-export，OCR `fundLimit/fundLimitOverview` 改引用纯常量。基金分类只提取已证明一致的纯子集到 `shared/fundKind/`，异步 Worker kind、LOF/QDII adapter 保持差异 | `node --test test/marketsWatchlistDefaults.test.mjs test/fundLimitRoute.test.mjs test/fundLimitOverview.test.mjs test/qdiiFundClassification.test.mjs`；OCR dry-run；共同门禁 |
| 5.7 可选类型化评估 | 先给 money/calendar/merge/quote 加 JSDoc；可选新增 `tsconfig.domain.json`，`allowJs/checkJs/noEmit` 仅覆盖纯 domain/shared。根包没有 TypeScript 时由独立批准的工具 PR添加固定版本和 lock，再加 `check:types`；现有 agents 子项目 tsconfig 保留，不宣称全仓 TS | 已批准类型工具后 `npm run check:types`；共同门禁；未选择类型化时记录评估结论，不阻断本阶段结构交付 |

报告的“14 个 sync 模块”需要按职责分类，验收要求运行数据访问路径都经过对应 repository 或显式协议 adapter，不要求把 URL、事件、诊断、身份注册表删成一个文件。D1、SQLite、localStorage、WebDAV 可以共用接口契约测试，不能共用一个会改变事务、鉴权或迁移行为的实现。

影响缓存的每批提取仍需跑 `quoteCache`、`kvCache`、`klineHighPoint`、`marketHighDrawdown` 等测试，覆盖命中、过期、source 不符、形态、坏 key 和 live 写回。transport 不额外引入 timeout/retry，不能改变既有 180ms GET retry、传播重试表或共享 inflight 的取消语义。

阶段 5 建议收紧 `analytics.js` 至 650、`directMarketData.js` façade 至 450、`holdingTransactionsSync.js` 调度 façade 至 600；repository 单文件不超过 500。sync/notify Worker 实际入口、SQL/schema、投递状态机、Container 动态 skill 路径和本地 auth 生产代码拆分继续作为独立任务。

`syncMerge.js` 当前依赖带存储的 `marketsWatchlistStorage.normalizeWatchlist()`，该归一化函数先单独提取为纯 helper，不能让 domain 继续依赖整个浏览器模块。`mergeBackupEnvelopes()` 使用的默认时间在旧 façade 中生成并注入；新模块仍按固定输入测试，时间/id 的生成时机保持原来位置。

**回滚**：repository 与消费者成组回退，旧 app façade 仍有效；timer/listener owner 不变，回退无数据搬迁。JSDoc/类型检查工具单独提交可独立回退。新旧请求、写入、冲突结果不等即停止该批，不做生产恢复/覆盖来修正测试结果。

**工作量**：6 至 9 人天；可选类型检查工具 0.5 至 1 人天另计，认证改造和 Decimal 不计入。

**分支/合并**：未来 `refactor/cn-v2-5-data-access`，独立 PR 到 `cn`，先 merge/transport 后 repository，再日志/预设。纯结构可独立上线；多设备验收用两个隔离测试账号/profile 和合成数据，按相同操作核对 revision、行数、tombstone、journal 与投递次数，不发送生产测试通知。

## 5. Quick Wins 操作手册

这些步骤只供后续实施使用。推荐执行顺序为 Q1、Q5、Q4、Q3，Q2 在 B1 决策完成后以独立 Bug PR插入。报告的“各项 1 至 2 小时、零冲突”需要修正：Q2 有行为变化，Q4 会暴露旧 error，Q5 触及三个页面，恢复绿色还依赖真实基线 Bug。

### Q1：内部同步 token 移出索引并协调两端轮换

**范围与顺序**：仓库止血、离线契约检查、暂停本地同步发送、准备新发送端凭据、更新 Worker secret、恢复发送、验收幂等。不会读取或打印 `.internal_sync_token`。该文件移出索引后仍留在本地且被忽略；历史泄露仍通过轮换使旧值失效。

1. 从仓库根执行仅输出路径/版本的检查。

```bash
git branch --show-current
git rev-parse HEAD
git ls-files --error-unmatch .internal_sync_token
```

2. 先追加精确根目录 ignore，再移出索引。执行者的既有改动不能被覆盖。

```bash
python3 - <<'PY'
from pathlib import Path
path = Path('.gitignore')
text = path.read_text()
rule = '/.internal_sync_token'
if rule not in text.splitlines():
    path.write_text(text.rstrip('\n') + '\n\n# Local internal auth-sync credential\n' + rule + '\n')
PY
git rm --cached -- .internal_sync_token
git add -- .gitignore
git check-ignore --no-index -v -- .internal_sync_token
git ls-files -- .internal_sync_token
git diff --cached --stat
git diff -- .gitignore
```

最后的 `git ls-files` 必须无输出。检查删除时只看 `--stat`/`--name-status`；禁止完整 `git diff --cached`，它会显示被删除文件的旧内容。不能把该文件内容加入 PR、日志、CI artifact 或 shell history。

3. 先跑离线鉴权/outbox 测试和脚本语法检查。`handleInternalAuthSync()` 继续缺配置返回 503、错误 Bearer 返回 401；不临时接受两个 token。`services/auth/src/syncWorker.js:internalToken()` 继续读取 `process.env.INTERNAL_SYNC_TOKEN`。

```bash
node --test workers/sync/test/auth-sync.test.mjs services/auth/test/outbox.test.mjs services/auth/test/auth.test.mjs
bash -n scripts/deploy-auth-manual.sh
```

4. 在已核实使用 systemd 的 CN 主机执行下列操作。当前部署脚本生成的 unit 名为 `ai-dca-auth-sync.service`；若冻结清单显示其他运行管理器，使用其已批准的等价停止/环境注入操作，不能套用错误的服务名。

```bash
sudo systemctl stop ai-dca-auth-sync.service
sudo systemctl is-active ai-dca-auth-sync.service
```

`is-active` 预期输出 inactive 且返回非零，这是停止确认。`stop` 必须等在途批次结束再继续。保留 HTTP auth 服务运行，注册/登录继续将事件放进 SQLite outbox；不能删事件或手动把 pending 标为 done。此顺序必要，因为 `processOnce()` 把 401 当永久错误并记死信。

5. 由凭据管理器生成一个全新凭据，用隐藏输入在 CN 主机写入 root-only 环境文件。以下命令不回显值。

```bash
set +x
read -r -s -p '输入凭据管理器中的新内部同步凭据：' REFACTOR_INTERNAL_SYNC_TOKEN
printf '\n'
[[ "$REFACTOR_INTERNAL_SYNC_TOKEN" =~ ^[A-Za-z0-9_-]{32,}$ ]] || { unset REFACTOR_INTERNAL_SYNC_TOKEN; exit 1; }
sudo install -d -m 700 /etc/ai-dca-auth
sudo install -m 600 /dev/null /etc/ai-dca-auth/internal-sync.env
printf 'INTERNAL_SYNC_TOKEN=%s\n' "$REFACTOR_INTERNAL_SYNC_TOKEN" | sudo tee /etc/ai-dca-auth/internal-sync.env >/dev/null
unset REFACTOR_INTERNAL_SYNC_TOKEN
```

将现存 unit 中唯一的 `Environment=INTERNAL_SYNC_TOKEN=...` 行替换为 `EnvironmentFile=/etc/ai-dca-auth/internal-sync.env`，保留其他环境、数据库路径、ExecStart 和 Restart。可用下列脚本替换，它不输出 unit 内容。

```bash
sudo python3 - <<'PY'
from pathlib import Path
import re
path = Path('/etc/systemd/system/ai-dca-auth-sync.service')
text = path.read_text()
text, count = re.subn(
    r'^Environment=INTERNAL_SYNC_TOKEN=.*$',
    'EnvironmentFile=/etc/ai-dca-auth/internal-sync.env',
    text,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit('unit 凭据行数量不符，需按冻结清单核实，未写文件')
path.write_text(text)
PY
sudo systemctl daemon-reload
sudo stat -c '%a %U %G' /etc/ai-dca-auth/internal-sync.env
```

stat 应为 `600 root root`。同时把 `scripts/deploy-auth-manual.sh` 的同一 unit 模板改成 EnvironmentFile，并让它在安装前检查该文件存在且权限正确，避免下一次部署又把凭据写进 unit。不在生产重新运行整个安装脚本。

6. 在有已批准 Wrangler 的部署终端更新接收端。secret 名精确为 `INTERNAL_SYNC_TOKEN`，目标 config 精确为 sync Worker，不能写到 notify 或 account。

```bash
REFACTOR_WRANGLER="$PWD/workers/markets-agent/node_modules/.bin/wrangler"
"$REFACTOR_WRANGLER" --version
set +x
read -r -s -p '输入同一新内部同步凭据：' REFACTOR_INTERNAL_SYNC_TOKEN
printf '\n'
[[ "$REFACTOR_INTERNAL_SYNC_TOKEN" =~ ^[A-Za-z0-9_-]{32,}$ ]] || { unset REFACTOR_INTERNAL_SYNC_TOKEN; exit 1; }
if ! printf '%s' "$REFACTOR_INTERNAL_SYNC_TOKEN" | "$REFACTOR_WRANGLER" secret put INTERNAL_SYNC_TOKEN --config workers/sync/wrangler.toml; then
  unset REFACTOR_INTERNAL_SYNC_TOKEN
  exit 1
fi
unset REFACTOR_INTERNAL_SYNC_TOKEN
"$REFACTOR_WRANGLER" secret list --config workers/sync/wrangler.toml
```

标准 Wrangler 命令即 `wrangler secret put INTERNAL_SYNC_TOKEN --config workers/sync/wrangler.toml`；这里使用已核实的绝对工具路径。[Cloudflare 官方说明](https://developers.cloudflare.com/workers/configuration/secrets/) 指出 `secret put` 会创建并立即部署新 Worker 版本，故这一步属于已确认的轮换发布窗口，要记录原版本和新版本，确认业务代码仍为冻结线上版本。渐进部署环境改用官方 `versions secret put` 流程，由原发布机制部署该版本，不擅自替换上线机制。

7. Worker secret 设置成功后回到 CN 主机启动发送端。

```bash
sudo systemctl start ai-dca-auth-sync.service
sudo systemctl is-active ai-dca-auth-sync.service
```

观察正常 pending outbox 完成、401/503 和 dead 数没有新增、相同 eventId 不重复写入、session 不延期。凭据验证用隔离测试账户/既有自然同步证据，不能向生产接口发送会写 D1 的随机测试事件。仅记录状态、计数和版本，不记录请求 Authorization、env 值或 SQLite 凭证字段。

8. 用当前有效凭据验证完再关闭轮换任务，运行共同门禁。失败时保持同步发送停止，修正两端新凭据配置后恢复；不得重启仍使用旧 token 的发送端，不回退到泄露的值。回退 Worker 业务代码时也必须确认当前新 secret 仍生效，禁止把凭据止血作为历史版本回退的附带效果撤销。旧 token 明确失效后，再由独立任务评估 `git filter-repo` 历史清理、远端强推和协作者重建，本文不授权改写历史。

### Q2：补 notify 的 2024 年假期

**决策门**：只有 B1 明确选择修 Bug 才执行。变更会影响 2024 NAV 预期、历史 gap 和日历门禁。区间沿用前端七段，已与[上交所 2024 年休市安排](https://www.sse.com.cn/disclosure/announcement/general/c/c_20231226_5733939.shtml) 核对；周末仍由原函数判断，调休上班周末不成为交易日。

1. 定位当前基线位置。

```bash
nl -ba src/app/holidaysCN.js | sed -n '16,26p'
nl -ba workers/notify/src/holdingsNavSupport.js | sed -n '48,78p'
```

前端来源为 `holidaysCN.js:17` 至 `:24`；目标是 `holdingsNavSupport.js:53` 的 `rangesByYear`，在原 `:54` 的 `'2025'` 之前插入，不改函数签名、2025、2026 或迭代逻辑。

修改前：

```js
  const rangesByYear = {
    '2025': [
      ['2025-01-01', '2025-01-01'],
```

修改后：

```js
  const rangesByYear = {
    '2024': [
      ['2024-01-01', '2024-01-01'],
      ['2024-02-09', '2024-02-17'],
      ['2024-04-04', '2024-04-06'],
      ['2024-05-01', '2024-05-05'],
      ['2024-06-10', '2024-06-10'],
      ['2024-09-15', '2024-09-17'],
      ['2024-10-01', '2024-10-07']
    ],
    '2025': [
      ['2025-01-01', '2025-01-01'],
```

2. 改源码之前新增 `test/tradingCalendar2024.test.mjs`，其中至少包含下列直接行为测试；在旧代码上确认测试因 2024 缺表而失败，再应用上面的插入。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isChinaMarketHoliday as frontendHoliday,
  isTradingDayShanghai as frontendTradingDay,
} from '../src/app/holidaysCN.js';
import {
  isChinaMarketHoliday as workerHoliday,
  isTradingDayShanghai as workerTradingDay,
  getExpectedLatestNavDate,
} from '../workers/notify/src/holdingsNavSupport.js';

test('2024 全年 holiday 和 trading-day 与前端一致', () => {
  for (let i = 0; i < 366; i += 1) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    assert.equal(workerHoliday(date), frontendHoliday(date), date);
    assert.equal(workerTradingDay(date), frontendTradingDay(date), date);
  }
});

test('2024 春节边界、调休周末和 NAV 回溯', () => {
  assert.equal(workerTradingDay('2024-02-08'), true);
  assert.equal(workerHoliday('2024-02-09'), true);
  assert.equal(workerTradingDay('2024-02-18'), false);
  assert.equal(workerTradingDay('2024-02-19'), true);
  assert.equal(getExpectedLatestNavDate('otc', '2024-02-12'), '2024-02-08');
  assert.equal(getExpectedLatestNavDate('qdii', '2024-02-19'), '2024-02-08');
});
```

扩充测试覆盖七段 start/end、2025/2026 未变化以及 2024 休市盘中 `evaluateMarketAlertRules()` / `evaluateHoldingAlertRules()` 不请求行情、无投递。复用 `workers/notify/test/tradingCalendar.test.mjs` 的 mock，不调用真实渠道。

3. 按顺序验证，review 只允许插表和对应测试，单独发布 notify 并保留旧版本。

```bash
node --test test/tradingCalendar2024.test.mjs workers/notify/test/tradingCalendar.test.mjs test/backtestGapOptimization.test.mjs test/backtest-engine.test.mjs test/holdingsLedgerCore.test.mjs
npm run check:refactor
npm run lint -- --quiet
git diff --check
```

再执行共同门禁与 notify dry-run。阶段 1 随后删掉这份内联表，保留上述测试，改由共享 JSON 提供 2024。Q2 回滚是独立 Bug PR/Worker 版本回退，不能通过修改测试期望假装没有数据变更。

### Q3：恢复最小 CI

1. 先把 `package.json` 的旧测试脚本替换成显式文件匹配。

```diff
-    "test:unit": "node --test test workers/sync/test workers/account/test",
+    "test:unit": "node --test test/*.test.mjs test/returns/*.test.mjs workers/*/test/*.test.mjs services/auth/test/*.test.mjs",
```

当前已有目录均含匹配文件。以后增加嵌套单测目录时，同一个 PR 更新发现规则并证明新旧集合；不直接把 `test/e2e/*.spec.js` 交给 Node。CI 选 Node 24，与本次运行的大版本相同，兼容本地 auth 的原生 SQLite 需求。

2. 新建 `.github/workflows/ci.yml`，完整内容如下。采用官方 `checkout`、`setup-node` 的 v4 系列，安装依赖使用现有 lock，不恢复自动发布。`setup-node` 的版本选择与 npm cache 参数见[官方文档](https://github.com/actions/setup-node/tree/v4)。

```yaml
name: quality

on:
  pull_request:
    branches: [cn]
  push:
    branches: [cn]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: quality-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    env:
      CI: 'true'
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
          cache-dependency-path: package-lock.json

      - name: Install locked dependencies
        run: npm ci

      - name: Architecture guard
        run: npm run check:refactor

      - name: Node unit tests
        run: npm run test:unit

      - name: Lint errors
        run: npm run lint -- --quiet

      - name: Whitespace check
        run: git diff --check

      - name: Frontend build
        run: npm run build:app
```

这个 workflow 不安装子项目生产服务、不运行任何 deploy/collect/notification 脚本，不使用生产 secret。auth Node 测试本身没有第三方依赖，原生 SQLite 用 Node 24 提供。Python、Worker bundle 和 Playwright 作为对应阶段额外检查；最小 CI 不能声称已经验证全部七个 Worker 和独立服务。

3. 本地按 CI 顺序运行。确认阶段 0 的基线修复已经完成，禁止 `continue-on-error`。

```bash
npm ci
npm run check:refactor
npm run test:unit
npm run lint -- --quiet
git diff --check
npm run build:app
```

4. 在后续阶段 0 的隔离工作分支执行一次 guard 失败试验，命令无论成功失败都恢复原文件。

```bash
node --input-type=module <<'JS'
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const file = 'src/pages/MarketsExperience.jsx';
const original = fs.readFileSync(file, 'utf8');
try {
  fs.writeFileSync(file, original + '\n// guard probe'.repeat(200));
  const result = spawnSync(process.execPath, ['scripts/check_refactor_guard.mjs'], { encoding: 'utf8' });
  if (result.status !== 1 || !result.stderr.includes('budget is')) {
    throw new Error('超预算没有被护栏拒绝');
  }
} finally {
  fs.writeFileSync(file, original);
}
JS
npm run check:refactor
git diff --check
```

远端验收在临时 PR 修改中触发同样失败，保存真实 Actions 检查链接后撤回故障注入，再确认绿色；不得合并试验改动。经仓库所有者将实际 Checks 返回的 `quality` job 名配置为 cn 合并必需检查后才能称为自动门禁，不能只恢复 workflow 文件。PR 流水线里的 `git diff --check` 只检查 runner 工作树，源 diff 空白检查仍必须在实施者提交前运行，不能用该步骤替代本地检查。

### Q4：lint/format 扩面，区分运行环境

1. `package.json` 原两行替换为以下三行。JS lint 覆盖 src、Worker、Node 服务、脚本和后续 shared；Python/Shell 不由 ESLint 解析，单独使用原生测试/语法检查。

```diff
-    "lint": "eslint src",
-    "format": "prettier --write src",
+    "lint": "eslint \"{src,workers,services,scripts,shared}/**/*.{js,jsx,mjs}\" --max-warnings=-1",
+    "format": "prettier --ignore-path .gitignore --write \"{src,workers,services,scripts,shared}/**/*.{js,jsx,mjs,ts,json,css}\"",
+    "format:check": "prettier --ignore-path .gitignore --check \"{src,workers,services,scripts,shared}/**/*.{js,jsx,mjs,ts,json,css}\"",
```

`--max-warnings=-1` 明确允许既有 warning，`--quiet` 只显示 error；仍保留 `no-undef`、`no-empty`、重复 key 等 error。format 全量脚本仅供显式整理任务，不在本轮运行 `npm run format` 改全仓。`format:check` 初期用于诊断，旧格式债未清理前不加进最小 CI。

2. `eslint.config.js` 做精确替换：删掉原全局 ignores 的 `'scripts/**'`；把推荐 JS 规则限定到实际目标文件；保留 src React 规则；把原 services/auth 块扩成 Node 环境块；新增 Worker 与三份浏览器控制台脚本环境。完整目标内容如下。

```js
import js from '@eslint/js';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const JS_TARGETS = [
  'src/**/*.{js,jsx}',
  'workers/**/*.{js,mjs}',
  'services/**/*.{js,mjs}',
  'scripts/**/*.{js,mjs}',
  'shared/**/*.{js,mjs}',
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      'docs/**',
      'frontend-dist/**',
      '.frontend-build/**',
      '.edgeone-pages/**',
      'data/**',
      '**/.wrangler/**',
      '**/__pycache__/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: JS_TARGETS,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { react: reactPlugin, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
    },
  },
  {
    files: ['workers/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.worker, WebSocketPair: 'readonly' },
    },
  },
  {
    files: [
      'services/**/*.{js,mjs}',
      'scripts/**/*.{js,mjs}',
      'workers/markets-agent/container/**/*.js',
      'workers/**/test/**/*.{js,mjs}',
      'workers/**/scripts/**/*.{js,mjs}',
      'workers/**/test-*.js',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: [
      'scripts/delete-orphan-holding-console.js',
      'scripts/delete-transaction.js',
      'scripts/holdings-audit-console.js',
    ],
    languageOptions: { globals: { ...globals.browser } },
  },
];
```

后端不全局赋予 window/localStorage 等 browser globals。`WebSocketPair` 为实际 Cloudflare runtime 全局；新增 globals 必须有运行时依据。[ESLint flat config 官方说明](https://eslint.org/docs/latest/use/configure/language-options) 支持按 files 设置 languageOptions/globals。这里不新增 TypeScript parser 或依赖，agents 的 `.ts` 仍由现有子项目类型工具处理。

3. 按顺序核查扩面是否实际生效，再清理 error。`--print-config` 不能只证明文件被发现，还要确认 Node/Worker globals 无 browser 混入。

```bash
npx --no-install eslint --print-config scripts/check_refactor_guard.mjs
npx --no-install eslint --print-config workers/notify/src/accountEntry.js
npx --no-install eslint --print-config services/auth/src/syncWorker.js
npm run lint -- --quiet
npm run lint
npx --no-install prettier --check package.json eslint.config.js .github/workflows/ci.yml
node --test test/apiTransport.test.mjs workers/sync/test/auth-sync.test.mjs
npm run check:refactor
git diff --check
```

新增 error 不能通过恢复 scripts ignore、忽略整个 Worker、把 rule 改成 off、给未定义业务函数加 globals 来处理。冗余 `/* global ... */` 声明可以移除；空 catch 按用途加最小日志或解释预期降级；每个真实 Bug 先补行为测试。修改 ESLint 配置本身不修改 `package-lock.json`。

### Q5：最小 logger 与四处空 catch

**实现原则**：本地结构化 console；生产仅 warn/error，开发可以 debug/info；静态事件码白名单；不记录 error.message/stack、token、headers、URL、会话、账本、通知 payload，不写存储、不发网络请求。logger 自身失败不改变业务 fallback。阶段 5 再移动到 infra，保留旧入口。

1. 先新增 `test/logger.test.mjs`，注入 sink/clock/dev，断言生产 info/debug 为 0 次、warn/error 为 1 次、未知事件降级、敏感错误 message/stack 不出现、sink 缺失/抛错不抛出，以及 import 时无 window/IO。再创建 `src/app/logger.js`，完整实现如下。

```js
const EVENT_CODES = new Set([
  'cn-home.cache-write-failed',
  'notify-event.clipboard-copy-failed',
  'data-repair.scan-ledger-read-failed',
  'data-repair.repair-ledger-read-failed',
]);

const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'QuotaExceededError',
  'SecurityError',
  'NotAllowedError',
  'AbortError',
  'TimeoutError',
]);

export function createLogger({
  sink = globalThis.console,
  development = import.meta.env?.DEV === true,
  now = Date.now,
} = {}) {
  function emit(level, code, error) {
    if ((level === 'debug' || level === 'info') && !development) return;
    try {
      const errorName = ERROR_NAMES.has(error?.name) ? error.name : 'UnknownError';
      const record = {
        time: new Date(now()).toISOString(),
        level,
        event: EVENT_CODES.has(code) ? code : 'app.unclassified',
        errorName: error == null ? null : errorName,
      };
      const output = sink?.[level];
      if (typeof output === 'function') output.call(sink, '[ai-dca]', record);
    } catch {
      // 日志工具不可改变业务 fallback；禁止在这里递归记录日志。
    }
  }

  return Object.freeze({
    debug: (code, error) => emit('debug', code, error),
    info: (code, error) => emit('info', code, error),
    warn: (code, error) => emit('warn', code, error),
    error: (code, error) => emit('error', code, error),
  });
}

export const logger = createLogger();
```

2. 给以下三个页面分别新增同一 import。

```js
import { logger } from '../app/logger.js';
```

四处改动如下，行号均为规划基线原始位置。

**第一处，`src/pages/CnHomeExperience.jsx:31` 的 `writeCache(section, value)`。**

修改前：

```js
function writeCache(section, value) { try { localStorage.setItem(cacheKey(section), JSON.stringify(value)); } catch {} }
```

修改后：

```js
function writeCache(section, value) {
  try {
    localStorage.setItem(cacheKey(section), JSON.stringify(value));
  } catch (error) {
    logger.warn('cn-home.cache-write-failed', error);
  }
}
```

仍保持原 void 返回和 `cn-home:<section>:v1` key；失败不强制刷新、不重试接口，不记录 value。

**第二处，`src/pages/NotifyEventDetailDialog.jsx:67` 至 `:73` 的 `handleCopyJson()`。**

修改前：

```js
  function handleCopyJson() {
    try {
      navigator.clipboard.writeText(JSON.stringify(event, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }
```

修改后：

```js
  function handleCopyJson() {
    try {
      const writeResult = navigator.clipboard.writeText(JSON.stringify(event, null, 2));
      Promise.resolve(writeResult).catch((error) => {
        logger.warn('notify-event.clipboard-copy-failed', error);
      });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      logger.warn('notify-event.clipboard-copy-failed', error);
    }
  }
```

原 try/catch 捕获不到剪贴板 Promise rejection，故增加异步日志捕获。保留即时 copied 和 2000ms 清除的现有乐观 UI，不新增失败 toast，不把成功状态改成 await 后设置；这种 UX 修复可以另建 Bug。日志不传 event、JSON 文本或错误原文。

**第三处，`src/pages/DataRepairExperience.jsx:39` 至 `:44` 的 `scanHealth()` 读取。**

修改前：

```js
    let localLedger = {};
    try {
      localLedger = JSON.parse(localStorage.getItem('aiDcaFundHoldingsLedger') || '{}');
    } catch {}
```

修改后：

```js
    let localLedger = {};
    try {
      localLedger = JSON.parse(localStorage.getItem('aiDcaFundHoldingsLedger') || '{}');
    } catch (error) {
      logger.warn('data-repair.scan-ledger-read-failed', error);
    }
```

保留 `{}` fallback 和后续数组判断，不记录 ledger、不触发修复。

**第四处，`src/pages/DataRepairExperience.jsx:141` 至 `:145` 的 `runRepair()` 本地读取。**

修改前：

```js
      let localLedger = {};
      try {
        localLedger = JSON.parse(localStorage.getItem('aiDcaFundHoldingsLedger') || '{"transactions":[]}');
      } catch {}
```

修改后：

```js
      let localLedger = {};
      try {
        localLedger = JSON.parse(localStorage.getItem('aiDcaFundHoldingsLedger') || '{"transactions":[]}');
      } catch (error) {
        logger.warn('data-repair.repair-ledger-read-failed', error);
      }
```

不改变后续远端读写、修复流程或按钮行为。完整修复函数包含 DELETE/PUT，浏览器验证必须拦截全部外部请求并用合成数据，不能点击生产账户的一键修复。

3. 新增 `test/e2e/logger-fallback.spec.js`，通过固定坏 JSON、storage 写入抛 QuotaExceededError、clipboard 同步抛错和异步拒绝分别触发四处路径。断言原 fallback、copied 清除时机、没有 unhandled rejection、原业务请求计数不增加、console 只含静态事件码和安全 errorName。对 DataRepair `runRepair` 使用隔离 fake 字典和所有网络 mock。

4. 按顺序验证；这四处之外的 catch 保持本次 scope。

```bash
node --test test/logger.test.mjs test/holdingsDataRepairAndSmartPaste.test.mjs test/cnHomeSeriesHeader.test.mjs
npx --no-install eslint src/app/logger.js src/pages/CnHomeExperience.jsx src/pages/NotifyEventDetailDialog.jsx src/pages/DataRepairExperience.jsx --quiet
npm run check:refactor
git diff --check
npm run build:app
npx playwright test test/e2e/logger-fallback.spec.js --project=chromium
```

追加共同门禁。logger 及四处调用作为同一可回退提交；生产日志中的错误可见性改变允许在此工程步骤中发生，业务返回、UI、存储和请求策略保持原样。

## 6. 阶段依赖关系与可并行工作

文字依赖图如下。

```text
旧阶段 0 冻结成果
        ↓
v2 阶段 0：Q1、Q5、Q4、Q3、当前基线全绿
        ↓
        ├→ B1 决策 → Q2 独立修复或显式保留覆盖 → 阶段 1
        ├→ B2 决策 → 阶段 2，保持原政策
        └→ 阶段 3，外围存储与事件可以并行

阶段 1、阶段 2、阶段 3 都完成
        ↓
列表边界独立 Bug 完成 → 阶段 4 的网络调度/provider 抽取
展示与测试基线可以提前准备 → 阶段 4 其余步骤
        ↓
阶段 5：merge、transport、repositories、logger/预设
        ↓
可选纯 domain 类型检查

阶段 2 完成 → B2 独立语义修复，另行确认，不作为结构重构完成条件
阶段 1 内部收口 → 外部 fund_collector 独立 PR/哈希验收
```

必须串行的部分：阶段 0 全绿先于业务重构；Q1 先停止发送端再更新 secret、最后恢复发送；Q5/Q4 及基线修复完成后 Q3 才能宣称 CI 可用；Q2 的行为基线先于阶段 1 修复路径；金额快照先于任何 round 替换；storage/events 先于 repository；页面/纯计算/provider 先完成抽取再降低预算。

可并行的部分：阶段 0 内凭据离线测试、logger 测试、lint 诊断可以并行准备；阶段 1 数据生成、阶段 2 金额夹具、阶段 3 外围注册表涉及不同文件时可并行。Markets/holdings 文件不同时由两个阶段编辑；跨语言或外部采集器的契约准备可以并行，生产更新仍按各入口单独安排。

发布窗口不并行修改行情和通知关键入口。任何一阶段稳定后都可独立运行，兼容 façade 防止必须一次上线所有消费者。没有数据源、认证和 key/TTL 迁移，因此不需要同步数据库切换窗口。

## 7. 验收标准与停止条件

### 7.1 分阶段完成标准

| 阶段 | 明确可验证的完成条件 |
| --- | --- |
| 0 | `git ls-files .internal_sync_token` 无输出、ignore 生效、旧有效凭据失效、新发送端正常且无新增 401 死信；Node 发现集合含 returns/notify/auth，原 158 文件没有漏掉；相关真实 Bug 已解决，全量 Node 和 lint error 为 0；guard/diff 通过；cn PR 的 CI 实际运行且配置为必需检查；四处日志不含敏感信息 |
| 1 | 仓库内只保留一份手工假期数据；JSON、JS、Python 生成哈希一致，`--check` 只读且通过；1096 天有效日期全量对比符合批准口径，NAV/backtest/时段契约通过；实际 Worker bundle 和 Python 自包含运行通过；四方验收需外部输出证据，未取得时明确保留外部整改项 |
| 2 | 运行中的金额公式全部经政策入口或受检查的生成模块；七种政策及默认精度覆盖；金额快照逐值一致、FIFO 守恒、负零/NaN/Infinity 证据完整；没有 Decimal、新 schema/key 或账本回填；B2 语义修复保持独立状态 |
| 3 | 运行 src 的存储 IO 通过 storage 门面或明确的账户运行存储 adapter，剩余白名单包含原 secureVault/auth 和必要原生 storage 事件；key/prefix/TTL/version 未变化；每个实际使用 key 已注册；未知 key 开发断言有测试；事件名/detail/次数/时机、解绑和跨标签行为一致；游客持久态、登录内存态、恢复链路通过 |
| 4 | 上表热点达到最终目标，21 个既有大 JS 文件及实际入口/接收模块受预算保护；已有预算无提升；guard 的失败分支、层依赖和别名检测通过；桌面与 Pixel 7 `toHaveScreenshot` 实际比较均不超过 0.02，且变化区域人工审查无可见偏差；列表“不会调用”全部通过，旧结果不覆盖新状态，底部浮窗导航恢复正确；provider key/TTL/source/请求峰值和输出未变 |
| 5 | `syncMerge` 有直接全语义测试；数据资源通过对应 repository/协议 adapter，app 公开导出兼容；HTTP method/URL/header/重试/abort/error 属性和 inflight 语义一致；多设备 CAS/删除/journal/session 切换通过；有意义的失败可记录，预期降级有原因且无敏感数据/新增上报；纯预设无 browser IO；类型化选项明确记录，未开展时无虚假类型覆盖声明 |

每个阶段还必须满足共同门禁、必要构建与对应 E2E 全部通过，相关源站请求数、KV/R2 读写次数、通知投递次数不高于固定夹具的基线。不得用行情自然变化解释固定输入的数值差异。

### 7.2 每个 PR 的审查证据

PR 描述列出基线 SHA、变更文件/函数、行为保持或独立 Bug 范围、实际验证命令与结果、兼容导出、受影响部署入口、旧产物/版本和回退提交。安全相关删除 diff 只提供路径和统计，凭据值始终不展示。

验收用合成数据或隔离账号，确认无真实通知、admin 全量推送、生产采集、账本写入、密文覆盖、知识库上传和数据库迁移。需要真实测试渠道的独立验收由原已批准流程安排，与结构检查分开。

### 7.3 停止条件

出现以下任一情况，停止当前相关步骤并保留可独立工作：新旧返回/数值/异常/请求数/写入次数不同；必须改数据源、权限、key/TTL、SQL 或投递路径才能继续；B1/B2 行为选择缺失；全量基线仍有未分类失败；只能提高预算或忽略 error 才能通过；生产入口、版本、发送端或回滚产物不明确；logger 暴露原错误消息或 payload。

结构工作总估算为 18.5 至 27 人天，另计当前真实 Bug 修复、Q2 行为验收、外部采集器协调和可选类型工具。估算按单人有效工作量计算，阶段 1/2/3 的独立准备可以缩短日历时间。阶段完成以可验证标准为准，不能以工期耗尽关闭未解决的数据正确性问题。
