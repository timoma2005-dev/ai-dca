# tab=shares 页面 UI 交互规格 v2（重写目标）

> **核验注记（2026-10-19，助手实测 cn 分支后补）**
>
> 以下正文是 dudu 2026-10-19 给出的规格，标题称「当前已实现状态」，但实测当前仓库（cn 分支，HEAD c929a632，10-17 上线）实现的是**另一套设计**：`src/pages/EtfPcfSharesPanel.jsx` + `src/pages/etfPcfShares.css`（+ `EtfPcfSharesDetail.jsx`）。`SharesExperience.jsx` / `shares-experience.css` 在全仓任何分支都不存在（git log --all 无记录）。因此本文应视为 **v2 重写目标**，而非现状描述。下一个 CLI 动手前先与 dudu 确认：是按本文重写，还是继续在现有 `EtfPcfSharesPanel` 上迭代。
>
> 实测与本文的主要差异（2026-10-19 已按「直接替换」实现，分支 `feat/shares-experience-v3`，commit `34f89aad`，实现时逐项核对代码确认；浏览器验收 3/3 通过，截图已发 dudu）：
> 1. 文件与组件：实际 `EtfPcfSharesPanel.jsx`（645 行）+ `etfPcfShares.css`（1423 行）+ `EtfPcfSharesDetail.jsx`（116 行）；数据层是 `src/app/etfPcfSharesClient.js`（`sharesClient.subscribe()`），不是 `etfPcfShares.js` 的 `sharesSnapshotStore`。
> 2. 挂载：`?tab=shares` 在 `WorkspacePage.jsx:613` 确实直接挂载份额页（组件是 `EtfPcfSharesPanel`）；雷达页 `#shares` 子 tab 挂载同一组件；10-16 已取消份额 tab 的 admin 拦截（套利雷达 tab 仍拦截）。
> 3. 表格：实际 10 列（代码 / 名称 / 份额增量 / 盘前净新增份额 / 顶格状态 / 本期总份额 / 上期总份额 / 累计申购上限 / 限额日期 / 详情），不是本文的 5 列。
> 4. 顶部：实际是 h2「ETF 申购赎回份额监控」标题 + 数据口径 pill 行 + **3 张 KPI 卡**（监控总数 / 顶格·接近 / 合计净新增），不是本文的单行信息栏；本文 §9 否决的「KPI 磁贴」在实际实现中仍然存在。
> 5. 进度条：实际 `UsageMeter` 有 `.usage-bar` 进度条；本文明确要求移除。
> 6. 告警条 / 限额环比标签 / 净增对比条形图：实际均不存在（无 `.alert-strip`、无 `.limit-change`、无 `.delta-bar`）。
> 7. 筛选：实际 5 档（全部标的 / 顶格·接近 / 份额净增 / 深市 / 沪市），无「净减」档。
> 8. 响应式：实际是 ResizeObserver 按面板宽度三档自动切换（<640 compact 卡片 / 640–1199 wide 卡片 / ≥1200 table 宽表），不是本文的纯 CSS ≤860px 断点；自动切换而非手动，与本文「无手动切换」方向一致。
> 9. 明细抽屉：实际 `EtfPcfSharesDetail.jsx`（`pcfDetailClient.subscribe(code, date)` + `pcfDetailSections` 组装 kv 行），不是本文的 `PcfDetailDrawer` / `buildPcfDetailSections`。
> 10. 已与本文一致、无需改动的：无 ▲▼ 箭头、无「新增金额估算」列、无手动视图切换；快照 `expiresAt` 到期转 error、`receivedAt+5min` 转 stale 的降级逻辑存在；`shanghaiAccessDay` 跨天 rollover 存在；aria 属性（aria-pressed/aria-sort/aria-expanded/role=region）存在。
>
> ---
>
> 以下为 dudu 原文（逐字保留）。

# tab=shares 页面 UI/交互规格（当前已实现状态的完整 Plan）

> 目的：供任何 CLI / 开发者在现有基础上继续修改 `tab=shares`（份额新增）页面。
> 当前实现：`src/pages/SharesExperience.jsx` + `src/pages/shares-experience.css`（自包含样式，无全局依赖）。
> 数据层 `src/app/etfPcfShares.js` 与 Worker（`workers/etf-shares`）不在 UI 改动范围内，本 plan 只描述其消费契约。

---

## 1. 设计目标

用户进入页面第一眼应看到的是「今天有哪些标的顶格/接近顶格、要不要行动」，而不是时效性大卡片。因此首屏视线动线为：

```
单行信息栏（50px） → 「今日需关注」告警条 → 筛选/搜索工具栏 → 数据表格（首屏可见 8+ 行）
```

原则：
- 精简：不渲染没有数据源的字段（如「新增金额估算」——D 日官方净值凭证缺失，校验层强制为 null，已整体移除该列，原因写进页尾口径说明）。
- 视觉重点靠三种手段：告警条（顶格标的）、行高亮（顶格/接近日志行暖色背景+左侧琥珀条）、净增份额对比条形图（全表等比缩放）。
- 移动端 ≤860px 表格自动降级为卡片布局，不提供手动视图切换（纯 CSS 响应式，无多余 chrome）。

## 2. 文件与职责

| 文件 | 职责 |
|---|---|
| `src/pages/WorkspacePage.jsx` | `?tab=shares` 时 lazy 挂载 `SharesExperience`，无需管理员权限 |
| `src/pages/SharesExperience.jsx` | 全部 UI 与交互；内部组件见 §4 |
| `src/pages/shares-experience.css` | 自包含设计令牌 + 全部样式，类名以 `.shares-panel` 作用域隔离 |
| `src/app/etfPcfShares.js` | 快照校验/缓存 store/PCF 限额 store/格式化函数（不改） |
| `workers/etf-shares` | `/api/etf-pcf-shares`（快照）与 `/api/etf-pcf-limit?code&date`（单标的 PCF，支持历史日期）（不改） |

## 3. 设计令牌（CSS 变量，定义在 `.shares-panel`）

- 主色：`--primary #4f46e5`（indigo-600）、`--primary-light #eef2ff`、`--primary-border #c7d2fe`
- 中性：slate-50…900（`--slate-50` ~ `--slate-900`）
- 语义：emerald-50/600/700（正向）、rose-50/600（负向）、amber-50/100/600/700（告警）
- 圆角：`--radius-sm 8px / -md 12px / -lg 16px / -pill 9999px`
- 阴影：`--shadow-subtle`（卡片）
- 等宽数字：所有数值用 `font-variant-numeric: tabular-nums`
- `@media (prefers-reduced-motion: reduce)` 全局关闭动画/过渡

## 4. 组件结构（SharesExperience.jsx）

### 4.1 `<SharesPanel>` 页面骨架（自上而下）

1. **`<header className="shares-head">` 单行信息栏（约 50px）**
   - 左 `.head-info`：状态 chip（`.status-chip` synced/stale/empty + 呼吸点 `.status-dot`）｜`基准日 <b>2026-10-19</b> · 对比 10-16`（`.head-date`，主色加粗日期）｜`抓取 HH:mm:ss`（`.head-meta`，hover title 含发布日与 PCF 限额口径）。
   - 右 `.head-stats`：三个 `.head-stat`（label + 大号 b 数值 + small 单位，`pos/neg/warn` 着色）：
     - `净流入 +10,000 万份`（title：深市 N 只有效净增合计）
     - `顶格/接近 3 只`（有值时琥珀色；title：各标的状态列表）
     - `监控 13 只`（title：深市 8 · 沪市 5）
     - 末尾 `.refresh-btn` 图标按钮（30×30，触发 `reloadCount++` 重新订阅快照）。
2. **`.stale-banner` 滞后横幅**（仅 `isStale` 时）：琥珀底、左侧 4px 边、`刷新重试` 按钮。
3. **`.alert-strip` 「今日需关注」告警条**（`ceilingRows.length > 0` 时）：
   - 标题：⚠ 今日需关注；内容：每个顶格/接近标的一个 `.alert-chip` 胶囊。
   - 胶囊内容：`代码` + `简称`（移动端隐藏简称）+ 状态 pill（`.alert-chip-status`：顶格=琥珀实底 / 接近=浅琥珀）+ **限额环比标签 `.limit-change`**（见 4.2）。
   - 点击任一胶囊 → `setFilterKey('ceiling')` 切到「顶格/接近」筛选。
4. **`.panel-toolbar` 工具栏**：
   - 筛选 `.filter-group`（segmented）：`全部 / 顶格·接近 / 净增 / 净减 / 深市 / 沪市`，每档带计数徽章 `.filter-count`，`aria-pressed`。
   - 搜索 `.search-box`：放大镜图标 + 输入框（代码或简称 contains 匹配）+ 非空时出现圆形清空按钮 `.search-clear`。
5. **`.shares-card` 主体卡片**：
   - 无数据时 `.state-view`：loading（旋转图标 + 4×4 骨架屏 `.skeleton-row`）/ empty（Inbox 图标 + 流水线说明 09:00→09:01→09:02）/ error（红圆图标 + 重试按钮 `.action-btn`）。
   - 有数据时 `.shares-responsive-table > table.shares-table`，5 列：
     | 列 | th | td | 排序 |
     |---|---|---|---|
     | 代码/简称 | 静态 | `.sh-symbol`（代码+市场标签 深市/沪市、简称） | — |
     | 净增份额 | `<SortHeader sortKey="delta">` | `.sh-delta` → `<DeltaSharesCell>` | ✓ |
     | 限额利用率 | `<SortHeader sortKey="util">` | `.sh-util` → `<UtilizationCell>` | ✓ |
     | 本期总份额 | `<SortHeader sortKey="shares">` | `.sh-total` → `<TotalSharesCell>` | ✓ |
     | 明细 | 空 th | `.sh-actions` → `#shares-toggle-<code>` 按钮 | — |
   - 行 `tr.shares-row`：点击整行或按钮展开明细；顶格/接近行加 `.alert-row` 类（暖色渐变背景 + 首列 inset 3px 琥珀左边条；hover/expanded 有对应变体）。
6. **`.shares-notes` 页尾口径说明**：`<details>` 默认折叠，summary「数据口径说明」+ 自绘 ▸ 箭头（open 时旋转 90°）；三条 note：净增口径 / 顶格双口径判定 / 沪市待接入 + 金额估算缺失原因。

### 4.2 单元格组件

- **`<UtilizationCell row snapshotDate>`**：`ceilingStatus(row)` 产出徽章（`.ceiling-tag.at-limit/near-limit/over-limit/unlimited/outflow/normal/pending` + 圆点）；旁注 `.util-sub`：`当日上限 N 万份 · 限 MM-DD`（limitDate≠snapshotDate 时标注）或「无累计申购限额」。沪市（非 159）→ `.util-sse-pending`「沪市待接入」。**没有进度条**（用户明确要求去掉）。
- **`<DeltaSharesCell row maxAbsDelta>`**：
  - `.delta-val` 带符号数值（pos 绿 / neg 红 / zero 灰，15px 加粗，无 ▲▼ 箭头——与符号重复，已移除）。
  - `.delta-sub`：`确定/估算申购 N 万份` 或 `未比对`。
  - `.delta-bar`：`.delta-fill pos/neg`，宽度 = `|deltaShares| / maxAbsDelta`（全表最大值归一，max(1, …)），max-width 140px。
- **`<TotalSharesCell row>`**：`.total-val` 本期 `X.XX 亿`（`formatYi`）+ `.total-prev` `上期 X.XX 亿`。
- **`<SortHeader label sortKey sort onSort>`**：th 内按钮，点击三态循环 `默认→降→升`，`aria-sort`，箭头字符 `⇅/↓/↑`。

### 4.3 `<LimitChangeTag row prevLimitDate>` 限额环比（告警胶囊内）

- `prevLimitDate = previousSessionDate(row.limitDate, data.calendar)`（快照内置已验证 2026 交易日历推导上一交易日）。
- `pcfLimitStore.subscribe(code, prevLimitDate)` 请求历史日期 `/api/etf-pcf-limit`（Worker 支持历史缓存读取），与行明细抽屉共用同一 store（去重 + 5 分钟 TTL）。
- 对比 `row.totalLimitShares` 与响应 `totalSubscribeLimitShares`（须双方 `limited` 且为整数）：
  - `diff > 0` → `限额↑ N 万份`（`.limit-change.up` 绿）
  - `diff < 0` → `限额↓ N 万份`（`.limit-change.down` 红）
  - `diff === 0` → `限额持平`（`.limit-change.flat` 灰）
  - 读不到 / 口径不符 → 静默不渲染（不出空标签）。
- 请求范围仅限告警条内的顶格/接近标的（通常 0-3 只）。

### 4.4 `<PcfDetailDrawer code name date id labelledBy>` 行展开明细

- 深市（159）：`pcfLimitStore.subscribe(code, date)` → `buildPcfDetailSections` 组装两卡片 `.pcf-grid`：
  - `.pcf-card.t-day`「T 日申赎规则与上限」9 行 kv（申购/赎回允许状态做 ✓ 允许/✕ 暂停高亮：`highlight-green/amber`）。
  - `.pcf-card.p-day`「P 日清算基准」3 行 kv + `.pcf-formula`（金额估算公式 + 「禁止使用盘中 IOPV」注记）。
  - 状态：loading/empty/error（error 有重试按钮，retryCount 递增触发重订阅）。
- 沪市（非 159）：`.sse-detail` 提示「报表源暂未接入上交所 PCF」。

## 5. 数据层契约（消费，不修改）

- `sharesSnapshotStore.subscribe()`：内存+localStorage 双层缓存、inflight 去重（8s abort）、404 熔断 30s、`isValidSharesSnapshot` 全量校验失败降级 stale。组件侧：快照 `expiresAt` 到期转 error，`receivedAt+5min` 转 stale（自滚动 setTimeout）。
- 快照 records 固定 13 只（`MONITORED_CODES`，深 8 + 沪 5）；行字段：`shares/prevShares/prevDate/deltaShares/creationShares(+Kind)/totalLimitKind/totalLimitShares/limitDate/creationUnitShares/utilization/atLimit/nearTotalLimit/status/reasons`。`deltaAmountWan` 校验层强制 null → UI 不渲染金额。
- `shanghaiToday()` 跨天自动 rollover（visibilitychange/focus + 定时器）刷新基准日。

## 6. 响应式断点

- `>860px`：桌面表格。
- `≤860px`：`table/tbody` 置 block、thead 隐藏、行转卡片 grid：
  ```
  "symbol actions"
  "delta  total"
  "util    util"
  ```
  行 12px 外边距、圆角卡片；展开态卡片与抽屉连接成一体（上圆角卡片 + 下圆角抽屉）；`.alert-chip-name` 隐藏；`.head-meta` 隐藏；KPI stats 保留。
- `prefers-reduced-motion`：全部动画关闭。

## 7. 可访问性

- 筛选/视图按钮 `aria-pressed`；排序 th `aria-sort` + title 提示循环方向；展开按钮 `aria-expanded` + `aria-controls`，抽屉 `role="region"` + `aria-labelledby`；搜索框 `aria-label`，清空按钮 `aria-label="清空搜索"`；状态视图 loading `role="status"` / error `role="alert"`；`:focus-visible` 2px 主色 outline。

## 8. 验证方法（给下一个 CLI 的实操指引）

1. **本地 mock**：vite dev 的 `/api` 代理到 `127.0.0.1:8787`，起一个小 node http server 返回 `/api/etf-pcf-shares` 快照与 `/api/etf-pcf-limit`（历史日期返回不同限额以演示环比三态）。快照必须通过 `isValidSharesSnapshot` 全量校验——用 node 脚本 import `src/app/etfPcfShares.js`（repo 是 `"type":"module"`）自生成自验，关键字段：`source:'szse_pcf_shares_projection'`、`inputSource:'szse_fund_report'`、`dateEvidence.column ∈ 白名单`、`calendar` 必须与 `buildVerifiedTradingCalendar` 逐日一致、`expiresAt = fetchedAt+30d`、`availableOn = shanghaiDateOf(fetchedAt)`、每行 `deltaShares = shares - prevShares` 且派生字段（utilization/atLimit/nearTotalLimit/status/reasons）精确一致。
2. **浏览器验证**（无头或 in-app browser）：打开 `http://localhost:5199/?tab=shares`（首次会有「体验新版站点」弹窗，evaluate 移除即可）。程序化体检要点：
   - `document.documentElement.scrollWidth - clientWidth === 0`（桌面 1280 / 移动 390 均无横向溢出）；
   - `.shares-head` 高度 ≈50px（桌面）；`.alert-strip`/表格首行在首屏内；
   - 排序点击三次：desc → asc → 恢复默认（比对 `.symbol-code` 序列）；
   - 展开抽屉：`.pcf-kv-row` 数量 12；筛选「净减」只剩净减标的；
   - `.limit-change` 三态出现（up/down/flat）。
3. **提交前检查**：`npx eslint src/pages/SharesExperience.jsx`（0 error）、`git diff --check -- <改动文件>`、`node --test test/workspaceMobileBottomNavMount.test.mjs`。注意：仓库当前 `npm run check:refactor` 因 `workers/ocr-proxy/src/index.js` 超行数预算而失败、全仓 lint 有 12 个既有 error，均与本页无关。

## 9. 已被明确否决的方案（不要再改回去）

- ❌ 顶部大号时效 hero 卡 + KPI 磁贴 + 27px 主指标（用户嫌太大，已压成单行信息栏）。
- ❌ 限额利用率列的进度条（用户认为没用，已移除）。
- ❌ 净增数值的 ▲▼ 箭头（与 +/- 符号重复，已移除）。
- ❌ 「新增金额估算」列及其显隐切换（数据源永远为空，已移除）。
- ❌ 手动三档视图切换（auto/table/cards，与响应式 CSS 重复，已移除）。
