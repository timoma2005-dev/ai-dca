# 首页（tab=home）UI 重构实施计划

> 用户需求（2026-10-12）：把当前首页改成 `~/workspace/user/files/home.html` 的 UI 和交互。
> 参考文件：233K / 2317 行独立 HTML，含完整 CSS + JS + 嵌入式数据快照。
> 目标文件：`src/pages/CnHomeExperience.jsx`、`src/pages/cn-home.css`
> 约束：100% 限定在 tab=home，不动 markets / holdings / tradePlans / fundSwitch 等其他 tab；零外部依赖；保留"本地快照缓存 + 异步拉取"的数据机制。

---

## 1. 现状对比

### 1.1 数据源（兼容，无需改动）

| 数据 | 当前实现 | 参考 HTML | 结论 |
|---|---|---|---|
| 全局概览 | `GET /api/market-collector/aggregates/home-market-overview` → fallback `/datasets/home-market-overview/global` | `window.INITIAL_MARKET_DATA.overview`（嵌入快照）+ `fetch(.../aggregates/home-market-overview)` 刷新 | **同一接口**，字段形状兼容 |
| 分时序列 | `GET /aggregates/home-market-series` → fallback `/datasets/home-market-series/today%3A5m` | `window.INITIAL_MARKET_DATA.series` + fetch | **同一接口** |
| 场外限额 | `GET /aggregates/fund-limit-overview` → fallback `/datasets/fund-limit-overview/global` | `window.INITIAL_MARKET_DATA.limits` + fetch | **同一接口** |
| 本地缓存 | `localStorage['cn-home:{overview,series,limits}:v1']`，先渲染缓存再异步刷新 | 无（独立 HTML，靠嵌入快照） | **保留现有机制**，参考的"嵌入快照"在 React 里不需要（localStorage 缓存已覆盖毫秒级首屏） |

**结论**：数据层零改动。`loadSection()` 的三段 fallback 链保留。

### 1.2 组件映射

| 参考 HTML 模块 | 当前实现对应 | 改动幅度 |
|---|---|---|
| 顶部三大指标卡（涨跌家数 / 溢价中位数 / 场外额度） | `Overview` 组件 | **中**：HTML 结构重写（卡片式 + 进度条 + 像素对齐），数据字段复用 |
| 场内分时 SVG 图（23 曲线、防重叠标签、十字光标、tooltip） | `MiniChart` 组件 | **大**：viewBox 720×280 → 800×380；标签防重叠算法保留但需适配；新增可交互 legend（点击高亮/隐藏曲线）；tooltip 改为表头+列表结构 |
| 溢价率%/价格¥切换 | `mode` state（已有） | **小**：segmented-control 样式对齐 |
| 5 大指数分类 chips | `group` state + `groups`（已有，服务端下发） | **小**：chip 样式对齐；移动端默认选中"纳指 100"（用户建议 2，宽度 <640px 时） |
| 换基利差看板（高/中/低三档 + 利差 + 策略建议） | `MiniChart` 内的 zone-summary | **中**：保留现有高/中/低计算逻辑；新增"策略建议"文案（利差阈值触发）；样式重写为 zone-card 三卡片 |
| 场外额度 7 日趋势 | `Limits` 内的 quota-change | **小**：样式对齐为 quota-box |
| 最近限额调整公告板 | `Limits` 内的 quota-board | **小**：样式对齐 |
| 场外限额大全弹窗（搜索+币种/状态筛选+双列） | `CnFundLimitDetail`（独立页面，URL 参数 view=fund-limits） | **大**：参考实现为 drawer 弹窗，当前为整页跳转。**决策点**：二选一（见 §3） |
| 深浅色主题切换 | 无 | **中**：新增（见 §2.4） |
| CN 红涨绿跌 / US 绿涨红跌切换 | 无（写死 CN 配色） | **小**：CSS 变量切换 |
| 顶部导航栏 / 底部 Tab 栏 | App 已有（WorkspacePage + MobileBottomNav） | **不移植**：参考的 nav 只是独立 demo 的壳 |

### 1.3 明确不移植的部分

1. **桌面端顶部 Tab 导航**（首页/行情/持仓/计划/换基/通知/文章）：App 的 WorkspacePage 已有自己的导航体系，参考的只是 demo 壳。
2. **移动端底部 Tab 栏**：App 已有 `MobileBottomNav`。
3. **品牌标题区**（"美股策略助手 · 市场首页"）：当前 `cn-home-head` 的"市场首页 / 全球指数基金实时概览"保留，但可按参考的视觉风格微调。

---

## 2. 详细改动设计

### 2.1 CSS 架构：引入 CSS 变量主题系统

参考 HTML 用 `:root` + `[data-theme="dark"]` + `[data-color="us"]` 三层变量。这是最大的一块 CSS 重构。

```css
/* 新增到 cn-home.css 顶部 */
.cn-home {
  --bg-main: #f8fafc; --bg-card: #ffffff; ...
  --tone-up: #e53e3e; --tone-down: #10b981; ...  /* CN 红涨绿跌 */
}
.cn-home[data-color="us"] { --tone-up: #10b981; --tone-down: #e53e3e; }
.cn-home[data-theme="dark"] { --bg-main: #090d16; --bg-card: #131b2e; ... }
.cn-home[data-theme="dark"][data-color="us"] { ... }
```

- 所有现有 `.cn-home-*` 规则的颜色值逐步替换为变量（分阶段，避免一次性大爆炸）。
- 桌面端 `@media (min-width:1024px)` 的现有 dashboard 样式保留，与变量体系兼容（把硬编码色值换成变量）。

**风险**：现有 CSS 约 150 行 + 桌面端约 120 行，变量替换需逐条过。建议先加变量定义 + 新组件用变量，老规则按"本次触及到的才换"原则，避免回归。

### 2.2 顶部三大指标卡重写

参考结构（`overview-grid` > 3 个 `.card`）：

1. **涨跌家数卡**：`{rise} / {fall}` 大数字 + 横向进度条（barUp/barFlat/barDown 按比例）+ "场内全池 · {time}" 注脚。
   - 数据：`data.breadth.riseCount/fallCount/flatCount`（现有 `count(b, 'riseCount', 'rise')` 复用；flatCount 新增）。
2. **溢价中位数卡**：大数字 `+9.06%`（tone-up/down 着色）+ "实时口径 / 昨日 X%" 注脚。
3. **场外额度卡**：CNY 总额 + USD 总额双行 + "{N} 只限购"注脚 + "查看完整额度详情 ›"入口（复用现有 `onOpenDetail`）。

对齐要求（用户明确提出）：三卡片等高，底部分割线/注脚基线对齐。用 `display:flex; flex-direction:column` + 注脚 `margin-top:auto` 实现。

### 2.3 分时图升级（MiniChart → PremiumChart）

保留现有数据 pipeline（`pickSeries`、`isLofLine` 过滤、zone 计算），升级渲染层：

| 参考特性 | 当前状态 | 动作 |
|---|---|---|
| viewBox 800×380，更大绘图区 | 720×280 | 改常量 |
| 防重叠引线标签（已有类似算法） | 已有 `endLabels` 双向钳制 | 保留算法，迁移到新结构；标签改为"色点 + 名称 + 最新值"三段式 |
| 十字光标 + 悬浮窗（时间点各 ETF 溢价排行） | 已有 cursor + tooltip（按最新值排序） | tooltip 改为参考结构：表头（时间 + 指标名）+ 可滚动列表；**新增时间显示**（当前 tooltip 无时间，series point 有 time 字段，需确认） |
| 可交互 legend（点击 toggle 曲线） | 无 legend | **新增**：`hiddenKeys` state，点击 legend 项隐藏/显示对应曲线 |
| 溢价率%/价格¥切换 | 已有 | 样式对齐为 segmented-control |
| 移动端默认"纳指 100" | 默认 'all' | `useState` 初始化时检查 `window.innerWidth < 640` 则默认 'nasdaq-100'（若该 group 存在） |

**需确认的数据字段**：tooltip 时间显示需要 `point.time` 或 `point.label`。`pickSeries` 返回的 points 结构需打印一次确认（`series.modes.premium.series[].points[]` 的字段名）。

### 2.4 换基利差看板

现有 `model.zones`（高/中/低）+ `model.gaps`（高-中/中-低/高-低）计算逻辑**完全保留**，只改渲染：

- 三卡片横排：`高溢价区 (7只) +13.48%` 等，色块区分（红/ amber /绿）。
- 利差 pills：`高 − 中：+4.33%` 等。
- **新增策略建议文案**（参考）：
  ```
  当前高-低利差达 X%，持有高溢价 ETF 的投资者可通过换基至低溢价同标的
  或场外申购底仓平抑溢价成本。
  ```
  触发阈值：建议 `gapHighLow >= 3` 显示加强语气，`< 3` 显示温和版。阈值待用户确认，默认 3%。

### 2.5 场外限额区

- **7 日趋势卡**：现有 `summaries`（CNY/USD delta）保留，改卡片样式 + badge（"放宽/收紧/稳定"）。
- **最近调整公告板**：现有 `quota-board` 保留，样式对齐（events-board 行样式）。
- **限额大全入口决策**（二选一，需用户拍板）：
  - **A（推荐）**：保留现有 `CnFundLimitDetail` 整页跳转（URL 参数驱动，有浏览器前进/后退），只把它的内部列表样式按参考的"双列 list rows + 胶囊标签 + 搜索筛选"重做。
  - **B**：按参考做 drawer 弹窗（overlay + 搜索 + 币种/状态 segmented + 双列卡片）。需新增 `OtcDrawer` 组件，状态由 `CnHomeExperience` 控制，不走 URL。
  - 推荐 A 的理由：现有 `CnFundLimitDetail.jsx` 已是一个独立完整页面（含币种切换），改造成本低于新建 drawer；且 URL 可分享。

### 2.6 主题与配色切换

- `data-theme`（light/dark）+ `data-color`（cn/us）挂到 `.cn-home` 根节点（**不挂 documentElement**，避免污染其他 tab）。
- 状态：`useState` 初始化读 `localStorage['cn-home:theme']` / `['cn-home:colorMode']`（与参考的 key 保持一致：`theme`/`colorMode`？建议加 `cn-home:` 前缀避免冲突，参考是独立页无冲突顾虑）。
- 切换按钮放 `cn-home-head` 右侧（与刷新按钮并排），图标用 lucide（现有依赖，参考用内联 SVG，改用 `Sun`/`Moon`/`Palette`）。
- **范围声明**：主题只影响 `.cn-home` 作用域，其他 tab 不受影响。

---

## 3. 待用户拍板的决策

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| D1 | 限额大全用整页还是 drawer 弹窗 | A 整页（改造 CnFundLimitDetail）/ B drawer 弹窗（新建） | A |
| D2 | 策略建议文案的利差阈值 | 默认 3%，可调 | 3% |
| D3 | localStorage key 前缀 | `cn-home:theme` / 直接 `theme`（与参考一致） | `cn-home:` 前缀（防冲突） |
| D4 | 是否保留现有桌面端 1024px+ dashboard 布局 | 保留并变量化 / 按参考重做桌面布局 | 保留（已验证可用） |

---

## 4. 实施阶段

### Phase 0：数据字段确认（0.5 天）
- 打印 `series` points 字段（确认 tooltip 时间字段名）。
- 确认 `groups` 里移动端默认 `nasdaq-100` 的 key 稳定存在。
- 输出：字段确认清单（更新到本 plan）。

### Phase 1：CSS 变量主题基座（1 天）
- 在 `cn-home.css` 顶部新增变量体系（light/dark × cn/us）。
- `CnHomeExperience` 根节点加 `data-theme`/`data-color` + 切换按钮（head 右侧）。
- 新组件全部用变量；老规则不动。
- 验收：切换主题/配色，首页无错乱；其他 tab 不受影响。

### Phase 2：顶部三指标卡重写（1 天）
- 新 `OverviewCards` 组件（替换现有 `Overview` 内 stats 部分）。
- 进度条、像素对齐（`margin-top:auto`）。
- 单元测试：flatCount 缺失降级、昨日中位数缺失显示"实时口径"。

### Phase 3：分时图升级（2 天）
- `MiniChart` → 重写为 `PremiumChart`（新文件 `src/pages/cn-home/PremiumChart.jsx`）。
- 800×380、legend 交互、tooltip 表头+时间、可隐藏曲线。
- 移动端默认 group。
- 单元测试：空 series 显示"暂无今日走势"；legend toggle；mode 切换。

### Phase 4：利差看板 + 限额区样式（1 天）
- zone 看板三卡片 + 利差 pills + 策略建议。
- 限额区 trend/board 样式对齐。
- D1 决策落地（CnFundLimitDetail 内部列表重做：双列、胶囊标签、搜索筛选）。

### Phase 5：回归 + 部署（0.5 天）
- `node --test` 相关测试、`npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`。
- 按 AGENTS.md 测试要求补"不会调用"类测试（如 legend 隐藏后不渲染对应 path）。
- 部署到 cn 主机，fast 站验收（桌面 + 移动端宽度）。

**总计约 6 天**（含 Codex plan → Codely 实现的标准流程）。

---

## 5. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 参考是静态快照，部分交互（如"1970 根 K 线"提示）依赖快照时的数据量 | 文案与实际数据脱节 | 提示文案改为按实际 `series` 长度动态计算 |
| `data-theme`/`data-color` 若误挂到 document 级会污染其他 tab | 全站样式错乱 | 严格挂在 `.cn-home` 根节点；Codex plan 里明确 |
| 现有 1024px+ 桌面样式与新变量体系混用 | 视觉回归 | Phase 1 只加变量不改老规则；Phase 5 做桌面回归截图对比 |
| `CnFundLimitDetail` 是 URL 参数驱动的独立页面，改 drawer 会丢弃浏览器导航 | 后退按钮行为变化 | 推荐 D1=A，保留 URL 驱动 |
| 图表 points 时间字段名未知 | tooltip 时间显示阻塞 | Phase 0 先确认 |
| 深色模式下现有 lucide 图标/图表颜色对比度 | 深色不可读 | 图表曲线色在 dark 下用 PALETTE 的亮色变体（参考已处理，照搬） |

---

## 6. 文件变更清单（预估）

| 文件 | 动作 |
|---|---|
| `src/pages/cn-home.css` | 大改：变量体系 + 新组件样式（约 +600 行） |
| `src/pages/CnHomeExperience.jsx` | 中改：主题 state、组件拆分、OverviewCards 替换 |
| `src/pages/cn-home/PremiumChart.jsx` | **新建**：分时图（含 legend、tooltip、zone 看板） |
| `src/pages/cn-home/OtcTrendCard.jsx` | 新建（可选）：7 日趋势卡 |
| `src/pages/CnHomeExperience.jsx` 内 `Limits` | 中改：样式对齐 |
| `src/pages/CnFundLimitDetail.jsx` | 中改（D1=A）：列表双列化 + 胶囊标签 + 搜索筛选 |
| `test/cn-home-*.test.mjs` | 新建：覆盖 Phase 2/3 的测试要求 |
| `docs/plan-home-redesign.md` | 本文档 |

---

## 7. 不做的事（明确边界）

1. 不动 `WorkspacePage.jsx` 的导航（含 MobileBottomNav）。
2. 不动 `src/app/apiBase.js` 的直连路由逻辑。
3. 不引入新 npm 依赖（lucide-react 已有；图表用原生 SVG，与现有 MiniChart 一致）。
4. 不改动 `/aggregates/*` API 调用链与 localStorage 缓存 key。
5. 深色模式仅限 `.cn-home` 作用域。
