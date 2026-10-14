# 上交所纳指 ETF PCF 测试 fixtures（SSE5xxxx20261013.json）

五只纳指 ETF 的上交所「基金申购赎回清单基本信息」**真实 JSON 响应脱敏副本**，
作为 `test/ssePcfLimit.test.mjs` 等的离线数据基底，不访问 `query.sse.com.cn`。

## 来源与采集

- 请求 URL（`<code>` ∈ 513100/513110/513300/513390/513870）：

  ```
  https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=<code>&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C
  ```

- 请求头：`Referer: https://www.sse.com.cn/`（必带，否则源站拒绝）。
- 采集日期：**2026-10-13**（当日清单，HTTP 200，每只约 1.3 KB）。五只的
  `TRADING_DAY` 均为 `20261013`。
- 响应形态：源站对上述固定 URL 返回**纯 JSON**（信封内 `jsonCallBack: null`，无
  callback 包裹）。解析器同时支持 callback 包裹变体（见测试），fixture 保持源站原样。

## 脱敏范围

外层信封（`actionErrors`/`actionMessages`/`fieldErrors`/`isPagination`/`jsonCallBack`/
`locale`/`pageHelp`/`pageNo`/`pageSize`/`queryDate`/`securityCode`/`sqlId`/`texts`/`type`/
`validateCode`）与真实响应完全一致；`result` 仅保留 `result[0]` 的 17 个必要字段，
**字段值逐字节原样保留、不做任何改写**。移除的非必要字段：

`ETF_TYPE`、`FILE_ID`、`PRE_TRADING_DAY`、`PRE_CASH_COMPONENT`、`RECORD_NUM`、`FUNDID1`、
`NET_CREATION_LIMIT_PER_ACCT`、`NET_REDEMPTION_LIMIT_PER_ACCT`、`CREATION_REDEMPTION_MECHANISM`。

其中 `NET_*_PER_ACCT`（单账户净限额）按 plan 的映射表不属于本次映射范围，保留在
原始响应中但不出现在 fixture 与解析结果的结构化字段里（`rawFields` 亦不包含）。

## 预期值（2026-10-13，全部来自真实响应）

`-` 表示「未设有限上限」→ 解析为 `null` + `unlimited`（见 plan parseLimit 口径）。

| code | fundName（简称） | CREATION_REDEMPTION | CREATION_LIMIT（累计申购） | NET_CREATION_LIMIT（净申购） | CREATION_LIMIT_PER_ACCT（单账户累计申购） | REDEMPTION_LIMIT（累计赎回） | NET_REDEMPTION_LIMIT（净赎回） | REDEMPTION_LIMIT_PER_ACCT（单账户累计赎回） | CREATION_REDEMPTION_UNIT | ESTIMATED_CASH_COMPONENT（元） | MAX_CASH_RATIO | PUBLISH_IOPV | NAVPERCU（元） | NAV（元） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 513100 | 国泰纳斯达克100 | 仅允许赎回 | 2500000 | - | 500000 | 500000000 | - | - | 500000 | -9064.44 | 100% | 是 | 1035747.96 | 2.0715 |
| 513110 | 华泰柏瑞纳斯达克100（QDII） | 申购和赎回皆允许 | 2000000 | - | 1000000 | 30000000 | - | - | 1000000 | 5830.95 | 100% | 是 | 2377785.30 | 2.3778 |
| 513300 | 华夏纳斯达克100（QDII） | 申购和赎回皆允许 | - | 3750000 | - | - | 100000000 | - | 750000 | 818.37 | 100% | 是 | 1929361.85 | 2.5725 |
| 513390 | 博时纳斯达克100（QDII） | 申购和赎回皆允许 | 85000000 | - | 1000000 | 100000000 | - | - | 1000000 | 5157.08 | 100% | 是 | 2324758.37 | 2.3248 |
| 513870 | 富国纳斯达克100（QDII） | 申购和赎回皆允许 | 10000000 | - | - | 15000000 | - | - | 1000000 | -15679.93 | 100% | 是 | 1973295.06 | 1.9733 |

plan 第 6 节验收口径对应：513100 仅允许赎回但保留累计 2500000；513110 累计 2000000 /
单账户 1000000；513300 净 3750000 只进 `netSubscribeLimitShares`、累计为 unlimited；
513390 累计 85000000 / 单账户 1000000；513870 累计 10000000。五只的净申购上限除 513300
外均为 `-`（`null` + `unlimited`）。

源站更新清单后重取当日响应、按同样规则重新脱敏覆盖即可，不要手工改写值。
