# 份额页前端改造实施 Plan（Codex）

## 0. 必须先处理的接入阻断
`src/app/etfPcfSharesClient.js` 对网络响应和本地缓存都调用共享的 `validateSharesProjection`。`shared/etfPcfSharesSchema.js` 约 317 行当前明确拒绝 513 记录的非空 prevShares/deltaShares，新快照会被判 invalid_snapshot。前置修复：
- 删除共享校验中的 513 专属拒绝分支，统一使用其后已有的上一交易日、整数份额、差额、利用率及 status 校验。
- 保留旧快照 prevShares:null/deltaShares:null 合法路径。
- 新增字段保持可选，不因缺少 account*、limitChanges、limitChange、顶层日期而拒绝旧快照。
- 补共享校验和真实 client 接入测试，确认携带 513 delta 的完整响应可通过校验。

## 1. src/app/etfPcfSharesClient.js
### 1.1 sharesCeiling 统一沪深利用率逻辑（约 177–204 行）
删除 `!r.code.startsWith('159')` 特判。新顺序：
1. subscriptionAllowed === false → { kind: 'paused', label: '暂停申购' }（对 159/513 全生效、最优先）
2. effKind 回退逻辑保留（effLimitKind → net → total）
3. effKind === 'unlimited' → 累计不限
4. deltaShares/atLimit/utilization 缺失（含 null/undefined）→ 数据待确认
5. 保留净流出、顶格、超限、接近、正常的现有顺序
删除 sse-limited 返回值。subscriptionAllowed 缺失不推断暂停。
### 1.2 新增纯函数 chipForLimitChange(row) → null 或 { label, tone: 'up'|'down'|'flat' }
选中项：row.limitChanges[row.limitSource === 'net' ? 'net' : 'total']（不许重算分类）。
映射表：tightened+有限 ratio → 「减少至 X倍」down；tightened+ratio null → 「新增限额」down；relaxed+有限 ratio → 「新增 X倍」up；relaxed+ratio null → 「取消限额」up；选中项 unchanged 且 row.limitChange === 'mixed' → 「限额有变」flat；其它 → null。
倍数格式：m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')。防御：缺失返回 null；ratio 0 有效；undefined/NaN/Infinity 不冒充；不用旧 0.001 容差；mixed 不覆盖生效项 tightened/relaxed 的具体文案。
### 1.3 缓存/透传保持现状；previousSession 在此文件仍被日期/新鲜度函数使用，保留。

## 2. src/app/etfPcfDetailClient.js
pcfDetailSections(p) T 日 rows 末尾追加四行（逐项独立判断，字段 prefix+Kind/Shares 均 undefined 时不加行）：accountTotalSubscribeLimit→「单账户累计申购上限」、accountTotalRedeemLimit→「单账户累计赎回上限」、accountNetSubscribeLimit→「单账户净申购上限」、accountNetRedeemLimit→「单账户净赎回上限」。Shares null 或 kind unlimited → 「不设上限」；有限数字复用 formatPcfShares；数值缺失/unknown → 「—」；0 正常显示。旧 payload 保持 10+3 行顺序不变。client 请求逻辑不动。

## 3. src/pages/SharesExperience.jsx
### 3.1 imports 清理
删除本文件 previousSession import、useCallback import；新增 chipForLimitChange import；环比数值格式化从 etfPcfDetailClient 导入 formatPcfShares；pcfDetailClient 保留（抽屉用）；更新顶部注释（删除「PCF 明细/历史限额共用缓存、上一交易日推导」失效描述）。
### 3.2 AlertChip 改纯渲染
新签名 AlertChip({ row, onSelect })：const chip = chipForLimitChange(row); if (!chip) return null; 保留 code/名称/按钮/title。删除 change state、previousSession 推导、当前/上一期有效限额计算、pcfDetailClient.subscribe、两个 effect、calendar/onChange props。标签 class 沿用 .limit-change.up/down/flat（down=收紧/新增限额，up=放宽/取消限额，flat=限额有变）。旧快照无字段时直接不渲染，不回退历史请求。
### 3.3 changedCodes/alertRows 改为派生
const alertRows = records.filter(r => ['tightened','relaxed','mixed'].includes(r.limitChange));
const changedCodes = new Set(alertRows.map(r => r.code));
const chipRows = alertRows.filter(r => chipForLimitChange(r));
删除 changedCodes state、reportChange、hasEffLimit 在告警候选中的用途（头部「有限额」统计另派生 limitedRows，语义不变）。告警容器基于 chipRows.length 渲染（避免空告警条：如纯账户项变化、生效项 unchanged 时行仍高亮但无 chip 文案则不出现空容器——若 chipRows 为空就不渲染容器）。父组件只传 row、onSelect。AlertChip 点击行为（切到 ceiling 筛选）保留。
### 3.4 头部
- limitBaseline = data?.limitDate || 原 reduce 逻辑；显示条件（≠data.date 才显示）不变。
- 净流入：verified = records.filter(r => Number.isFinite(r.deltaShares))（13 只全算），netSum 同现有归约；title 改为「全部 13 只中 N 只有效净增合计（负值参与净额）」，N 动态。无有效 delta 显示 —。
- headTitle：条件追加 `上一限额日：${data.prevLimitDate}`（存在时），filter(Boolean).join('\n')；不用 prevDate/previousSession 代替。
- 头部「有限额」统计用 limitedRows 派生（hasEffLimit 判断），标签/数量/tooltip 语义与现状一致。
### 3.5 PcfDetailDrawer 传 row + 限额环比小节
调用点传 row={r}（r 在 filtered.map 中可用），其余 props 不变；组件签名加 row；详情 effect 依赖保持 [code, date, retryCount]，不加 row。
小节结构：标题行之后、请求状态之前插入「限额环比」卡（独立于详情请求状态，详情失败也显示）；row?.limitChanges == null 时整节不渲染。复用现有 card/header/kv-list 样式，不改 CSS。内容：标题「限额环比」；日期 `row.prevLimitDate → row.limitDate`（缺失端 —）；固定四行（累计申购=total、净申购=net、单账户累计申购=accountTotal、单账户净申购=accountNet），每行 before → after + 变化标签（tightened 显示与 chip 一致的「减少至 X倍」/「新增限额」，relaxed 显示「新增 X倍」/「取消限额」，unchanged「持平」，incomparable「不可比」）；limited 用 formatPcfShares，unlimited 显示「不设上限」，unknown/缺失显示 —；条目缺失显示「— → —」。
### 3.6 513 展示路径
DeltaSharesCell/TotalSharesCell 已通用，不改：有 delta+有效 creationShares 时 estimate → 「估算申购 X 万份」、exact → 「确定申购 X 万份」；总份额直接显示真实 shares/prevShares。UtilizationCell 的角标/回退逻辑保留；沪市旧快照无 delta 时显示数据待确认。
### 3.7 页脚第 3 条更新为
「沪市（513 开头）份额已接入上交所 ETF 规模数据，申赎规则取自上交所 PCF；因缺少 D 日官方净值凭证，不提供「新增金额估算」，也不使用盘中 IOPV 兜底。」
验收请求边界：首屏/筛选/搜索/排序/告警计算零 PCF 详情请求；仅展开抽屉时订阅当前标的详情；无上一限额日请求、无预取。
### 3.8 顶层 limitSummary 本次不驱动 UI（随响应缓存即可），变化行/高亮/标签全部从 records 派生。

## 4. 测试
- test/etfPcfSharesClient.test.mjs：更新两条 sse-limited 预期（无 delta → pending）；新增 513 顶格/接近/正常/超限/净流出用例；暂停优先（513 与 159，含同时顶格、累计不限的情况）；缺失 delta/utilization/atLimit 的 null/undefined；chipForLimitChange 全分支映射、net/total 选择、账户项不误选；倍数 0/0.9/1/1.1/10 与去尾零；缺失对象/null/未知 change/非法 ratio；接入测试：真实 client 接受 513 非空 delta 响应，新字段经网络与缓存原样保留。
- test/etfPcfDetailClient.test.mjs：四个单账户字段逐项出现互不连带；数值/0/null/unlimited/unknown 格式；旧 payload 10+3 行不变；四项齐全 T 日 14 行。
- test/etfSharesDetailUi.test.mjs（esbuild+Chromium 真实页面测试）：fixture 改为直接注入新变化字段（删除靠历史限额请求生成 up/down/flat 的 fixture）；首屏详情请求数改为 0；请求计数改增量断言；覆盖六种变化文案、纯账户项变化高亮、无 chip 时无空告警条、换快照后高亮同步无残留；顶层日期优先/缺失回退/上一限额日 title；513 注入真实 delta 验证全市合计、顶格/接近/暂停、estimate/exact；展开只请求当前 code/date，关开命中缓存，筛选/刷新不请求历史详情；row prop 链、环比四行、详情失败时环比仍可见、无 limitChanges 整节隐藏；.pcf-kv-row 数量断言按小节限定；新增完全无新字段的旧快照变体（页面正常、日期回退、无告警、零预取）；保留键盘/手风琴/错误重试/移动端无横向溢出；calm fixture 变化字段显式 unchanged/null。
- test/etfPcfSharesProjection.test.mjs：513 有合法 prevShares/delta/status/utilization 时通过；旧快照继续通过；差额/日期/利用率/status 不一致仍拒绝。

## 5. 实施顺序与检查
1. 先修共享校验 + 补测试；2. 改两个 client；3. 改 SharesExperience；4. 更新/补测试；5. 运行：
node --test test/etfPcfSharesClient.test.mjs test/etfPcfDetailClient.test.mjs test/etfPcfSharesProjection.test.mjs test/etfSharesDetailUi.test.mjs
npm run lint -- --quiet
git diff --check
（check:refactor 已知因 workers/ocr-proxy 行数预算失败，与本次无关，跳过并在汇报中注明。）
全部通过后提交（分支 cn，提交信息说明：份额页接入新 worker 字段：513 份额/限额环比/单账户限额）。不要 push。
