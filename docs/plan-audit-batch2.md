# CN 前端审计 batch2 修复计划

基线：release 20261026160053（commit 41207bfc4）。旧版本 worktree 基线 `node --test test/*.mjs`：1287 条，30 条失败（与 batch1 相同）。

原则：只改源码；超限文件（HoldingsExperience / NotifyExperience / NewPlanExperience / MarketsExperience）不增长，新逻辑放新文件或共享组件。

| # | 问题 | 根因 | 修法 | 新文件 |
|---|---|---|---|---|
| 5 | 场外基金价格 0.00、成交额 — | 场外 quote 的 `price: null` 经 `Number(null)` 变成 0；价格列只看 `price` 不看 `latestNav`；缺失值降序时排到最前 | 统一 `toNumberOrNull`；场外显示 `latestNav` + 「净值 MM-DD」，缺失显示「—」+「净值日更」/「暂无」；成交额场外标注；桌面表与移动列表排序缺失值升降序都排最后 | `pages/markets/marketMissingValue.js`、`MarketValueCells.jsx` |
| 9 | 表头截断 | `th` `whitespace-nowrap` + 标签 `truncate` + 固定列宽 | 表头允许两行换行、`title` 显示全称、最小列宽 64px | — |
| 10 | 19 行时大量空白 | 表格滚动容器 `flex-1` 撑满父容器 | 容器不再 `flex-1`，高度跟随内容、超出再滚动 | — |
| 11 | 排序三态不透明 | 只有图标，没有 aria-sort / 统一文案 | `sortState.js` 统一三态；表头 `aria-sort`、`title`/`aria-label`（如「当前降序，点击升序」） | `components/data-table/sortState.js` |
| 12 | 宽表右侧裁切 | 无滚动提示 | DataTable 加左右滚动阴影 + 首次「左右滑动查看更多」提示；首列沿用 sticky 固定；滚动区可键盘聚焦 | `components/data-table/scrollEdges.js` |
| 13 | 保存视图用 window.prompt | — | `TextPromptDialog`（基于项目 Radix Dialog），名称必填、trim、截断 18 字 | `components/TextPromptDialog.jsx`、`app/textPromptValidation.js` |
| 15 | 登录表单 | 无 form/label 关联/placeholder；缺字段提示常驻；统计默认开启 | `<form onSubmit>` 支持回车；id/name/htmlFor/autocomplete/placeholder；提示只在输入或提交失败后出现（aria-live）；统计改 opt-in | `app/authFormState.js` |
| 16 | 移动端情绪条溢出 | 指标与按钮组在窄屏撑宽 | ≤480px 指标行横向滚动 + 渐隐、文字截断、按钮组换行 | `styles/a11y-mobile.css` |
| 17 | FAB 压底栏 | `bottom-6` 固定 | `bottom: 底栏高度 + safe-area + 16px` | 同上 |
| 18 | 触摸目标过小 | — | 共享 CSS：≤640px 或 coarse pointer 下图标按钮、关闭按钮、表头排序、勾选框 label 最小 44×44 | 同上 |
| 19 | 文章 iframe | 跨域绝对地址、无深链、固定高度双滚动 | cn/fast 域名下同源加载 `/wechat/`；slug 同步 `?article=`（replaceState，后退由浏览器联合历史处理）；同源时按内容高度自适应；「新窗口打开原文」；iframe title 跟随文章标题 | `pages/articles/articleUrlSync.js` |
| 20 | 折叠侧栏只有图标 | 链接无 aria-label/title | 抽 `SidenavLink`，每项 aria-label/title/aria-current，锁定项标注权限 | `components/consoleSidenavA11y.js` |
| 21 | 图表无文本替代 | — | `summarizeSeries`/`summarizeMultiSeries` 生成摘要；行情详情图、持仓累计收益、收益曲线、首页溢价分时图加 role="img" + aria-label，复杂图加 sr-only 摘要 | `lib/chartA11y.js`、`components/ChartA11y.jsx` |

测试：`test/auditBatch2.test.mjs`（缺失值、排序、aria-sort、滚动边缘、prompt 校验、登录表单状态、侧栏、图表摘要、文章 URL 同步）；`analyticsPrivacy` 更新为 opt-in 语义；`articlesTab`/`adminRadarAuctionTab` 更新为新实现。

行为变化：隐私统计默认关闭——本地值 `'1'`（已关闭）保留；`'0'` 表示明确开启；未设置（含旧版本中“默认开启且从未切换”的用户）现在视为关闭。

回滚：`bash scripts/cn-frontend/rollback.sh 20261026160053`。
