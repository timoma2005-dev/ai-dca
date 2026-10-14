# 管理员雷达页 UI / 交互改版实施计划

## 1. 范围与依据

- 仓库：`/home/hatch/workspace/ai-dca`；核实分支：`cn`。本轮仅新增此 plan，不修改实现、后端或现有测试。
- 权威需求：`/home/hatch/workspace/radar-redesign-demo/DESIGN.md`；视觉与交互参考：同目录 `index.html`，已读取布局、时钟、排行、模态确认与模拟计算逻辑。
- 现有实现：`src/pages/AdminRadarExperience.jsx`；边界以根目录 `AGENTS.md` 为准。保留管理员门控、真实 API 数据结构、既有份额新增 Tab；不把原型假数据、模拟时钟、评审控制条带入生产。
- 目标：时段分级确认、可解释的空态流水线、数据日期与秒级倒计时、桌面 7:4 双列与移动单列。改版不引入行情详情请求或新的后台预取。

## 2. 后端事实与设计调和（实施定案）

核实文件：`workers/notify/wrangler.toml`、`workers/notify/src/accountEntry.js`、`workers/notify/src/nasdaqRadar.js`。

| 项目 | 当前真实行为 | 前端方案 |
| --- | --- | --- |
| 读取 | GET `/api/notify/nasdaq-radar` 只读 KV `nasdaq-radar:latest`；返回 `{ok:true,data}`，缺数据或读取异常可返回 null | 成功无数据进入空态；不能仅凭 null 判断“Worker 尚未运行”或“KV 正常” |
| 手动计算 | POST `/api/notify/nasdaq-radar/compute` 固定调用 `computeNasdaqRadar(env,{force:true})`，不解析风险等级或测试标志 | 所有确认路径都是同一个真实写入接口；前端不发送无效的 test / dryRun 参数 |
| force | 绕过法定节假日检查和同日幂等保护；可同日覆盖 | 常规确认也说明会覆盖当日正式快照，并非只读重算 |
| 写入 | 先写 `nasdaq-radar:feature-history:v1`（保留 90 条），有效 ETF 至少两只后写 latest 和 `nasdaq-radar:history`（同日替换，保留 20 条） | 风险说明涵盖价差历史及特征历史；计算失败不能承诺“未写任何数据” |
| 定时 | 配置入口是 accountEntry；cron `35 13 * * MON-FRI`，即北京时间工作日 21:35；调用不带 force | 文案为“工作日 21:35 计划触发，节假日可能跳过”；21:36 是预期完成时间，不是另一条 cron 或完成 SLA |
| 幂等 | 非 force，当天价差历史与特征历史均存在，且 latest 能读到非空值时，返回 latest、不重新采集；缺一项仍可重算 | 风险用“可能使今晚任务复用当天快照，无法自动纠正”，不写成无条件跳过 |
| 净值证据 | 排名使用 fundmob price 与 latestNav 自算溢价；当前未验证净值日期与价格是否同日；返回的 date 是计算日 | 21:35 后只称“已到计划计算窗口”，不称“净值已就绪”；基准条显示“YYYY-MM-DD 雷达快照 / 收盘口径，净值日期未验证” |
| 权限 | 这两个测试路由在账户鉴权前直接放行，管理员限制目前来自 UI | 保留 isAnalyticsAdmin；明确前端确认不能阻止绕过 UI 的请求，不把本次视作后端鉴权上线 |

**本期采用前端分级拦截、后端不动。** 保留盘中复选框后二次执行能力，但危险按钮改为“强制覆盖正式数据”，复选框为“我已知晓会覆盖正式快照及历史，并可能影响今晚自动更新”。成功提示为“已强制计算并写入正式快照”，删除“仅供调试 / 已标记测试数据”的承诺。三项风险对应净值与现价错配、20 条价差与最长 90 条特征历史污染、定时幂等复用；不承诺污染一定持续 20 个自然日或无法通过后续强制重算修复。

设计与原型还有一处差异：原型把所有非盘中操作导向普通确认，DESIGN 要求 15:00–21:35 等待。以 DESIGN 为准，本期等待窗口展示建议与“知道了”，不提供计算确认；确有盘前、休市日调试需要时沿用危险确认，避免误称安全期。

若后续必须实现真正的“测试数据”，另立后端变更：接口明确支持 dry-run（只返回不写正式 KV），或独立 test 命名空间，latest/history/feature-history 全部隔离；正式幂等、分位及成熟度均排除测试记录，返回显式模式字段，服务端校验权限与净值日期，并覆盖对应 Worker 测试。仅在前端加测试标签不能满足该需求。本期不包含这些改动。

## 3. 时间、边界及新鲜度

所有判断绑定 `Asia/Shanghai`，与操作系统时区无关。抽纯函数接受 epoch 毫秒；可以用 UTC+8 平移提取 UTC 日历字段，再以 `Date.UTC(年,月,日,21,35)-8小时` 构造目标，禁止直接复制原型浏览器本地 `setHours`。日期进位交给 UTC 日历运算，覆盖月末、年末、闰日。

### 3.1 时段表

首先使用现有 `src/app/holidaysCN.js` 的交易日判断；非交易日优先进入休市风险状态。未知年份不能把缺失假期表视为已确认交易日，显示“交易日历待确认”，计算走危险确认，不新增日历接口。

| 北京时间（交易日） | 状态与标识 | 点击计算 |
| --- | --- | --- |
| [00:00:00,09:30:00) | 盘前；当日收盘数据未形成 | 危险确认，说明后端仍写今天日期，不能拿昨日净值当今天收盘 |
| [09:30:00,15:00:00) | 盘中风险窗口 | 红黄风险说明，勾选后方可强制覆盖 |
| [15:00:00,21:35:00) | 收盘后等待净值披露 | 等待提示，建议 21:35 后再操作；零 POST |
| [21:35:00,24:00:00) | 已到计划计算窗口；净值日期未验证 | 常规确认，说明净值披露可能延迟及正式覆盖行为 |
| 非交易日 / 日历未确认 | 休市 / 日历风险 | 危险确认；后端 force 会绕过假期检查 |

09:30:00 属于风险窗口；15:00:00 进入等待；21:35:00 进入常规确认。11:30–13:00 午休仍纳入连续风险区间，这是计算防错窗口，不是撮合时段精确描述。界面可显示“盘中风险窗口（含午休）”。盘前及休市分级是对原型“21:35 至次日 09:30 均安全”的纠偏，因为后端按当前自然日写日期。

### 3.2 倒计时与基准条

1. 当天北京时间 21:35:00.000 为初始目标；`now >= target` 则改为下一自然日 21:35，精确到达时立即显示 24:00:00，21:35 前一秒为 00:00:01。
2. 每秒从最新 `Date.now()` 重算差值，不逐秒减计数；显示 `floor(max(0,target-now)/1000)`，格式 HH:mm:ss。标签随目标显示“距今日 / 明日 21:35”，附日期及时区。
3. 保留需求指定的“次日”自然日倒计时，不暗改为下一交易日。目标日非交易日附“该日可能不执行定时计算”；显示计划时间不代表任务会成功更新。
4. 时钟只在管理员雷达 Tab 活跃时运行；卸载清理 timer 与 visibility 监听，回到前台立即重算。到零、秒级 tick 和时段切换都不触发 GET / POST。
5. 新鲜度使用 `data.date` 与 `computedAt`，不使用浏览器今天伪造基准。结合本地交易日历推导预期快照日：交易日 21:35 前预期上一交易日，之后预期当天；休市日预期最近交易日。日期落后显示“待更新”，未来日期或畸形日期显示“日期异常”。盘前/盘中计算的 computedAt 若可辨识则附风险提示，但不能据此认证数据来源或完整性。
6. 本地收到时间、计算时间与快照日期分开；旧数据读取成功不会自动变“新鲜”。缺日期显示“基准日期未知”，缺 computedAt 显示 `—`。

## 4. 布局与组件设计

沿用外壳 `max-w-6xl` 与 `PageTabs`，移除 RadarPanel 内部 `max-w-lg`，用 Tailwind `grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] items-start`；`lg` 为 1024px，与原型一致。小于 1024px 单列，1024px 及以上双列。列及卡片用 `min-w-0`，窄屏标题可换行、数值不挤出视口。

- 全宽顶部：标题 / 测试版标识、新鲜度横条、倒计时及时段胶囊。
- 左栏 DOM 顺序：最优机会 Hero → 分位条 → ETF 排行 → 列表下方内联轮动建议。右栏：计算控制台 → 预期流水线 → 数据成熟度 → 近期机会。移动端按上述左栏、右栏顺序排列，顶部保留同一计算入口方便触达。
- 空态：左栏说明暂无可用快照并提供四阶段流水线与受保护入口；右栏控制台保留，成熟度及历史显示缺数据，不展示假值。避免重复两份流水线。
- 四阶段为 15:00 收盘、21:00–21:30 净值通常披露、21:35 计划触发、约 21:36 预期完成。时间只能决定“预期阶段”，没有运行日志接口就不显示“已运行 / 已入库”实况；只有有效快照能证明已有结果。
- 骨架屏复用单双列结构；加载失败独立于空态，提供“重新读取”，有旧数据时保留卡片并显示读取错误。计算失败不清空此前有效快照。
- `rounded-2xl` 卡片、`rounded-xl` 内部区块、`rounded-full` 标签；indigo/violet 紫色 Hero 和主按钮，rose 卖出、emerald 买入、amber 风险，slate 中性色；百分比、代码、时钟全用 `tabular-nums`。使用现有 Tailwind / cx / UI Dialog，不引入原型整页 CSS、字体或依赖。
- 排行使用后端返回有效标的，当前候选全集是 12 只，不能硬编码原型 8 只或 159969。展示实际 N，只在有效返回集合中选最高/最低，文案为“当前有效标的中最低溢价”。负溢价、并列、全部相同可正常显示；平局按代码稳定排序，单标的不显示买卖套利对。
- 分位沿用现有 `historyDays >= 5` 展示门槛与 85 分位关注提示，标注实际样本数、最多 20 条；缺失不是 0 分位。成熟度安全读取 enabledWeights 数组，强调“历史覆盖 / 已具备的权重组”，后端注释表明评分尚未启用，不新增已评分的承诺。
- 轮动建议选择、重复点击关闭、点击最低者显示无需切换；差价来自当前快照 premium，标注“溢价差（百分点），未计交易成本”，不把“省 X%”当保证收益。刷新后重算选中项，代码消失则清除选择；从列表到建议可温和滚动，遵循 reduced-motion。

建议拆分组件：RadarPanel 只编排；RadarFreshnessBanner、RadarOpportunityCards（Hero / 分位）、RadarRanking（含内联建议）、RadarSidebar（控制台 / 流水线 / 成熟度 / 近期机会）、RadarComputeDialog。共享纯函数放 `src/app/*`，表现层放 `src/pages/radar/*`，不向 MarketsExperience 填逻辑，保持 refactor guard。

## 5. 状态机与请求生命周期

### 5.1 数据与交互状态

- 读取状态：`idle → loading → ready | empty | error`，另保留 lastValidData、readError，区分首次失败与旧快照读取失败。无 bestPair 但有 etfs 为 partial，排行仍可见，Hero 显示缺失。
- 计算状态：`idle → waitingNotice | regularConfirm | riskConfirm → submitting → success | failure → idle`。waitingNotice 只能关闭；riskConfirm 每次打开均复位 acknowledged=false；所有入口共享状态，submitting 期间禁用全部计算入口。
- 确认前重新读取当前时间和管理员权限：时段/日期改变则重新分流并清除风险勾选，不能让已开常规弹窗跨入盘中后直接提交。POST 用同步 ref / promise 锁防同一帧双击，不能仅靠下一次 render 的 disabled。
- selectedCode 独立于 data；成功以返回真实数据原子替换。通知 aria-live 仅播报结果与错误，不每秒朗读倒计时。

### 5.2 网络与缓存

- 保留 GET 的 `apiUrlWithFallback` / `fetchWithFallback`、redirect manual 与重定向拒绝；不带 credentials，避免已有跨域限制。校验 HTTP、JSON、业务 ok 和 shape，兼容历史 GET 缺 ok 但有效 data 的返回；显式 ok:false 必须视为失败。
- 新增单一 radar client：按解析后的 API 地址隔离 memory/inflight，短 TTL 定为 60 秒；校验 premiumSource=`eastmoney-fundmobapi-nav`、日期格式、有限数值及集合形态。缺失可选字段局部降级，错误 source / 无有效内容不冒充成功数据；不新增 localStorage 持久化或读取 R2。
- 挂载、重试、Tab 回切共用 client；同 key 共享 GET，组件以订阅/请求代次防止旧结果写回。StrictMode effect 重建可复用 pending GET；单个订阅卸载不 abort 其他订阅的共享请求。未共享的请求须有 AbortController，任何卸载后的结果不得写组件状态。
- 权限丢失和 Tab 切换清理订阅、timer、弹窗；零消费者时不启动新请求。TTL 过期只在下一次激活或明确“重新读取”时校验，不轮询。读取缓存先 memory/inflight，Worker GET 再读 KV，小快照足够，不经过详情历史或 R2。
- POST 仅管理员确认事件触发，保持现有 `apiUrl` 单次 POST；不对写操作使用自动 fallback / 自动重试，超时可能已写 KV。失败展示“结果未确认，请重新读取核实”，GET 重读与再次计算必须是不同动作。
- 成功要求 HTTP 正常、ok:true 且 data 可消费，直接用返回值，更新相同 key 的 memory，不额外 GET；使提交前的 GET 代次失效，防止旧 GET 覆盖计算结果。ok:true/data:null 显示无有效结果，不报成功。
- 首次读取、刷新、倒计时、排行榜选择和弹窗打开均不得触发 compute；也不得新增 quotes、kline、NAV 快照/历史、财务、raw detail、AI summary 或申购限额请求。份额面板仍仅 activeTab=shares 时挂载，雷达不预拉它的数据。

### 5.3 Dialog / Sheet 生命周期

移动端小于 640px 的确认框从底部弹出；640px 及以上使用居中 Dialog。复用 Radix 焦点管理、Esc / 遮罩关闭、DialogTitle / Description；移动浮窗限制 `max-h-[90dvh]`、正文可滚动、按钮留安全区 padding。

统一稳定 source=`admin-radar-compute`：打开底部浮窗必须调用 `setMobileBottomSheetOpen(source,true)`；所有关闭路径（取消、Esc、遮罩、确认提交、权限变化、Tab 切换、卸载）调用 `setMobileBottomSheetOpen(source,false)`。通过统一 open 生命周期与 effect cleanup 管理，不散落在按钮里。窗口跨越 640px 时同步当前形态，保持 openSources 无泄漏；禁止全局清空其它 source。提交前关闭弹窗恢复导航，控制台显示 loading。列表下的轮动建议为内联展开，不是底部 Sheet。

## 6. 改动文件清单

以下均是后续实施拟改文件；本轮仅创建本 plan。

| 文件 | 计划改动 |
| --- | --- |
| `src/pages/AdminRadarExperience.jsx` | 保留管理员及 active Tab 挂载，替换为提取后的 RadarPanel，删除旧内联卡片/请求逻辑 |
| `src/pages/radar/RadarPanel.jsx` | 双列编排与空态、骨架、错误、partial 管理 |
| `src/pages/radar/RadarFreshnessBanner.jsx` | 日期、时段与倒计时 |
| `src/pages/radar/RadarOpportunityCards.jsx` | Hero 与分位条 |
| `src/pages/radar/RadarRanking.jsx` | 排序、候选标识、内联切换建议 |
| `src/pages/radar/RadarSidebar.jsx` | 控制台、四阶段流水线、成熟度、近期机会 |
| `src/pages/radar/RadarComputeDialog.jsx` | 等待 / 常规 / 风险确认与底部导航联动 |
| `src/pages/radar/useRadarData.js` | 读取、计算生命周期与 stale response 防护 |
| `src/pages/radar/useRadarClock.js` | 秒级本地时钟与清理 |
| `src/app/radarModel.js` | 时间/日期、新鲜度、数据校验与显示派生纯函数 |
| `src/app/radarClient.js` | memory/inflight、地址隔离、GET 与单次 POST |
| `test/radarModel.test.mjs`、`test/radarClient.test.mjs` | node 单测新增 |
| `test/e2e/admin-radar-redesign.spec.js` | 改版交互、布局、请求计数与导航验收新增 |
| `test/e2e/admin-radar-shares.spec.js` | 必要的雷达 mock 协议调整，保留份额与权限回归 |
| `docs/plan-radar-redesign.md` | 实施中补验收结论与实际命令结果 |

复用不修改：`src/app/mobileBottomSheet.js`、`src/app/holidaysCN.js`、`src/components/ui/dialog.jsx`、`EtfPcfSharesPanel.jsx`。本期 Worker 实现及 wrangler 配置不动。

文档整理作为后续实施的独立步骤：根目录目前额外存在 `README_ANALYTICS.md`、`POSTHOG_INTEGRATION_COMPLETE.md`、`DATA_ANALYSIS_REPORT.md`，分别迁至 `docs/analytics/README_ANALYTICS.md`、`docs/analytics/POSTHOG_INTEGRATION_COMPLETE.md`、`docs/analytics/DATA_ANALYSIS_REPORT.md`，用 rg 查引用并修正相对链接。只迁文档，不删内容；根目录 Markdown 最终只保留 README.md、CLAUDE.md、AGENTS.md。本轮不执行迁移，避免超出“只出 plan”的范围。

## 7. 实施顺序与验收

1. 锁定上述调和文案与实际 API fixture；先完成纯函数、client 及对应行为测试。
2. 提取 RadarPanel 和组件，接入真实快照，完成 responsive / empty / partial / error；删除不再被消费的旧状态、props、effect 和函数。
3. 接入本地时钟、确认状态机、同帧锁、过时响应防护及底部导航生命周期。
4. 增加浏览器交互/请求次数测试与移动/桌面截图，回归份额 Tab，迁移文档并修复链接。
5. 运行以下验收。失败先区分本次回归与已有基线，记录失败项，不能把既有失败报成通过；不部署或提交到远端作为本计划的隐含动作。

### 单元测试清单

- 时间：不同系统时区结果一致；09:29:59 / 09:30:00、午休、14:59:59 / 15:00:00、21:34:59 / 21:35:00；午夜、月末、年末、闰日；休市与未知日历年份分级；倒计时目标次日而非下一交易日。
- 数据：null 空态、畸形 JSON、显式 ok:false、partial、缺 maturity/weights/percentile/date、非法及负数、并列排序；实际 12 只或更少，缺字段显示 `—`，不补假数据或发重请求；历史门槛 4/5、分位 84/85。
- client：缓存命中零 fetch、60 秒边界过期、source 不匹配、异常时间/形态、不同 API 地址隔离、写入 key 防御（返回 code/source 不得改变缓存 key）；inflight 复用、拒绝后可重试、老 GET 不覆盖 POST 成功结果。
- POST：仅一次、无自动重试/fallback；网络/HTTP/业务失败、ok:true/data:null 与成功写 memory；错误保留旧快照。不引入 forceRefresh 于普通渲染。

### 浏览器行为与“不会调用”测试

- 非管理员零 radar/shares/compute；只加载 active Tab；StrictMode / 快速切 Tab / 多入口重试去重，卸载后的返回不渲染旧数据。
- 盘中未勾选、取消、关闭以及等待窗口均零 POST；重新打开风险框重置勾选；勾选确认才 POST 一次；常规确认前零 POST，双击同帧零重复；弹窗跨时段重新分流。
- 成功日期来自 response，失败不伪造今日基准；计算时各入口同步 disabled；本地 tick / 到达 21:35 / 选择 ETF / 打开弹窗均零额外请求；成功后不跟随无必要 GET。
- 全流程 heavy 请求计数为 0，覆盖 NAV 快照、kline、财务、AI、申购限额等；隐藏份额 Tab 零 shares 请求，轮动建议纯本地计算。
- 640px 以下底部浮窗开启隐藏导航，取消/Esc/遮罩/确认/切 Tab/卸载后恢复；跨断点正确同步；有其它 source 打开时不能恢复其导航。
- 320、390、768、1023、1024、1440px 验证单双列、7:4 比例、无横向溢出、按钮安全区与长文滚动；键盘选行、Dialog 焦点捕获及回归、Tab ARIA、颜色对比、reduced-motion。

### 必跑命令（后续实现提交前）

```sh
node --test test/radarModel.test.mjs test/radarClient.test.mjs
node --test workers/notify/test/nasdaqRadar.test.mjs
node --test test/etfPcfSharesClient.test.mjs test/etfPcfSharesDates.test.mjs test/mobileBottomNavConfig.test.mjs
npm run check:refactor
npm run lint -- --quiet
npm run build:app
npx playwright test test/e2e/admin-radar-redesign.spec.js test/e2e/admin-radar-shares.spec.js --project=chromium
git diff --check
```

Playwright 前构建，避免使用旧 build。Worker 雷达测试是基线验证，不在 UI 改版中静默修改断言：当前幂等测试只 seed history/latest、没有当天 feature-history，与现行幂等条件不一致；源请求计数也可能受新特征采集影响。若运行失败，单独记录并安排测试维护，不削弱前端确认验收。

## 8. 风险与交付边界

| 风险 | 处理与限制 |
| --- | --- |
| 前端不能防止直连写接口、多浏览器并发 | 保留 admin 门控与明确危险确认；本期不宣称服务端防护、全局互斥或正式鉴权已实现 |
| 21:35 不是净值同日证据 | 标签使用计划窗口；date 是计算日期，避免无条件称当日已核验收盘；净值日期校验留待后端专项 |
| 夜间/盘前跨日期、周末手动计算 | 自然日倒计时与计算风险分开；盘前、休市/未知日历使用高危确认 |
| feature 写入先于排名校验且 KV 多 key 非事务 | 失败只表示计算未确认；提供 GET 核实，不能承诺回滚；恢复需后续明确强制重算 |
| 秒级 re-render、Tab 切换导致重复请求 | clock 与 data effect 分离，client inflight + memory 与响应代次管理；零隐式轮询 |
| 原型 8 只假数、权重示例及流水线进度误导 | 只使用真实有效标的、实际历史覆盖，流水线明确标“预期”；缺失本地短路 |
| 移动底部按钮被导航遮挡 | 统一 source 注册/清理与安全区，覆盖每条关闭路径和响应式切换 |
| 已有测试与根目录文档基线不一致 | 测试结果明确记录，文档迁移单列步骤并维护链接；不把规划当已实施 |

完成标准：四项设计痛点均有对应模块和交互；后端事实与时间边界在 UI 文案中准确表达；不会调用的测试通过；相关单测、refactor、lint、浏览器验收与 diff 检查有可追溯结果；实现无未使用预取与根目录新增文档。

## 9. 本轮文档交付的基线检查（2026-10-14）

本轮没有实现代码变更，运行现有检查的结果如下，作为后续实施的基线，不能代表改版已验收：

- `node --test workers/notify/test/nasdaqRadar.test.mjs test/etfPcfSharesClient.test.mjs test/etfPcfSharesDates.test.mjs test/mobileBottomNavConfig.test.mjs`：29 项，26 通过、3 失败。失败均在原有 nasdaqRadar 测试：两项断言总 fetch=1，实际因特征采集为 4；一项幂等 fixture 缺当天 feature-history，实际重新请求而非复用。其余相关测试通过。
- `npm run check:refactor`：失败；已有 `workers/ocr-proxy/src/index.js` 为 262 行，超过 250 行预算。
- `npm run lint -- --quiet`：失败，已有 12 个错误，分布于 networkTrace.js（5 个未定义变量）、account-data-migration-modal.jsx（1 个 Hook 调用）、CnHomeExperience.jsx / DataRepairExperience.jsx / NotifyEventDetailDialog.jsx（共 4 个空块）、NewPlanSelectionCards.jsx（2 个未转义引号）。本轮未修改这些文件。
- `git diff --check`：通过；另需针对新增未跟踪文件执行 `git diff --no-index --check /dev/null docs/plan-radar-redesign.md`，因为普通 diff 不包含未跟踪文件。
- 本轮未运行 build / Playwright，尚未新增计划中的测试或页面实现。基线问题后续单独维护，不在此次 plan 交付中修改代码。
