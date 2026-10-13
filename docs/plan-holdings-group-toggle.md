# 持仓总览 / 交易记录：按基金公司聚合 vs 列表 切换

## 背景

- 持仓总览（桌面端 `AggregateHoldingsTableSection` 基金汇总表、移动端 `MobileHoldingsListSection`）目前按基金公司聚合展示（`rowGroupBy: companyName`）。
- 交易记录（`IncomeTransactionsPage`）目前按基金分组展示。
- 用户要求：增加一个选项，可在「按基金公司聚合」和「原有的列表」之间切换。

## 需求

### 1. 持仓总览 · 桌面端（`src/pages/holdings/AggregateHoldingsTableSection.jsx`）

- 在表头区（tableChrome「基金汇总」标题旁）加分段切换：「按公司 | 列表」。
- 「按公司」= 现有行为（`rowGroupBy` 按 `companyName`，`rowGroupSort`、`renderRowGroup` 保持不变）。
- 「列表」= 同一张表、同样列、同样排序过滤，去掉分组，平铺基金行；footer 合计行保留。
- 实现方式：`groupMode === 'company'` 时传 `rowGroupBy/rowGroupSort/renderRowGroup`，否则不传（`DataTable` 不传 `rowGroupBy` 即平铺）。
- 选择持久化 localStorage，key `holdings.holdingsGroupMode`，默认 `company`。

### 2. 持仓总览 · 移动端（`src/pages/holdings/MobileHoldingsListSection.jsx`）

- 标题区（「持仓总览」+ 市值行）下方加同样的分段切换。
- 「按公司」= 现有行为（`groupRows` 按 `companyName` 分组展示）。
- 「列表」= 按现有 `displayRows` 排序直接平铺基金卡片，不分组；搜索框、类型筛选保持可用。
- 与桌面端共用同一个 localStorage key（`holdings.holdingsGroupMode`），两端一致。

### 3. 交易记录（`src/app/income/IncomeTransactionsPage.jsx`）

- 在「④ 明细筛选」行（基金下拉、类型下拉旁）加分段切换：「按公司 | 列表」。
- 「按公司」= 用 `resolveFundCompany(tx.name || tx.code).name`（`src/app/fundCompany.js`）对 `sortedDesc` 分组；
  分组头显示公司名、笔数、买入/卖出汇总（复用现有分组头的布局，只是 key 从 fund 换成 company）；
  组内行复用现有 `Row` 组件（行内仍显示基金名、日期、金额、买入业绩）。
- 「列表」= `sortedDesc` 按日期倒序平铺 `Row`，不分组。
- 未知公司归入「未识别基金公司」（`resolveFundCompany` 已有该 fallback）。
- 持久化 localStorage，key `income.transactionsGroupMode`，默认 `company`。
- 导出 CSV 保持现有行为（按当前筛选的 `sortedDesc` 导出，不随分组模式改变）。

## 视觉

- 分段切换沿用产品现有极简视觉语言：小尺寸 pill segmented control（参考 `DataTableViewOptions` 的 preset 胶囊样式），不引入新色板。
- 桌面端放在表头右侧视图选项区；移动端放在标题下方；交易记录放在明细筛选行。移动端注意不挤占筛选下拉。

## 验收标准

- 三处切换即时生效，无需刷新页面。
- 刷新页面后保持上次选择（localStorage）。
- 桌面端列表模式：列、排序、筛选、footer 合计与分组模式一致，仅去掉公司分组头。
- 移动端列表模式：搜索、持仓类型筛选仍可用；分组头不再出现。
- 交易记录公司模式：同一公司多只基金合并到一组，买入/卖出汇总正确；未知公司进「未识别基金公司」组。
- 现有筛选（基金下拉、类型下拉、时间 lens）与分组切换正交组合，均正常工作。
- `npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check` 通过；`node --test` 相关测试通过（若有新增逻辑，补单测）。

## 不做的

- 不改公司解析逻辑（`fundCompany.js`、`companyName` 派生不动）。
- 不动桌面端/移动端/交易记录之外的页面。
- 不改 CSV 导出内容。
