# 上交所纳指 ETF PCF 申赎限额扩展实现计划

本次仅新增本文档，不写实现代码、不修改源文件、不 commit、不切换分支、不 push；当前分支 cn 保持不动。后文的代码、测试与提交步骤属于后续实现任务。

依据：已阅读 `docs/plan-etf-pcf-limit.md`、`workers/ocr-proxy/src/etfPcfLimit.js`、`etfPcfRoutes.js`、`index.js` 与 `src/app/nasdaqCatalog.js`。深交所方案已实现（背景给定 commit `ede6d5e7`），现有 GET 只读缓存、POST 单 code 刷新，09:00 北京时间 cron 执行探测及全量刷新。SSE 接口 spec 与 2026-10-13 实测值直接采用任务提供的已验证事实，本次不重新在线验证、不改字段语义。

## 1. 模块设计

目标是把 513100、513110、513300、513390、513870 接入同一路由与每日任务，额度单位为基金份额，累计、净额、申赎状态各自独立。

新增 `workers/ocr-proxy/src/ssePcfLimit.js`，负责参数防御、JSONP 抓取与解析、字段映射、缓存读写、单标的服务及小名单刷新。复用 `fundLimit.js` 导出的 `mapLimit`，不修改 `fundLimit.js`。不需要 universe 探测，不需要 GBK 解码，不读取 R2，不请求组合证券明细。

### 抓取及函数契约

固定请求：`GET https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2=<code>&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C`，请求头必须带 `Referer: https://www.sse.com.cn/`。date 不加入该 URL：接口只提供最新清单。

| 计划函数 | 契约与职责 |
| --- | --- |
| `validateSsePcfRequest({code,date,now})` | 校验覆盖名单与可选 YYYY-MM-DD 日期；保留 date 是否缺省，不提前替换 POST 缺省日期 |
| `parseSsePcfJsonp(text)` | 纯函数，严格提取一个合法 callback 包裹的 JSON，再 JSON.parse；取 result[0]，不使用 eval/Function |
| `parseLimit(raw)` | 返回 `{shares,kind}`，执行 SSE 专用额度口径 |
| `mapSsePcfFields(row,{code,now})` | 验证 TRADE_CODE、8 位 TRADING_DAY 及必要字段，生成结构化对象 |
| `buildSsePcfCacheKey(code,date)` | 再次校验名单及真实公历日期，生成唯一结果 key |
| `readSsePcfLimitCache({code,date,env,now})` | 仅 memory/KV，返回现有风格 `{ok,status,data?,reason?,error?}` |
| `fetchSsePcfLimit({code,date,env,forceRefresh=false,now,fetchImpl,signal})` | 缓存优先或显式刷新；抓取、解析、日期核对、await 写入后返回 |
| `refreshSsePcfLimitCache({env,now,fetchImpl})` | mapLimit 并发 2 刷新覆盖名单，逐项隔离并分类汇总 |

JSONP 支持 callback 名变化、两侧空白及可选末尾分号，拒绝额外可执行文本、非法包裹、非法 JSON、错误页和非对象 result[0]。每次请求采用全程 5 秒超时、abort 清理、拒绝跳转、响应体最大 1 MiB；消费或取消 body 后再重试。HTTP 200 空正文或合法 JSONP 的空 result 视为瞬态空响应，最多总计 3 次尝试，退避 200ms/500ms；超时、网络错误、429/5xx 同样受此上限，重试在原 mapLimit lane 内执行。404、非法 JSONP、损坏字段及日期不匹配不重试；外部 abort 立即退出。重试耗尽的空响应返回 502 `empty_response`，不得解释为额度 0 或暂停申购。

### 字段映射与 parseLimit

沿用已有结构化字段名称；SSE 对象 `schemaVersion:1`、`source:sse_pcf`，保存 `tradingDay:YYYYMMDD` 及 `date:YYYY-MM-DD`。保留必要原始字段到 rawFields，附 sourceUrl、fetchedAt、expiresAt、warnings；cached 仅添加于响应，不持久化。不臆造上游未提供的基金类型、目标指数或单账户净限额。

| SSE 字段 | 输出字段 / 处理 |
| --- | --- |
| TRADING_DAY / TRADE_CODE | tradingDay、date / code，必须与请求身份吻合 |
| FUND_NAME / FUND_COMP_NAME | fundName / fundManager |
| CREATION_REDEMPTION | creationRedemption 原文、subscriptionAllowed、redemptionAllowed |
| CREATION_REDEMPTION_UNIT | creationRedemptionUnitShares，正安全整数，不能套额度的零哨兵规则 |
| CREATION_LIMIT / NET_CREATION_LIMIT | totalSubscribeLimitShares / netSubscribeLimitShares |
| CREATION_LIMIT_PER_ACCT | accountTotalSubscribeLimitShares |
| REDEMPTION_LIMIT / NET_REDEMPTION_LIMIT | totalRedeemLimitShares / netRedeemLimitShares |
| REDEMPTION_LIMIT_PER_ACCT | accountTotalRedeemLimitShares |
| ESTIMATED_CASH_COMPONENT | estimatedCashDifference，有限数，保留负数和数值零 |
| MAX_CASH_RATIO / PUBLISH_IOPV | 保存原始值；按真实 fixture 中明确的百分比/比例表示和公布标记映射 cashSubstitutionRatioLimitPct / iopvRequired，不猜单位或未知标记 |
| NAVPERCU / NAV | navPerCreationUnit / nav，分别保存，不互相推导或填充 |

每个额度字段对应 `…LimitKind`。**parseLimit 将 trim 后的 `""`、`"-"`、`"0"` 全部映射为 null + unlimited（未设有限上限），不能生成数值 0 的 limited，也不能以此推断允许申购。** 正整数字符串转为正安全整数 + limited；缺字段为 null + unknown 并记录 warning，负数、小数份额、溢出或非数字损坏拒绝解析/写入。此规则只用于上限字段，不用于现金、NAV 或申赎单位。

“申购和赎回皆允许”映射 true/true，“仅允许赎回”映射 false/true；未知状态为 null/null 并记录 warning，保留原文。即使禁止申购也保留公布的累计额度；累计与净额互不回填，账户与全市场互不回填。513300 的 3750000 只能进入 netSubscribeLimitShares。

### KV 决策与边界

**不直接复用 etfPcfLimit.js 的 KV 读写函数，也不修改该模块逻辑。** 现有 validateEtfPcfRequest/buildEtfPcfCacheKey 仅接受 159xxx，validateEtfPcfCachedData 固定 source=szse_pcf 并要求深交所特有形态；直接调用会拒绝 SSE。新模块独立实现 SSE 校验及 memory/inflight，复用相同缓存契约与 FUND_LIMIT_KV binding。现有 SZSE schema 已有 source，不需要迁移；SSE 使用 sse_pcf，错误来源一律视为 miss。

key 统一为 `etf-pcf:<code>:<yyyymmdd>`，51xxxx 与 159xxx 不重叠，无冲突。SSE 从已校验的 TRADING_DAY 构造日期，例如 `etf-pcf:513300:20261013`；历史身份唯一键为基金代码 + 清单日期，绝不使用抓取日期。固定 `expirationTtl:86400`（24h），expiresAt 从成功抓取时间计算，读取不延长 TTL。这里的日期隔离缓存不是永久历史数据库。

读取顺序 memory → KV 小对象；只有 POST/cron 明确刷新可回源。校验 source、schemaVersion、code/date/tradingDay、额度与 kind 配对、状态和字段形态、fetchedAt/expiresAt（过期、未来时间与异常 TTL）。损坏/身份不符视为 miss；KV 缺 binding 或读失败返回 503。写前再次核对 code 和接口日期，await KV put 成功才进入 memory、返回成功；失败不覆盖有效旧值。无 date 的刷新以 code+latest 做 inflight 去重，指定日期按 code+date 去重，finally 清理；两者最终都写同一个 code+TRADING_DAY key，不建立第二套结果缓存。

## 2. 名单来源

**选择 (b)：worker 内硬编码冻结的 5 个 code，供服务校验、路由覆盖判断和 cron 共同使用。** 排序为 513100、513110、513300、513390、513870，不能在三个入口各维护一份。

(a) 从 NASDAQ_ETFS 过滤 `^51\d{4}$` 可以与前端同源并自动跟随新增 ETF；fundLimit.js 已引用 `../../../src/app/marketsWatchlistStorage.js`，说明该路径形式有先例。代价是 Worker 覆盖范围随前端目录和名单变化，新增即自动带入抓取，超出本次 dudu 已确认的固定 5 只范围。

(b) 简单稳定，不引入前端依赖，能明确未覆盖代码的 404；代价是新增纳指 ETF 需要显式修改 Worker 名单及测试。本次以固定范围为准，接受维护成本，不改 nasdaqCatalog.js；名单测试核对当前这 5 只即可，不扩展到 SP500_ETFS、US50_ETFS 或全部沪市 ETF。

## 3. 路由

修改现有 etfPcfRoutes.js 的调度层，保持 index.js 的 `/api/etf-pcf-limit` 入口与 jsonResponse/CORS 模式。先完成 method/body/query 和 code 格式校验，再按前缀选服务，避免将 51xxxx 交给仅接受 159xxx 的旧 validator。

| 输入 code | 分发 / HTTP 行为 |
| --- | --- |
| 159xxx（例如 159941） | 原深交所 readEtfPcfLimitCache / fetchEtfPcfLimit；原日期与错误行为不变 |
| 513100、513110、513300、513390、513870 | SSE 对应缓存读取 / 单标的刷新 |
| 其它合法 51xxxx（例如 513500） | 404 `unsupported_code`，说明当前未覆盖；fetch/KV 调用为 0 |
| 其它前缀的六位代码 | 沿用现有 400 invalid_code 行为 |
| 缺失、数字类型、数组、空白、非六位 code | 400；不调用外部或 KV |

GET 仍只读缓存；任何 refresh/force 开关均忽略。指定 date 查询对应日期 key，已有有效历史日期缓存可以返回；缺失/过期返回 404 cache_miss，不为验证源站最新日期而联网。**GET date 缺省仍按现有上海当天查缓存**，不扫描 KV、不引入 latest 指针、不自动回退上一交易日。因此休市时即使 cron 缓存了上一清单日，无 date GET 仍可能 miss，调用者可显式查询已知清单日期。

POST JSON `{code,date}` 一次只刷新一个 code，服务端 forceRefresh:true，客户端不能启用 GET 强刷或批量刷新。SSE 的 date 是“期望源站返回的清单日期”，不是历史抓取参数：

- 缺省 date：抓取最新清单，用接口 TRADING_DAY 入库并在响应返回对应 date；不以上海当天/抓取日期替代。
- 指定 date：验证 YYYY-MM-DD 真实日期及现有范围（2000-01-01 至上海当天），转为 8 位后与 TRADING_DAY 比较；不一致返回 404 `upstream_not_found`，附日期不匹配说明，不写请求日期或任何伪造历史缓存。GET 查询已存历史不受此 POST 限制。
- 指定 date 一致：同样以接口清单日期构造 key，await 写入后返回 200 cached:false。

重复 query、畸形 JSON、非对象 body、codes 数组均维持 400；其它 method 为 405 + Allow: GET, POST, OPTIONS；OPTIONS 继续全局处理。错误对象沿用 `{error,reason,code?,date?}`。SSE HTTP 404 为 404 upstream_not_found；超时/abort 504；HTTP/网络/空响应/JSONP/字段解析失败 502；KV 不可用/读写失败 503。未知状态不等于关闭，抓取失败不删除缓存。

## 4. cron

现有 `0 1 * * *`（UTC 01:00，北京 09:00）分支追加 SSE 5 只刷新，不增加 cron、不改 wrangler binding、不改 `0 12 * * *` 场外任务。index.js 使用 ctx.waitUntil 托管一个调度包装：先执行小规模 SSE 阶段，再调用原 runEtfPcfScheduledRefresh；分别捕获阶段异常并汇总，SSE 抛错也必须继续 SZSE，SZSE 失败也不丢失已完成 SSE 结果。深交所模块、探测与现有预算逻辑保持不动。

SSE 使用 mapLimit 并发 **2**，与深交所阶段不重叠；每只最多 3 次尝试，正常 5 次请求、最多 15 次，不需要 1000-code 探测，不读写 etf-pcf-universe:v1。以 controller.scheduledTime 注入确定性的 now；SSE 刷新不传由 scheduledTime 推导的强制 date，清单身份始终取 TRADING_DAY。非交易日源站返回上次清单时写该实际日期，不伪造当天。

每项返回分类结果，处理 mapLimit 的 __error，不因单只失败中断其余基金。成功逐项 await 落 KV；刷新失败不覆盖旧值。独立 sse 统计包含 total、success、notFound、fetchFailed、parseFailed、kvWriteFailed、skippedDeadline、durationMs，并记录 attempts/retries 和失败 code/reason；与现有 SZSE 分类口径一致，分类合计必须等于 total=5。空响应耗尽计 fetchFailed，JSONP/字段损坏计 parseFailed，日志不输出整份响应。设置 SSE 阶段 60 秒软预算，到期停止分配、取消请求并分类跳过；不延长深交所原预算，额外耗时与组合任务时长需在本地模拟中记录。

## 5. 测试计划

使用 node:test + mock fetch + fake KV，全程不依赖在线源站。fixture 放 `test/fixtures/etf-pcf-sse/`，保存 2026-10-13 五只基金的**真实 JSONP 响应脱敏副本**，仅保留 result[0] 上述必要字段及 JSONP 包裹；README 记录来源 URL、Referer、采集日期、脱敏范围及预期值。当前任务只写计划，尚未取得或保存这些原始响应；后续须取得该日留存样本，不用当前最新响应冒充该日，不按预期值手造并标称“真实”。在真实样本上派生变体用于异常测试。

| 测试范围 | 必须覆盖 |
| --- | --- |
| ssePcfLimit 纯解析 | callback 名变化、空白/分号、非法 JSONP/JSON/额外脚本、空 result、非对象 result[0]、错 TRADE_CODE、非法/缺失 TRADING_DAY；无需 GBK |
| 额度与字段映射 | `-`、`0`、空串都是 null/unlimited，缺字段 unknown；正整数、溢出/负数/小数；现金零及负数不受额度规则影响；累计/净/状态和账户维度分离；513300 净 375万不进入累计，513100 禁申购仍保留累计 250万 |
| fetch 与重试 | 固定 URL/Referer；空正文/空 result 后成功、连续空响应耗尽；网络/超时/429/5xx；非法 JSONP 与 404 不重试；尝试上限、abort、body 清理、超限；最大外部并发 2 |
| memory/KV 与写入 | 命中、过期、错误 source（含 szse_pcf）、schema/身份/形态/时间异常、损坏 JSON、KV 读写失败；精确 key/TTL、await put；抓取日期 10-14 但 TRADING_DAY=20261013 只写 20261013；非法 code/date/key 不访问 KV/fetch；失败不覆盖旧值、inflight 合并及清理 |
| etfPcfRoute | 159941 走 SZSE、513100 走 SSE、513500 返回 404、非法 code 400；GET 命中/miss/过期及 refresh/force 都 fetch=0；POST 缺省/指定日期匹配和不匹配 404 且 put=0；GET 已有历史可读；默认上海日期、重复参数、非法 JSON/body、批量拒绝、405 与错误分类 |
| mock scheduled | 09:00 恰好刷新 SSE 5 只，无 SSE 探测；一只 throw/空响应/解析/写失败，其余继续；阶段异常不阻断另一市场；分类合计 5、并发 2、重试/软预算；scheduledTime 与返回清单日不同仍写清单日；原 SZSE 调度及 20:00 cron 回归 |

后续实现步骤：先取得真实 fixture 并完成纯解析测试，再完成抓取/缓存/重试，随后接入路由及 cron，最后运行 SSE 与原 PCF 回归及提交检查。预计新增 `test/ssePcfLimit.test.mjs`，扩展现有 `test/etfPcfRoute.test.mjs`、`test/etfPcfScheduled.test.mjs`；以仓库已有 harness 为准，不增加生产测试路由。

后续提交前至少执行 `node --test test/ssePcfLimit.test.mjs test/etfPcf*.test.mjs test/fundLimitRoute.test.mjs test/fundLimitOverview.test.mjs`、`npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`。lint 目前只扫描 src，不能宣称它验证了 Worker；Worker 依靠相关 Node 测试及必要本地 mock runtime 验证。本次纯计划不运行实现测试、不提交。

## 6. 验收标准

以下均为后续实现的可勾选标准。

- [ ] 2026-10-13 五只真实 fixture 的 code/date/source 均正确；source=sse_pcf，date=2026-10-13、tradingDay=20261013。
- [ ] 513100：subscriptionAllowed=false、redemptionAllowed=true（仅允许赎回），totalSubscribeLimitShares=2500000、netSubscribeLimitShares=null/unlimited；状态不抹除累计额度。
- [ ] 513110：totalSubscribeLimitShares=2000000、accountTotalSubscribeLimitShares=1000000、netSubscribeLimitShares=null/unlimited。
- [ ] 513300：netSubscribeLimitShares=3750000、totalSubscribeLimitShares=null/unlimited；净额不写入累计字段。
- [ ] 513390：totalSubscribeLimitShares=85000000、accountTotalSubscribeLimitShares=1000000、netSubscribeLimitShares=null/unlimited。
- [ ] 513870：totalSubscribeLimitShares=10000000、netSubscribeLimitShares=null/unlimited。
- [ ] 本文路由分发表逐项通过：159→SZSE、名单内51→SSE、名单外51→404、其它前缀及非法 code→现有400；不发生错误模块调用。
- [ ] GET 只读 memory/KV，refresh/force 任意值均无外部请求；缺省查上海当天，显式历史日期只查该 key。
- [ ] POST 缺省用接口日期；指定日期不一致返回404且不写 KV，不伪造历史；成功对象日期与写入 key 一致。
- [ ] 所有入口共享 `etf-pcf:<code>:<yyyymmdd>` 格式，SSE 精确示例 `etf-pcf:513300:20261013`；TTL=86400（24h），错误 source/过期数据为 miss，写入前身份防御通过。
- [ ] 09:00 cron 追加 5 只 SSE，mapLimit 并发2、分类计数与失败隔离通过；SSE 无探测阶段，原 SZSE 探测、解析、缓存和路由行为不变，20:00 场外任务不变。
- [ ] 五只真实 fixture、无在线依赖的相关 node:test、check:refactor、lint -- --quiet、git diff --check 通过，测试明确断言“不调用”和“不写入”。
- [ ] 后续终点为代码 + 测试 + commit 到 cn；只提交本功能文件，不混入工作区已有无关文件，不部署、不 push。

### 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Referer 要求或源站策略改变 | 固定正确请求头并以 mock 断言；HTTP 错误分类，不换第三方源掩盖失败 |
| JSONP callback/包裹变化 | 支持合法 callback 名变化，严格解析、不执行脚本；格式错误单独统计，真实 fixture 回归 |
| 接口偶发空响应 | 同 lane 有限重试与退避；耗尽返回失败，不写空数据，不推断额度或状态 |
| 最新清单与请求日不同 | TRADING_DAY 唯一身份；POST 显式日期不匹配404，GET 不联网验证、不自动回退 |
| 真实历史样本未取得 | 后续从已验证留存响应获取五只当日 fixture；缺样本不把合成响应称为真实验收证据 |
| 双市场任务耗时、KV 一致性 | SSE 小并发与60秒预算、两个阶段隔离统计；await写入，保持24h业务过期校验，不承诺永久历史或全球即时可见 |

### 明确不做

- 当前任务仅产出 `docs/plan-etf-pcf-sse.md`；不写实现代码、不修改任何源文件、不 commit、不切换分支、不 push，不在仓库根新增文档。
- 后续实现不修改深交所模块 etfPcfLimit.js/etfPcfUniverse.js 的逻辑，不修改 fundLimit.js；只对公共路由和 index 调度做必要接入。
- 不碰前端、列表请求、nasdaqCatalog.js，不扩展至其它沪市 ETF；不加 universe 探测、GBK 解码、R2、永久历史库或历史回源。
- 不部署、不 push，不新增批量 HTTP 刷新入口、cron 时间或自动交易日回退；后续终点明确为代码 + 测试 + commit 到 cn。
