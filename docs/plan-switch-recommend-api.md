# 重构：智能填充改为后端 recommend 接口

## 现状问题

「生成并填充方案」的最优对手方计算（180 天溢价历史回测）在浏览器里跑
（`src/app/switchCounterpartyAnalyzer.js` 的 `selectBestCounterparty`），
而弹窗文案写的是"由云端 API 匹配候选基金"，名实不符。前端还承担了
持仓读取（`readHoldingForAutoFill`）、费用计算、规则组装等本该后端的职责。

## 目标设计

```
POST /api/notify/switch/recommend
Authorization: Bearer <token>
Body: { "holdingCode": "159632", "feeWanRate": 1 }

Response: { "ok": true, "rule": { /* 完整规则配置，与现在 previewRule 同形 */ } }
```

body 只含持有基金和交易费率，所有计算在后端完成。

## 后端（services/cn-data）

1. `services/cn-data/src/routes/data.js`：新增路由
   `POST /api/notify/switch/recommend`（加到方法白名单，与 `/test` 并列）。
2. 新建 `services/cn-data/src/notify/switchRecommend.js`，导出
   `buildSwitchRecommend({ db, user, holdingCode, feeWanRate })`：
   - 校验：holdingCode 6 位数字；feeWanRate 有限数且 >= 0，否则 400。
   - 读持仓：从 `account_holdings_transactions` 按 user_id 聚合该 code 的
     quantity/notional（复刻前端 `readHoldingForAutoFill` 口径；找不到按 notional=10000）。
   - 取历史：对 holdingCode + 候选池（复刻 `defaultCounterpartyPool` 口径，
     约 20 只纳指 ETF）拉 180 天溢价历史。数据源复用后端已有的
     market-collector 通道（`fetchSwitchCollectorSnapshot` 在用的那套），
     不得新开浏览器端直连。
   - 选对手方：把 `src/app/switchCounterpartyAnalyzer.js` 的选择算法
     （meanSpread、bestLowerPct/bestUpperPct 计算）原样移植为后端函数，
     输入历史序列，输出 `{ code, bestLowerPct, bestUpperPct, stats }`。
     阈值非法（非有限数或 upper<=lower）时回退 `AUTO_LOWER_PCT`/`AUTO_UPPER_PCT`。
   - 算费用：`estimatedTotalFee = notional * feeWanRate / 10000 * 2`（保留 2 位小数）；
     `commissionRatePct = feeWanRate / 100`。
   - 组装 rule：与前端 `previewRule` 同形（含 id/name/benchmarkCodes/enabledCodes/
     premiumClass/intraSellLowerPct/intraBuyOtherPct/holdingFundCode/holdingFundName/
     holdingQuantity/holdingNotional/candidateFundCodes/feeConfig/backtestTimeframe）。
3. 错误码：参数非法 400；历史数据不足无法计算时回退默认候选（不抛错，
   与前端 `dynamicSelection = null` 的降级行为一致）。

## 前端

1. `src/pages/switch/SwitchStrategyBoardExperience.jsx`：
   `handleAutoFillRule` 简化为调 `POST /api/notify/switch/recommend`
   （带 Bearer token），直接返回 `payload.rule`。删除 `readHoldingForAutoFill`、
   `selectBestCounterparty` 调用及费用组装逻辑。
2. `src/app/switchCounterpartyAnalyzer.js`：后端移植完成后删除；
   确认无其他引用后再删。
3. `src/pages/switch/SwitchStrategyRuleModal.jsx`：`runAutoFill` 逻辑不变
   （已是透传 `onAutoFill` 结果再填表）。

## 不做的

- 不改 `/api/notify/switch/test`（dry-run 语义保留，测的就是给定配置）。
- 不改规则保存/同步链路。
- 不改 H/L 分类展示逻辑。

## 验收标准

- `POST /api/notify/switch/recommend` body 只有 `{ holdingCode, feeWanRate }`，
  返回完整 rule；用 159632 + 费率 1 实测，返回的 highCodes/lowCodes/
  阈值与现有前端计算结果一致（允许浮点末位差异）。
- 前端点「生成并填充方案」：只发两个字段，表单回填效果与现在一致。
- `grep -rn "selectBestCounterparty" src/` 无引用后删除原文件。
- 后端新 handler 有单元测试（参数校验、持仓缺失回退、阈值非法回退）。
- `npm run check:refactor`、`npx eslint --quiet`（改动文件）、`git diff --check` 通过。
