# ETF PCF 测试 fixtures

## ETF15994120261013.gbk.txt

- 来源：`https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt`
  （深交所纳指ETF广发申购赎回清单，公开披露数据；HTTP 200，25,954 字节，抓取于 2026-10-13）。
- 编码：**GBK 原始字节**原样保存。`TextEncoder` 只能输出 UTF-8，不能用于生成或修改该
  fixture，禁止用 UTF-8 文本冒充 GBK。
- 用途：`test/etfPcfLimit.test.mjs` 等在 Node 用 `new TextDecoder('gbk')` 解码断言；
  `test/etfPcfRuntime.test.mjs` 通过 `runtime-harness/` 在本地 workerd（wrangler dev，
  兼容日期与生产一致的 2026-03-26）解码同一 fixture，验证 Workers runtime 的 GBK 支持。

预期关键字段（2026-10-13 段）：

| 字段 | 值 |
| --- | --- |
| fundName / fundType | 纳指ETF广发 / 跨境ETF |
| fundManager / targetIndexCode | 广发基金管理有限公司 / NDX |
| netSubscribeLimitShares / netSubscribeLimitKind | 1300000 / limited |
| netRedeemLimitShares / netRedeemLimitKind | 1000000000 / limited |
| accountNetSubscribe / accountNetRedeem / totalSubscribe / totalRedeem / accountTotalRedeem | 不设上限（kind = unlimited） |
| accountTotalSubscribeLimitShares / accountTotalSubscribeLimitKind | 1300000 / limited |
| creationRedemptionUnitShares | 1300000 |
| subscriptionAllowed / redemptionAllowed | true / true |
| estimatedCashDifference | 4275.36（元，允许负值与零） |
| cashSubstitutionRatioLimitPct / iopvRequired | 100 / true |
| unitCashDividend | 0（元） |
| localBasketSecurityCount / totalBasketSecurityCount | 1 / 102（「102只(含"159900"证券)」） |

文件另含 2026-10-09 前一交易日信息段（现金差额 5388.00 元、最小申购赎回单位资产净值
2014903.94 元、基金份额净值 1.5499 元），用于验证「前日段不串当天」与标题日期一致性；
组合信息内容（证券明细）不在解析范围。深交所上游改版时重新抓取同日期文件原样覆盖即可，
不要手工改写字节。

## runtime-harness/

仅测试用的 workerd harness（`npx wrangler dev` 本地运行，**不部署**）：把本目录 fixture
作为 Data 模块导入，在真实 workerd 里复用生产模块 `workers/ocr-proxy/src/etfPcfLimit.js`
/ `etfPcfUniverse.js` 做 GBK 解码、KV 写入与 scheduled 模拟，由
`test/etfPcfRuntime.test.mjs` 作为子进程启动并断言。
