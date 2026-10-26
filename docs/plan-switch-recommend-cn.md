# 换基「智能自动填充」CN 版：POST /api/notify/switch/recommend（cn-data）

## 背景

- 前端 `SwitchStrategyBoardExperience.jsx` 的「生成并填充方案」调用 `POST /api/notify/switch/recommend`，
  body `{ holdingCode, feeWanRate }`，Bearer token；期望 `{ ok: true, rule }`。
- CN nginx 把 `/api/notify/` 转给 cn-data（127.0.0.1:8081），但 `routes/data.js` 未注册该路径 → 404。
- 原实现只在 `origin/test`：`workers/notify/src/switchRecommendation.js`（日 K + 净值历史 + 回测引擎）。

## 目标

在 cn-data 内实现同语义接口，但溢价改为用**最近交易日的 1m / 5m 盘中价**计算（溢价变化快，日线不够）。

## 数据源与缓存（`src/notify/minuteKline.js`）

| 数据 | 主源 | 回退 | 内存缓存 |
| --- | --- | --- | --- |
| 1m（最近 5 个交易日） | 腾讯 `web.ifzq.gtimg.cn/appstock/app/day/query?code=sz159632` | 东财 push2his `klt=1&lmt=1250` | 90 s |
| 5m（约 500 根 ≈ 10–15 个交易日） | 本机 market-collector `/api/markets/kline/:code?tf=5m` | 东财 push2his `klt=5&lmt=960` | 180 s |
| 单位净值（最近 40 条） | 东财 fundmobapi `FundMNHisNetList` | — | 30 min |

- 只保留**有成交**的分钟（腾讯累计量增加 / collector、东财 volume>0），且只取 09:30–11:30、13:00–15:00；
  停牌（溢价过高临停）与无成交分钟的价格是陈旧价，不参与计算。
- inflight 去重；上游失败时 15 分钟内旧值兜底，否则负缓存 60 秒（避免每次点击都重打停牌/无数据的源）。
- 单个上游请求 4 s 超时；整个请求预算 9.5 s，超出返回 504 `RECOMMEND_TIMEOUT`（后台抓取继续填缓存，重试即快）。
- 12 只基金 × (1m + 5m + 净值) 并发上限 6。

## 算法（`src/notify/switchRecommend.js`）

1. 候选池固定 12 只纳指 QDII ETF：513100,159501,159941,159696,159659,159632,513300,513870,513110,159660,513390,159513。
   holdingCode 不在池内 → 400 `HOLDING_NOT_IN_POOL`（明确错误，提示手动配置）。
2. 盘中溢价% = (分钟收盘 / 参考净值 − 1)×100；参考净值取「bar 日期之前、两只基金都已公布的最新净值日」的单位净值，
   保证同一时刻两只基金用同一净值日，指数涨跌在价差中抵消。价差% = 溢价(H) − 溢价(L)，仅取两只同一分钟都有成交的点。
3. 时间粒度：任一候选与持仓的 1m 共同 bar ≥ 240 → 用 1m，否则 5m（≥ 96 根）。`backtestTimeframe` 返回实际使用的粒度。
4. H/L 分组：对每个候选，用 5m（更长窗口；不足则用主粒度）价差中位数判断，持仓溢价更高则持仓为 H。
5. 阈值：在主粒度价差分布上做分位网格（切回 lowerPct ∈ 5%~50% 分位，切出 upperPct ∈ 50%~95% 分位，取 2 位小数），
   约束 `upperPct − lowerPct ≥ 往返成本 = 2 × 单次切换成本`，单次切换成本 = 双边费率 `feeWanRate/100 × 2` + 估计滑点（1 tick / 均价）。
6. 回放：按分钟收盘逐根，H 持有且价差 ≥ upper → 切 L；L 持有且价差 ≤ lower → 切回 H；每次切换扣单次切换成本，
   用两只基金真实价格换算份额。统计触发次数、完成轮数、胜率（一轮回到起始基金后份额增加即胜）、相对一直持有的超额收益。
7. 选择：超额收益 > 胜率 > 完成轮数 > 带宽；须至少 1 轮且超额 > 0 才算 `optimized`，否则回退 20%/80% 分位（`fallback`）。
   对手方 = 11 个候选中得分最高者；另一粒度（5m 或 1m）用同一阈值回放作为 `crossCheck`。
8. 持仓：读该用户 cn-data 账本 `account_holdings_transactions`（无则 `account_resources holdings/ledger`），
   BUY − SELL 净份额 × 最新分钟价；找不到持仓按 10000 元。`feeConfig.estimatedTotalFee = 金额 × 费率 × 2`（一次切换的卖+买）。

## 返回（与前端逐字段核对）

`{ ok: true, rule: { name, highCodes[], lowCodes[], highCode, lowCode, lowerPct, upperPct, holdingSide:'H'|'L',
holdingFundCode, holdingFundName, holdingQuantity, holdingNotional, holdingSource, candidateFundCodes,
recommendedCandidate, feeConfig:{ mode:'estimated_total', estimatedTotalFee, feeWanRate, sell/buyCommissionRate, slippagePct, switchCostPct },
backtestTimeframe, backtest:{分布统计, 触发/轮数/胜率/超额, selectionStatus, crossCheck}, dataSources, dataIssues, message, generatedAt } }`。

错误：`{ ok:false, code, error }`（400 参数/池外、502 `UPSTREAM_UNAVAILABLE` / `INSUFFICIENT_MINUTE_DATA`、504 `RECOMMEND_TIMEOUT`）；
未登录 401 与无权限 403 由现有 `resolveUserId` / `rbacGuard`（`/api/notify/switch/*` → `api:fund-switch`）给出。

`backtestTimeframe` 新增 `'1m'`：`switchStrategyPort.js` 与前端 `src/app/switchStrategySync.js` 的 `VALID_BACKTEST_TIMEFRAMES`
加入 `'1m'`，否则保存时会被归一成 `'5m'`。

## 测试

`services/cn-data/test/switch-recommend.test.mjs`：固定分钟 fixture，覆盖停牌分钟过滤、净值对齐、回放计数、分组/阈值/费用、
持仓缺失与账本读取、池外代码、上游失败 502、超时 504、HTTP 401/403/200、短缓存命中。

## 部署

`services/cn-data/src` 同步到 `/opt/ai-dca-cn-data/src`（只同步本次改动文件，/opt 有生产独有文件不覆盖），
`supervisorctl -c /etc/market-collector-supervisord.conf restart ai-dca-cn-data`。前端改动经 `scripts/cn-frontend/release.sh` 发布。

## 已知局限

- 阈值为窗口内样本内优化（1m 只有 5 个交易日），完成轮数少时胜率参考意义有限；message 中给出轮数与 5m 校验结果。
- 参考净值滞后（QDII T+1/T+2 公布），单只溢价绝对值含指数漂移；价差因同净值日对齐基本抵消。
