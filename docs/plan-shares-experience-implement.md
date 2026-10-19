# SharesExperience 直接替换实施计划

日期：2026-10-19；工作目录 `/home/hatch/workspace/ai-dca`；分支 `cn`。

本次交付仅为计划。后续实施已确定直接替换旧份额页，不保留双实现、迁移开关或旧布局。数据客户端、shared schema/calendar、Worker 均只读，不新增接口、不修改缓存协议。本计划不授权提交或 push。

依据依次为 `docs/plan-etf-pcf-shares-ui-v2.md`（含核验注记）、两张截图、真实代码与 AGENTS.md。核验注记中的“先确认是否重写”已由用户“直接替换”决定覆盖。

## 1. 规格名 → 真实模块（逐节映射 §2–§7）

| 规格章节 / 假设名 | 真实模块 / 落地位置 | 必须改写之处 |
| --- | --- | --- |
| §2 `SharesExperience.jsx`、`shares-experience.css` | 将新建于 `src/pages/` | 当前并不存在；替换而非在旧组件上叠加 |
| §2 Workspace lazy 挂载 | `src/pages/WorkspacePage.jsx` 当前 lazy 导入旧组件 | 保留 lazy/Suspense 方式，仅替换路径和组件名；补上规格遗漏的 `AdminRadarExperience.jsx` 直接 import 挂载 |
| §2、§5 `src/app/etfPcfShares.js` / `sharesSnapshotStore` | `src/app/etfPcfSharesClient.js` 的 `sharesClient` | 假设模块和 store 不存在；消费 `subscribe({date})`，不得新造同名数据层 |
| §2 `workers/etf-shares` | 实际前端客户端的 `/api/etf-pcf-shares` 与 `/api/etf-pcf-limit` 契约 | 规格中的 Worker 目录不存在，不按该目录设计或改动后端 |
| §3 设计令牌 | 新 CSS 的 `.shares-panel` 根作用域 | 按截图落地；reduced-motion 也限定本面板，不关闭全站动画 |
| §4.1 页面、筛选、统计、排序 | 新 JSX 中的 `SharesPanel` 与局部纯展示函数 | 删除旧 KPI、十列表、ResizeObserver 布局状态；统计只用快照有效行 |
| §4.2 `ceilingStatus`、`formatYi` 等 | `sharesCeiling`、`creationLabel`、`limitLabel` 等真实 helper；新 JSX 内局部格式化 | 不存在的 helper 不作为 import；状态直接用 `sharesCeiling(row)`，不重写判定语义 |
| §4.3 `previousSessionDate` / `pcfLimitStore` | `shared/etfPcfSharesSchema.js` 的 `previousSession` / `src/app/etfPcfDetailClient.js` 的 `pcfDetailClient` | 历史标签与抽屉必须复用同一 singleton、同一 code/date key |
| §4.4 `buildPcfDetailSections` | `pcfDetailSections(p)` | `sections[1]` 为 T 日、`sections[0]` 为 P 日；真实为 10+3 行，改写规格 9+3 及验收 12 行假设 |
| §5 `shanghaiToday()` | `shanghaiAccessDay()` | 上海访问日用于 rollover/cache 分区，不能直接当份额统计日或 PCF 日 |
| §5 快照 / 日历校验 | `validateSharesProjection`、`previousSession`；`shared/etfPcfTradingCalendar.js` 的 `confirmedSharesCalendar(from,to)` | UI 信任已校验快照，fixture 用真实 builder；不存在 `buildVerifiedTradingCalendar`。日历不支持时返回空，不以周一至周五猜测 |
| §6 三档视图 | 新 CSS 的单一 `860px` viewport 断点 | 只有桌面表格与移动卡片两种表现，同一 DOM；不保留旧 compact/wide/table JS 分支 |
| §7 a11y | 新 JSX 原生按钮、表头、展开 region 与新 CSS | 无视图按钮；筛选保留 aria-pressed，排序/展开各自有语义，见下文 |

## 2. 视觉依据与边界

- PC ground truth：`/home/hatch/workspace/user/media_library/image/c3/c363a2c05e3bcf728a777372c0a86dc9d7e81273ad0a64a2f5e95d0e22ceaae4.png`。保留紧凑信息栏、琥珀告警胶囊、六档分段筛选、右侧搜索、五列表格、浅暖行背景、右侧明细按钮。截图数字和简称只是演示，展示真实 records，不硬编码截图值。
- 移动 ground truth：`/home/hatch/workspace/user/media_library/image/9c/9c7b4eef8cf6c22051e26bb1eea7af190a71b53db3993cf94835f6db7bd95ffd.png`。头部自然换行成为紧凑信息块，告警胶囊隐藏简称，工具栏筛选可横向滚动、搜索另起一行；卡片中代码/操作、净增/总份额、限额依次排列。
- 移动截图顶部应用栏和底部“美股策略助手”导航属于外壳，不复制、不重写。面板不新增固定底部操作区。
- 截图把 stale 横幅放在告警条后，正文 §4.1 写在告警条前；采用截图顺序：信息栏 → 告警条 → stale 横幅 → 工具栏 → 主体 → 口径说明。桌面新鲜数据无横幅。约 50px 的信息栏目标适用于桌面，不能套用到移动端。
- PC 截图裁切范围只显示约六行；“首屏 8+ 行”是密度目标，不为实现该数字压缩到偏离截图。验收同时记录 viewport、缩放和首屏可见行数。

## 3. 新文件与内部职责

只新增两个产品文件，展示辅助函数保留在新 JSX 内，不把纯 UI 逻辑塞进只读数据层。

| 文件 / 内部组件 | 职责 |
| --- | --- |
| `src/pages/SharesExperience.jsx` 默认导出 `SharesExperience` | 统一入口，渲染 `SharesPanel`，导入新 CSS |
| `SharesPanel` | 快照生命周期、日期 rollover、单行统计、告警条、筛选/搜索/三态排序、单展开行、状态视图及口径说明 |
| `UtilizationCell` | `sharesCeiling` 的七类徽章；有限上限及不同日的限额日期、不限额文案、沪市 pending；完全无利用率条 |
| `DeltaSharesCell` | 万份带正负号、exact/estimate 副文案、无数据“—/未比对”；净增对比条只装饰、不承担唯一信息 |
| `TotalSharesCell` | 本期与上期总份额（亿份，缺失为“—”），不得将 null 转 0 |
| `SortHeader` | delta/util/shares 三列的默认→降序→升序→默认；默认恢复快照顺序；缺失始终置底、同值按代码稳定排序 |
| `LimitChangeTag` | 仅告警条内的历史限额轻量增强；静默失败，不影响快照或抽屉状态 |
| `PcfDetailDrawer` | 选中后挂载的行内展开 region，订阅当前详情日 PCF；T/P 两卡片、状态与重试；沪市本地短路 |
| `src/pages/shares-experience.css` | 令牌、信息栏、徽章、表格/卡片、展开区、交互态、骨架、响应式及 reduced-motion |

CSS 所有选择器以 `.shares-panel` 为根（根本身亦可），不裸写 `table`、`button`、`.action-btn`、`.status-chip` 等全局规则。令牌全部定义在根：

| 令牌 | 值 / 用途 |
| --- | --- |
| `--primary` / `--primary-light` / `--primary-border` | `#4f46e5` / `#eef2ff` / `#c7d2fe` |
| `--slate-50` 至 `--slate-900` | 标准 slate 色阶，背景、边线、正文与次文案 |
| `--emerald-50/600/700` | `#ecfdf5` / `#059669` / `#047857`，净增与上调 |
| `--rose-50/600` | `#fff1f2` / `#e11d48`，净减与下调 |
| `--amber-50/100/600/700` | `#fffbeb` / `#fef3c7` / `#d97706` / `#b45309`，告警 |
| `--radius-sm/md/lg/pill` | `8px / 12px / 16px / 9999px` |
| `--shadow-subtle` | 低对比阴影，例如 `0 1px 3px rgb(15 23 42 / 0.06)` |

数字使用 `font-variant-numeric: tabular-nums`；数值约 15px，不恢复 27px 主指标。净增 `.delta-bar` 最大 140px，分母为全部快照有效 delta 的 `max(1, abs(...))`，筛选、搜索、排序不改变尺度。零不画填充、缺失不画条；此条与被否决的利用率进度条无关。

## 4. 快照、派生与订阅生命周期

1. 页面激活才挂载，`sharesClient.subscribe({date: 'latest'})`；不要用上海当天强行查指定统计日。初始 loading，若返回 `stale/staleReceivedAt` 则立即展示旧快照与滞后提示，随后消费 promise 的 `{state,data,receivedAt,reason}`。
2. `state` 不只 loading/empty/error/stale；成功为快照的 `complete/partial`，两者均渲染 records，partial 不伪装报错。404 empty 展示待流水线更新提示，搜索无结果与源数据 empty 分开处理。
3. effect 使用 active/generation 防迟到覆盖，清理必调 `release()`；共享 client 已负责 inflight、8 秒 abort 与缓存，不另写 fetch。监听器和定时器均清理，StrictMode 重挂载复用订阅。
4. 保留 `receivedAt+5min` 转 stale、`expiresAt` 到期清掉可展示快照并转 error 的 UI 定时降级；期限检查取实际时间，长 timeout 分段。`freshnessMessage(data, day)` 非空也需显示待确认，`partial`、抓取新鲜与业务日及时性分别处理。
5. `shanghaiAccessDay()` 初始化访问日；上海零点定时器、visibilitychange、focus 检查跨日并重新订阅，清除旧展开状态，防旧日响应串入。不得在 render 内触发请求或自动传 forceRefresh。
6. 刷新按钮/横幅重试仅递增 reloadCount 重新订阅；真实 client 没有强刷参数，5 分钟有效缓存或 30 秒 404 熔断可能直接返回缓存，UI 不宣称一定已向源站强刷。
7. 缓存继续由现有 client 承担 memory/inflight → localStorage → API 后端缓存链路，UI 不读取 R2、不新增持久化协议、不改 key。详情 client 只有内存缓存，不假设已有 localStorage；标签共享该能力，不另建 store。
8. 顶部基准日用 `data.date`，对比用 `data.prevDate`，缺失显示“—”；抓取时间用 `fetchedAt` 上海时区。title 使用 `snapshotLabel`，补充 `availableOn`、`pcfSnapshot` 及逐行 limitDate 的含义，不混淆份额统计日、发布日、PCF 日。
9. 净流入仅合计深市有限 deltaShares（有负值时参与净额），title 标有效样本数；告警数、行高亮与筛选统一依据 `sharesCeiling(row).kind` 为 at-limit/near-limit。over-limit 独立展示，不因 nearTotalLimit 为 true 自动纳入告警。监控数取 records 长度，13 只为契约而非填充虚拟数据。
10. 六档筛选为全部/顶格·接近/净增/净减/深市/沪市，计数基于完整 records；搜索代码或简称 contains，本地完成。排序键对应 deltaShares/utilization/shares。creationShares 为负或不可用不渲染申购数，不把 estimate 改成确定值。
11. 沪市份额/PCF 待接入本地短路；缺失值原样降级。不得请求行情、K 线、NAV 历史或金额估算数据；`deltaAmountWan` 恒 null，不引入相关 state/effect。

## 5. LimitChangeTag 的精确实现约束

- 只为当前挂载且可展示的告警条内深市 at-limit/near-limit 标的挂载标签，通常 0–3 只，但不硬编码截断。无告警、面板未激活、非告警行、沪市均不订阅；不对全 13 行 map 预取详情。
- 计算 `prevLimitDate = previousSession(row.limitDate, data.calendar)`，不是 data.date 的前一天，也不是 PCF 当前日的前一天；日历缺失、范围不足或无上一交易日则直接返回 null，不请求、不猜测。
- 当前 `row.totalLimitKind === 'limited'` 且 `Number.isSafeInteger(row.totalLimitShares)`、非负才允许订阅 `pcfDetailClient.subscribe(row.code, prevLimitDate)`。调用内部已经走 `/api/etf-pcf-limit?code=&date=`，复用抽屉同一个内存缓存与 code/date inflight，不独立 fetch、不另设 cache key。
- 仅当 result.state 为 ready，历史 payload 的 `totalSubscribeLimitKind === 'limited'` 且 `totalSubscribeLimitShares` 为非负安全整数时比较；不能仅凭数字存在反推 limited。客户端已校验 code/date/source，UI 仍须守住字段类型与口径，不把 null、字符串、unknown、unlimited 当 0。
- diff = 当前 totalLimitShares − 历史 totalSubscribeLimitShares。正值渲染 `.limit-change.up`「限额↑ N 万份」，负值 `.down`「限额↓ N 万份」（取绝对值），零 `.flat`「限额持平」。无数据/404/错误/过期不可用/口径不符静默不渲染，无空标签和错误横幅。
- effect 依赖 code、prevLimitDate、当前口径/数值，清理 `release()` 并拒绝迟到结果。缩放、排序或搜索不反复重建订阅；告警条存在时其标签仍属可展示内容。无重试轮询、无刷新时全量历史重拉。异常告警数量增多时采用组件内有界调度，不绕过共享 client。
- 这是用户明确要求的有限列表增强例外，不能扩展为列表预加载整份 PCF；历史未命中不再查询其他日期或重接口兜底。

## 6. PcfDetailDrawer

- 桌面与移动均为行内展开，单展开手风琴；按钮 id `shares-toggle-<code>`，区域 id `shares-detail-<code>`。折叠、筛选移除选中行、跨日或卸载时释放订阅，展开 key 包含快照日和 code，避免跨快照错配。
- 深市仅用户展开后 `pcfDetailClient.subscribe(code, date)`。详情 date 延续旧实现使用 `data.date`，不默默换为访问日或 `pcfSnapshot.date`；行内显式显示返回的 T/P 日期。此选择及其业务含义列入风险复核。
- ready 后调用真实 `pcfDetailSections(p)`，T 日取 sections[1]，P 日取 sections[0]；呈现 T 日全部 10 项（含申购/赎回允许状态）、P 日 3 项。允许/不允许从真实值呈现 ✓ 允许 / ✕ 暂停高亮，未知不推断。
- loading/empty/error 有独立文案；只有 error 的明确重试按钮递增 retryCount。P 日下方的公式仅为文字口径说明，并注明缺少 D 日官方净值凭证、不做金额估算、禁止使用盘中 IOPV；不计算或请求估算金额。
- 沪市即使用户展开也只展示“沪市 PCF 清单暂未接入”说明，不调用 subscribe。
- 名称虽为 Drawer，此计划不是底部 Sheet/Dialog，不需要遮罩或焦点锁。若以后改成底部浮窗，必须按 `src/app/mobileBottomSheet.js` 在打开/关闭/卸载调用 `setMobileBottomSheetOpen(source, true/false)`；本次不引入该变化。

## 7. 挂载替换与清理清单

| 位置 | 后续具体变更 |
| --- | --- |
| `src/pages/WorkspacePage.jsx:32` | 将旧 lazy 声明替换为 `const SharesExperience = lazy(() => import('./SharesExperience.jsx'));`，新文件提供默认导出；沿用外层 Suspense |
| `src/pages/WorkspacePage.jsx:613` 附近 | `case 'shares': return <SharesExperience />;`，不重定向、不改公共访问逻辑 |
| `src/pages/AdminRadarExperience.jsx:8` | import 替换为 `import SharesExperience from './SharesExperience.jsx';`，保持现有直接 import |
| 同文件 `#shares` tabpanel | 保留 `activeTab === 'shares'` 条件挂载，仅 JSX 名换为 `<SharesExperience />`；保持 hash 同步与非管理员可访问 shares，雷达权限不变 |

删除以下产品文件，且不留下后台预取、旧 props/state/effect、ResizeObserver 或无用刷新函数：

- `src/pages/EtfPcfSharesPanel.jsx`
- `src/pages/etfPcfShares.css`
- `src/pages/EtfPcfSharesDetail.jsx`
- `src/pages/etfPcfSharesView.js`

测试同步：

- `test/sharesWorkspaceRedirect.test.mjs`：读取 WorkspacePage 源码的断言改为 SharesExperience，增加/保留 lazy 路径及公共 tab 断言。
- 删除 `test/etfPcfSharesView.test.mjs`：只测已删除展示模块；有价值的缺失值、筛选、排序、净额与状态行为迁入新 UI 的行为测试，不复活旧模块。
- 更新 `test/etfSharesDetailUi.test.mjs`：esbuild stdin import 改名；旧十列、pill、KPI、usage-meter、卡片 DOM 数量及代码排序按钮断言全部替换。该文件是 node:test 驱动 Playwright，使用 `node --test` 执行。
- 保留 `src/app/etfPcfDetailClient.js` 与 `test/etfPcfDetailClient.test.mjs` 原样；shares client/schema/calendar 与其测试也保留。mock fixture 需要限额 kind 字段，不能改数据层迎合 UI。
- 完成后用 `rg` 核对 src/test/scripts 不再引用四个删除模块；历史文档可保留历史描述。

## 8. §9 五项否决项的落实点

| 否决项 | 落实位置 / 验收 |
| --- | --- |
| 无大号 hero / KPI 磁贴 | `.shares-head` 仅紧凑行内 stats；移动换行不变成独立指标卡；测试旧 stat-card/card-kpi-grid 消失 |
| 无利用率进度条 | `UtilizationCell` 只有状态徽章和上限文案；不存在 usage-meter/usage-bar/progressbar；仅保留净增 `.delta-bar` |
| 无净增 ▲▼ | `DeltaSharesCell` 仅 +/-；排序的 ⇅/↓/↑ 与限额环比 ↑/↓ 可用，不引入三角数字装饰 |
| 无金额列及显隐切换 | 五列固定；deltaAmountWan 不参与 UI、派生、网络；抽屉原有现金/NAV 字段不属于新增金额估算列 |
| 无手动视图切换 | 没有 auto/table/cards 按钮及布局 state；≤860px 只由 CSS 改展示 |

## 9. 响应式与无障碍

- `>860px` 桌面五列表格；`≤860px` table/tbody block、数据行 grid：`symbol actions / delta total / util util`。卡片外边距 12px，展开行跨全宽，与选中卡片圆角连接。thead 视觉隐藏而非由 React 删除，避免测试继续断言 DOM 不存在。
- 所有 grid 子项允许 `min-width: 0`；信息栏换行、长名折行、详情 kv 值可断行。筛选滚动仅限工具栏内部，不造成 document 横向溢出；390px 和 860/861px 边界必测。
- 保持同一 DOM 和订阅，窗口尺寸变化保留展开与焦点。隐藏简称/head-meta 只隐藏展示，不因 CSS 隐藏而创建额外请求。
- 筛选原生 button + `aria-pressed`；排序 `th scope=col` + `aria-sort=none/descending/ascending`，按钮 title 提示下一次动作；移动表头隐藏后单元格仍有可读标签，检查 CSS 改表格显示后的辅助技术语义。
- 明细原生 button 使用 `aria-expanded` 与 `aria-controls`；区域 `role=region`、`aria-labelledby` 指向展开按钮。整行可点击，但内按钮 stopPropagation 避免双切换；键盘通过按钮 Enter/Space，不把 tr 做成嵌套按钮。区域折叠时焦点不能遗落在已卸载内容中。
- 搜索有 `aria-label`，清空为“清空搜索”，刷新有名称；loading `role=status`，error `role=alert`。装饰图标/净增条 `aria-hidden`，状态必须有文字，不能只依赖颜色。
- `.shares-panel :focus-visible` 使用 2px 主色 outline 与 offset；prefers-reduced-motion 限定面板停用呼吸、骨架、旋转与过渡。

## 10. 实施顺序与验证

实施顺序：先新建两文件与真实订阅消费 → 完成 PC/移动与交互 → 替换两个挂载点 → 同步测试并删除旧文件 → 请求计数与视觉验收 → 静态检查和构建。整个过程不修改数据层。

需更新的行为验证覆盖：

1. 新鲜 complete/partial、loading、404 empty、错误与重试、stale 缓存先显后更新、5 分钟降级、expiresAt 硬过期、上海跨日和迟到响应保护。
2. 五列、六筛选计数、搜索清空/无匹配、三态排序（缺失置底与默认恢复）、全表固定净增尺度、null 不变零、over-limit 不误报顶格。
3. LimitChangeTag up/down/flat，日期严格来自 row.limitDate 的上一交易日；有限零值可比较。缺日期/日历、unknown/unlimited、非整数、字符串、null、404/error 均无标签；当前口径不合法时零请求。
4. “不会调用”测试：无告警首屏零 PCF 请求；有告警仅对应历史 code/date；非告警/沪市/未展开行无当前详情请求；排序、搜索、尺寸变化不新增相同历史请求；抽屉关闭 release，同 code/date 的标签与抽屉请求去重。
5. 两个公开入口、雷达权限回归、键盘展开/收起、单展开、region 关联、详情日期与真实 10+3 字段、沪市本地短路；拆分历史请求和当前详情请求计数，旧“首屏一律零请求”断言仅适用于无告警 fixture。
6. 在客户端现有测试中回归缓存命中、过期、source 错配、key 防御；本次不更改这些缓存策略。标签 UI 增加不合口径不渲染测试，不把展示缺值兜底成重接口调用。
7. Playwright 1280px/390px 与 860/861px 验证 document.scrollWidth === clientWidth、桌面紧凑头部、告警与首行可见、移动卡片区域、展开后无溢出；thead 应测可见性而非删除。检查五项否决项，记录对照截图，外壳不纳入面板视觉差异。

mock 优先复用 `test/helpers/etfPcfSharesFixture.mjs`；需走真实 sharesClient 的集成场景必须先通过 `validateSharesProjection`，用真实 `confirmedSharesCalendar`、完整 13 行及正确日期推导。旧 UI 测试覆写 subscribe 的变形 fixture 不能冒充接口校验通过的样本。历史 PCF mock 按 code/date 区分，补齐 `totalSubscribeLimitKind` 与有效 expiresAt，演示三种环比。

后续实施完成执行（此文档任务不宣称已跑实现验证）：

```sh
npx eslint src/pages/SharesExperience.jsx src/pages/WorkspacePage.jsx src/pages/AdminRadarExperience.jsx --quiet
node --test test/sharesWorkspaceRedirect.test.mjs test/workspaceMobileBottomNavMount.test.mjs test/etfPcfSharesClient.test.mjs test/etfPcfDetailClient.test.mjs test/etfPcfSharesProjection.test.mjs test/etfPcfSharesDates.test.mjs test/etfSharesDetailUi.test.mjs
npm run check:refactor
npm run lint -- --quiet
git diff --check
npm run build:app
```

改动 JSX 的 eslint 必须 0 error；新增测试文件加入相关 node --test 命令，Playwright 浏览器缺失需作为环境问题明确记录，不能当测试通过。`npm run build:app` 实际执行 Vite build，须成功；`npm run build` 会先跑 guard，不能据其已知 guard 失败判定 Vite 无法构建。

已知无关基线（由任务/原规格提供，实施时记录实际输出）：`npm run check:refactor` 因 `workers/ocr-proxy/src/index.js` 行数预算失败；全仓 lint 有 12 个既有 error。仍运行并记录这两项，不追修无关文件、不调预算、不声称全仓通过；若出现本次引入的新错误则必须修复。

## 11. 风险与 open questions

| 项目 | 当前实施决定 / 待核实点 |
| --- | --- |
| 历史 PCF 增强与列表边界 | 仅告警条轻量增强是明确需求；不推广到全量详情预取。历史缓存 miss 静默，数据层只读可能无法限制服务器内部回源，记录实际行为但不在本次改 Worker |
| 历史字段 kind | UI 必须显式收到 totalSubscribeLimitKind=limited，旧缓存缺 kind 时标签消失是预期降级；不能补推断 |
| 详情 T 日选择 | 延续 data.date；pcfSnapshot.date 可与统计日不同，展示真实日期与口径。若产品未来要求“最新 PCF T 日”，需另行明确契约，不在此次替换中暗改 |
| 规格行数冲突 | 采用真实 T 10/P 3（13 行）；若要压到 9 行需明确删哪一项，当前不擅删字段 |
| 视觉顺序与密度 | stale 顺序采用移动截图；8+ 行不是截图给出的稳定几何事实，验收需结合分辨率，不以大幅缩字硬达标 |
| 860px viewport 与窄容器 | 按规格纯 CSS viewport；宽屏内过窄容器可能挤压，先以 min-width/换行处理，若仍不够再讨论 container query，不恢复 JS 三档布局 |
| 刷新缓存语义 | 重新订阅不等于强制回源；在数据层只读边界内保留现状，不能向用户承诺绕过缓存 |
| 日历覆盖 | confirmedSharesCalendar 仅支持已确认的 2026 且跨度有限；跨年/覆盖不足标签静默降级，不联网补日历 |
| a11y 表格转卡片 | display block/grid 可能影响辅助技术表格结构，需浏览器语义检查；保持一套 DOM，必要时补显式角色/读屏标签 |
| 仓库工作区 | 计划开始时已有未跟踪的规格与 router 计划文档，保留；实施清理只能针对上述四个旧产品文件和指定旧测试，不顺带删除其他工作 |

以上有明确默认决定的项不阻塞直接替换；新发现的数据契约冲突需先记录证据，不能通过改只读客户端、伪造数字或扩大预取掩盖。
