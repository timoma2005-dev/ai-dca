# 份额相关 11 个失败测试修复计划

基线：`cn @ dc06c0cb`。本文件只规划；本次不修改代码、测试，不提交或推送。后续实现者优先 Codely，预算未恢复则 Codex；步骤与实现者无关。

## 目标、范围与交付边界

已知相关测试共 175 个、失败 11 个，按 A（TTL 过期断言，约 8 个）、B（投影 atLimit 不一致，2 个）、C（旧 UI 大用例，1 个）处理。保持生产 400 天 TTL，禁止把 atLimit 的 true 断言改成 false/null。最终交付是仓库与线上产出对齐、相关测试全绿、提交并推送 fork 的 cn 分支；不部署 Worker，不写生产 KV/R2，不手动发布前端或修改发布目录。推送引起前端 autorelease 可以接受，须证明前端产品内容未变。

当前工作区另有未跟踪文件 `docs/plan-react-router-migration.md`，不属于本任务，禁止纳入提交。按根目录 AGENTS.md 的教训，后续实现须独立 worktree，不能与 Hark 或其它会话共用主工作区写入。

## 代码核对后的执行细节

1. `workers/ocr-proxy/src/etfPcfLimit.js` 常量确为 `400 * 86400`，即 34560000 秒；文件仍有“24h”旧注释。本次计划不据注释回退生产常量。
2. Worker src 目录没有 atLimit 赋值，但它通过 `etfPcfSharesProjection.js` 的 re-export 调用 `shared/etfPcfSharesSchema.js` 的 `buildSharesProjection`。共享模块约 249–251 行**已经计算** utilization、atLimit、nearTotalLimit，约 412–414 行校验器验证同一公式。因此不能简单在持久化模块再补一个 atLimit 字段；必须 diff 线上脚本，追到限额选取、日期和投影输入的差异。这不改变 B 类“先取线上源码再对齐、禁止弱化测试”的处理方向。
3. 新看板 `useLimitChanges` 会对缺少 limitChanges 且具有可用日期的记录订阅当日及上一交易日 PCF，并在失败后重试一次。旧快照全局零预取与当前实现不一致；新看板也不再显示百分比利用率、估算申购等全部旧表格字段。Phase 3 必须显式记录无法直接映射项，不能靠删断言伪装覆盖完整。

## Phase 0：准备、取得线上脚本与差异清单

### 步骤与改法

1. 记录 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`、`git remote -v`，确认起点；创建独立分支/worktree，例如 `git worktree add -b fix/shares-tests /tmp/ai-dca-shares-tests dc06c0cb`。如 cn 已前进，先确认新差异，不覆盖他人改动。
2. 运行下文基线测试与 guard，把失败名称、数量、退出码保存在仓库外。测试清单按 glob 展开实际记录，175 是既知基线而非可以删测的目标数字。
3. 取得线上 `ai-dca-etf-shares` 脚本，二选一：
   - 向用户取得一次性 CF token，权限仅限目标账户 Workers Scripts Read，调用 `GET /accounts/:id/workers/scripts/ai-dca-etf-shares`；账户 ID 取确认过的配置。凭证仅临时安全注入，不放 argv、日志、文档或提交。
   - 向并行会话 Hark 索取其已同步源码及对应 Worker 名称、获取时间、版本/部署标识、原始文件校验和；本计划不直接发消息。
4. 原始响应、响应 Content-Type、版本证据、SHA-256 保留在仓库外临时目录；API 若返回 multipart，按边界提取所有模块并识别入口，不把响应当单文件 JS。token 用完即清理。不进行 deploy、PUT、POST 或配置变更。实现时实际使用 Cloudflare 工具前读取对应 Cloudflare skill。
5. 对 bundle 用格式化副本阅读，原始文件保持不动。按 `buildSharesProjection`、调用链、字段名及 source/key 定位代码，以 `git diff --no-index <本地对应文件> <线上可读副本>` 等只读方式建立语义差异表；bundle 噪声不作源码替换依据。
6. 沿 `runEtfPcfEvents → datedLimits/creationStatus → buildSharesProjection → validateSharesProjection → persistSharesProjection` 跟踪两个失败 fixture 的输入。每项差异标注“相同／需同步／其它未入库改动及依赖／暂缓及原因”。线上快照仅作为字段形态证据，不能代替算法源码。

### 逐字段核对清单（合入前后都填写）

| 范围 | 必核对项目 |
| --- | --- |
| 身份与来源 | schemaVersion、source、code/name、13 只标的集合、unit、sourceUrl/dateEvidence |
| 日期与生命周期 | date、prevDate、availableOn、limitDate、prevLimitDate、calendar、fetchedAt/projectedAt/expiresAt、PCF 快照元信息 |
| 份额 | shares、prevShares、deltaShares、creationShares/Kind、creationUnitShares、沪深数据来源与缺失值 |
| 限额与状态 | total/net/accountTotal/accountNet 的 kind/shares、effLimitKind/Shares、limitSource、subscriptionAllowed/redemptionAllowed |
| 派生字段 | utilization、atLimit、nearTotalLimit 的分母、等值/阈值/负值/零值/null 语义；limitChanges 四项及 limitChange |
| 降级字段 | status、reasons、价格/金额字段缺失时的 null，禁止补未经凭证的金额 |
| 读写与运行 | 历史/当日 key、latest 指针、防旧覆盖、400 天 TTL 与历史永久缓存区别、source/日期校验、并发/预算/重试、路由与绑定 |

不得用下载的整个 bundle 覆盖仓库文件。其它线上未入库逻辑逐项留档；B 必需依赖一并小范围同步，其余不夹带且不得被本次本地重构抹掉。只读对齐无法保证未来部署保留所有暂缓项，因此交付明确列出残余差异并继续禁止 Worker 部署。

**完成判据：** 有可追溯线上源码、逐字段差异表、两个失败的输入链解释及明确合入位置；取不到源码时 B 阶段保持阻塞，可先做 A/C，不能猜公式交付 B 完成。

**风险与回滚：** 源码版本过旧、bundle 模块遗漏、凭证泄漏；核对版本和完整模块列表，临时文件不入库。此阶段只读，无生产回滚动作。

## Phase 1：A 类，更新 400 天 TTL 测试语义

### 步骤与改法

1. 逐个核对 `test/etfPcfLimit.test.mjs`、`test/etfPcfSharesDates.test.mjs` 中失败名称及 fixture。测试用独立明确常量 `400 * 86400`，不能从生产内部常量取预期而形成自证。
2. KV 写入值断言改为 34560000；expiresAt 按固定 fetchedAt 加 400 天生成（如原 2026-10-13 对应 2027-11-17，保留具体时分秒）。同步测试名称中的“24h/86400”描述。
3. 缓存超时案例把读取时钟置于实际 400 天有效期之外，或显式构造 expiresAt <= now；保证 code/date 仍匹配，避免走历史读取分支。TTL 异常用 `expiresAt - fetchedAt > 400 天 + 60000ms` 构造，不再把旧 25h 当异常。
4. 命中、memory 命中、未来 fetchedAt、source/身份不符、损坏 JSON、写入 key 防御等原意保留；用固定时钟避免依赖真实日期。短 TTL 旧缓存仍可合法存在，不能全局替换所有 86400/86400000；日期步长、旧 TTL 迁移、历史永久缓存、显式过期历史 PCF fixture 都须逐一判断。
5. 跑 A 涉及的两个文件，区分仍应留到 B 修复的 atLimit 失败；A 场景不再失败即可完成本阶段。

**验收命令：** `node --test test/etfPcfLimit.test.mjs test/etfPcfSharesDates.test.mjs`。

**完成判据：** TTL 失败归零；缓存命中/过期/异常/写入值各意图仍有覆盖；生产 TTL 未改。

**风险与回滚：** 批量替换破坏日期和历史测试。按语义逐处审查；回滚仅撤销本阶段测试提交，不回退线上 400 天配置。

## Phase 2：B 类，同步线上投影产出路径

### 步骤与改法

1. 以 Phase 0 源码 diff 为依据，同步 atLimit 及相关字段的实际输入和派生路径。当前共享 builder 已有公式，优先查 `etfPcfEvents.js` 的 datedLimits、todayLimits 覆盖顺序、当前/历史 PCF 选择及 creationStatus，不能只在结果上硬写 true。
2. 经 `etfPcfSharesProjection.js` 的投影组装调用路径合入；实际修改文件由线上 diff 决定，允许最小修改共享 builder 或事件输入映射，持久化模块不另造第二套计算。builder 与 validator 语义必须一致。
3. 合入前后复核 Phase 0 清单，列出字段变化原因和未同步项；保留同日、T-1 历史、来源/日期不匹配、缺前一交易日、沪深状态与限额相关约束。不改两个 true 断言，不降低校验器约束。
4. **先单独跑两个原失败用例**，再跑整个事件、日期及投影文件；若 T-1 等其它用例暴露同一输入问题，用源码证据修调用链，不把它归入 TTL 批量改掉。

```bash
node --test --test-name-pattern='projection sidecar reuses bounded downloads|dated same-day shares survive' test/etfPcfEvents.test.mjs test/etfPcfSharesDates.test.mjs
```

检查 TAP 中目标两项确实执行而非全部 skipped。随后执行文件级验收：

```bash
node --test test/etfPcfEvents.test.mjs test/etfPcfSharesDates.test.mjs test/etfPcfSharesProjection.test.mjs
```

**完成判据：** 两个原 true 断言先恢复，三个文件全过；真实公式和输入链可对应线上版本；其它线上未入库逻辑有清单，无整包覆盖。

**风险与回滚：** 日期选择改变历史投影、共享模块影响客户端校验。小范围修改并跑 schema/client 回归；本地独立提交可 revert，线上 Worker 不动。

## Phase 3：C 类，按新看板重写 UI 测试

保留 esbuild + 本地 HTTP + Chromium 框架、合成快照、请求拦截及 admin 场景；仅改测试及必要测试 fixture，不改产品 UI。可拆为命名子用例以定位故障，每例新浏览器上下文，清理 `etf-shares:view-mode`，隔离模块缓存及请求计数。按行代码定位，不依赖排序后的 first()。关闭网络外逃，所有 API 请求都受 fixture 控制。

### 原断言意图到新 DOM 的映射

| 原意图 | 新做法与验收 |
| --- | --- |
| 默认列表、告警字段直渲染 | 等 `.nx-grid .nx-card`，按代码筛 article；检查四个 `.nx-limit`及 `.nx-limit-val/.nx-limit-mark`、`.nx-pill` 结论、收紧/放宽及倍率、账户单项变化。用快照 fixture，不依赖历史请求推导新字段。 |
| 告警数与快照更新 | `.nx-tile` 的监控/收紧/放宽/额度用满计数，`.filter-group` 的限额有变化筛选；calm 换快照后不残留旧结论。mixed 同时计收紧/放宽，按当前逻辑计算预期。 |
| 日期与状态 | `.nx-meta` 校验顶层 limitDate 优先、份额比较日期和抓取时间；旧快照回退各行最大值。stale fixture 显式返回 stale，断言本地缓存提示；empty/error 检查新文案与“重试”订阅增量。 |
| 沪深统一份额/额度语义 | 深/沪 `.nx-pill.code`、`.nx-delta`、总份额、`.nx-full` 额度用满及 full 筛选和统计；含负值、零、缺失、暂停（“仅赎回”）。百分比利用率的直接显示见下方替代项。 |
| 键盘开详情与关闭卸载 | 在指定卡片内以 `getByRole('button', { name: /PCF 清单/ })` 按 Enter；定位具指定基金名称的 dialog，校验 aria-modal、标题关联。用“关闭”、Esc、点击遮罩测试卸载；pending 请求释放由客户端行为验证，不再点击原 toggle。 |
| 抽屉 14+3+环比四行 | dialog 内 `#shares-detail-CODE`；保留 `.limit-compare .pcf-kv-row` 四行、before→after/ratio/持平/不可比、行内限额日期；保留 T 日 14 行、P 日 3 行、单账户 0/不限/unknown、允许状态、IOPV 不作金额依据。region 的 aria-labelledby 改指向 `nx-modal-title-CODE`。 |
| 单详情、缓存与请求拆分 | 同时至多一个 dialog；先关再开另一 code。完整新快照首屏无详情请求；打开只新增当前 code、row.limitDate（缺失回退快照 date）的请求，关闭重开复用缓存。快照刷新只增加 shares 订阅；以操作前后增量验收，避免全局固定计数。 |
| 错误、空数据、重试 | 详情 error/empty 场景保留环比小节；手动“重试读取”才增加该详情请求。完整新快照场景不允许其它 code/date 请求；区分看板 fallback 的一次重试。 |
| 表格切换、筛选搜索 | 点 title=表格的切换按钮，等 `.nx-table tbody tr`，检查四类限额、份额和 PCF 按钮；再切卡片及刷新验证偏好。全部/有变化/额度用满/深市/沪市计数、搜索/清空、不匹配新文案；操作不触发额外详情。 |
| 手机卡片 | 390×844 下等 `.nx-m-row`，核对代码/结论、限额变化和份额三行、`.nx-m-full`；点条目开 dialog，详情断言复用。按 640/641px 验证分支、无水平溢出、切换时无重复请求；检查实际保留的 dialog 状态。 |
| admin 挂载 | 保留 #shares tab/hash、#radar 切换及 history 不膨胀、非 admin 可见性；在 `.shares-panel.nx-panel` 内确认当前看板渲染。 |

### 无法一一映射的断言与替代方案（不得静默删除）

- **所有快照零预取：** 保留为“含完整 limitChanges 的新快照”首屏/搜索/筛选/切视图/刷新零额外详情请求。现有 data 中 513 旧记录、calm 的 null 与 legacy 会触发 fallback，不能混入零预取场景；为零预取场景补完整预计算字段，为旧数据另建 fixture。旧数据按每个可见 code 的 limitDate + previousSession 精确拦截，检查 source/date、客户端去重与最多一次失败重试、切筛选不扩散到不相关 code。旧快照零预取本身无法与当前产品同时成立；若必须保留为硬要求，单列产品修复后续任务，不在本次改生产代码掩盖。
- **百分比利用率/估算与确定申购/上期总份额：** 新看板不直显这些字段。UI 验收转为沪深一致的 delta、总份额、暂停和 atLimit 徽章；原百分比、creationSharesKind 等计算语义在 projection/schema 测试保留或补边界覆盖。需要展示链路的断言可单独挂载仍导出的 LegacySharesPanel，明确它只是旧组件覆盖，不能声称新默认页展示了这些字段。
- **五列表格、三态数值排序、140/112px 条形图、净流入汇总、旧告警胶囊/空告警条、禁止 KPI/箭头：** 新看板已用九列表格、结论优先排序、统计 tile 和四类限额变化取代。改验当前结论排序、同类稳定顺序、筛选和两视图数据一致；禁止金额估算仍保留。旧的像素/文案契约不再作为默认页验收，必要业务计算交共享单测，不强迫 UI 回退。
- **整行手风琴、aria-expanded、860px CSS 隐藏同一表格 DOM：** 改成按钮开独立 dialog、标题关联与关闭后卸载、640px React 分支；跨端仍验证当前详情和订阅无泄漏。
- **旧页尾三条说明、partial 自动显示旧“滞后”横幅、上一限额日 title：** 当前默认页无对应 DOM；保留详情 IOPV 说明、显式 stale 提示和 `.nx-meta` 日期。旧快照无告警也不能继续断言，因为新看板会计算 fallback 结果。

先梳理原用例每条 assert，并标注“直接映射／替代／仅旧组件覆盖”，提交审查能追溯全部原意图。测试可拆分，但不得以 skip、延长超时或仅测 LegacySharesPanel 代替默认看板验收。

**验收命令：** `node --test test/etfSharesDetailUi.test.mjs test/sharesWorkspaceRedirect.test.mjs`。Chromium 缺失时先使用仓库既有 Playwright 安装方式准备本地浏览器；不得连接线上 UI 代替 fixture。

**完成判据：** 默认桌面卡片、表格、移动和 admin 均执行，映射表有对应断言，完整快照零预取与旧快照 fallback 分开验收，原大用例不再 Timeout。

**风险与回滚：** 后台 fallback 污染请求数量、localStorage 和模块缓存串例、请求未拦截导致访问线上。独立上下文和完整路由拦截，等待明确 UI/请求状态而非任意 sleep；仅 revert 测试提交即可回滚。

## Phase 4：全量验证、审查与提交推送

在隔离 worktree 中执行，保存每条命令退出码及测试汇总：

```bash
node --test test/etfPcf*.test.mjs test/etfSharesDetailUi.test.mjs test/sharesWorkspaceRedirect.test.mjs
npm run check:refactor
npm run lint -- --quiet
git diff --check
```

- 相关套件全部通过，无 skip 掩盖原失败；基线 175 个若因拆分/补测变化，报告新总数及原因。B 修改共享 schema 时同步覆盖 shares/detail client、API、scheduled 等 glob 已包含的回归。
- `check:refactor` 既有两项基线失败：`NotifyExperience.jsx` 932 行、`workers/ocr-proxy/src/index.js` 287 行超预算。本次不修、不放宽预算、不新增失败、不增加这两文件行数；比较修复前后输出，并在提交说明中记录。其它检查必须通过。
- 审查 `git diff --stat`、`git diff`、`git status --short`，只允许计划、相关测试与 B 所需投影路径改动；确认无前端产品代码、Worker 配置、秘密、线上原始 bundle、无关文档或构建产物混入。完成 Phase 0 逐字段差异审查。
- 用显式文件路径 `git add <逐项审查的文件>`，按 A/B/C 分提交便于回滚；禁止 `git add .`。提交前在最终整合树重跑上述验收。
- 在唯一协调者管理下把隔离分支提交合入 cn；先 fetch 并核对 fork remote 所有者和 cn 远端状态，有并行提交则整合后重跑验证。推送命令为 `git push <已确认的fork-remote> cn:cn`，不假定 origin 一定是 fork，不强推。
- 不运行 worker:deploy、wrangler deploy、生产回填或手工前端 release。报告 commit SHA、远端 cn SHA、测试结果、两项 guard 基线与线上残余差异；只观察 push 触发的 autorelease 状态。

**完成判据：** 所有阶段达标、相关测试全绿、lint/diff 检查通过、guard 仅既有两项且未恶化，提交已安全推送 fork/cn；Worker 生产状态未修改。

**回滚：** 未合入时在独立分支撤销本任务提交；已推送则对本任务提交 `git revert` 并按相同检查再推送，禁止 reset/force push 改写共享历史。前端 autorelease 若异常按仓库既有回滚流程处理发布，由发布负责人执行；本任务没有 Worker 部署可回滚。
