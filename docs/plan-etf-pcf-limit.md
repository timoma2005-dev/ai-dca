# 深交所 ETF PCF 申赎限额实现计划（完整版）

编写时已执行 `git rev-parse --abbrev-ref HEAD`，当前分支为 `cn`。本次仅修订本计划，不写实现代码、不修改源文件、不 commit、不切换分支、不 push。下述实施与提交步骤属于后续实现任务。

## 1. 目标

在 ocr-proxy Worker 内实现深交所 ETF 申购赎回清单的抓取、GBK 解码、完整当日字段解析、KV 缓存、单标的查询/手动刷新和每日全量刷新。

范围为深证 `159xxx` ETF（容量估计约 600 只，动态发现，不硬编码数量）；数据仅来自深交所 PCF 文本，额度单位是基金份额，不能当作场外基金人民币申购限额。解析基本信息与指定日期的整段信息，不解析组合证券明细，不接前端，不修改已有 fund-limit 业务。

## 2. 方案

### 2.1 现状与模块组织

已阅读 `fundLimit.js`、`index.js`、`wrangler.toml`、根 `AGENTS.md` 和 `docs/plan-holdings-group-toggle.md`。现有 fund-limit 采用多源抓取、merge、`limit:<code>` KV 缓存和并发 4 的批量刷新；实际 GET/POST 委托 `fundRoutes.js`，GET 只读缓存、POST 强刷。现有 `0 12 * * *` cron 在北京时间 20:00 顺序刷新限额和 overview。

新增 `workers/ocr-proxy/src/etfPcfLimit.js`，沿用缓存与调度模式，但采用单一权威源，不引入 LLM、多源 merge 或金额解析器。复用 `fundLimit.js` 导出的 `mapLimit`，不修改该文件。新增 `etfPcfUniverse.js` 负责基于 159000–159999 文件存在性探测的发现与 KV 名单缓存/校准，新增 `etfPcfRoutes.js` 管理参数与 HTTP 映射；`index.js` 只增加 import、路由和独立 cron 分支。

计划函数契约（签名为设计说明）：

| 函数 | 输入与输出 | 职责 |
| --- | --- | --- |
| `validateEtfPcfRequest({ code, date, now })` | 返回规范化 code/date/dateKey，或参数错误 | 路由、单标的服务、批量写入共同使用 |
| `decodeEtfPcf(bytes)` | ArrayBuffer/Uint8Array → string | `new TextDecoder('gbk', { fatal: true })`，拒绝非法字节 |
| `parseEtfPcf(text, { code, date })` | → 基本信息、当日结构化字段、rawFields | 纯解析，无网络/KV；校验代码与日期 |
| `fetchEtfPcfText({ code, date, fetchImpl, signal })` | → bytes/sourceUrl 或分类错误 | 固定 HTTPS 域名、文件名，下载及状态检查 |
| `readEtfPcfLimitCache({ code, date, env, now })` | → `{ ok, status, data?, error? }` | 仅查 memory/KV，不访问外部源 |
| `fetchEtfPcfLimit({ code, date, env, forceRefresh = false, now })` | → 同上 | 默认缓存优先；抓取、解析、校验、await KV 写入 |
| `probeEtfPcfExists({ code, date, fetchImpl, signal })` | → exists / notFound / 分类错误 | HEAD 探测固定文件 URL；不支持 HEAD 时有限 GET 并消费/取消响应体，404 正常跳过 |
| `discoverEtfPcfUniverse({ env, date, concurrency = 5, now })` | → 当日有效 codes、探测统计、名单 diff、是否完整 | 枚举全部 1000 个 code，mapLimit 探测，对比并校准 KV 名单 |
| `loadEtfPcfUniverse({ env, now })` | → codes、source、fetchedAt、是否降级 | memory/KV 优先读取已校验名单，供日常刷新与发现失败降级；不以缓存替代每日探测 |
| `refreshEtfPcfLimitCache({ env, date, concurrency = 5, now })` | → 批量统计与分类失败 | mapLimit、执行预算、失败隔离 |
| `handleEtfPcfLimit(request, env, ctx, searchParams)` | → Response | GET/POST 分发，禁止通过 GET 强刷 |

抓取 URL 为 `https://reportdocs.static.szse.cn/files/text/etf/ETF<code><yyyymmdd>.txt`，使用 `arrayBuffer()`，不得用 `response.text()` 将 GBK 当 UTF-8。单请求超时 5 秒，覆盖下载响应体全过程，finally 清理 timer；拒绝跳转（避免隐藏子请求），下载最大 1 MiB，流式累计超限立即取消。单 code 外部调用也经过 `mapLimit([code], 1, ...)`，批量不使用全量 Promise.all。

**Workers 编码支持确认：** Workers 的 workerd 运行时支持 GBK TextDecoder；Cloudflare 的 CJK 解码兼容开关从 2026-03-03 默认启用，仓库兼容日期为 2026-03-26，已覆盖该开关，无需引入 GBK npm 库或改兼容日期。依据：[Cloudflare 兼容开关](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)、[workerd 兼容日期定义](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp)、[Cloudflare Workers 类型定义](https://github.com/cloudflare/vite-react-template-brayden/blob/main/worker-configuration.d.ts)。通用 [Encoding 文档](https://developers.cloudflare.com/workers/runtime-apis/encoding/) 的简述仅提 UTF-8，不应据此推断只能解 UTF-8。实现阶段仍须以当前兼容日期在本地 workerd/Miniflare 跑 GBK fixture 做运行时验证；Node 测试成功不能替代这项验证。此处未执行线上 Workers 验证。

### 2.2 解析规则与输出 schema

按行规范化 CRLF、BOM、全角冒号和字段两侧空白；识别「基本信息」及 `YYYY-MM-DD日 信息内容` 段落，只提取请求 date 对应段，到下一个日期标题或「组合信息内容」结束。不能全文件模糊匹配，不能把前一交易日净值或「单个证券账户」额度当作当天全基金额度。基本信息代码、文件标题日期、当日段落日期必须与请求一致；同名字段冲突拒绝写缓存。

成功对象：

| 字段 | 类型/单位 | 含义 |
| --- | --- | --- |
| `schemaVersion` / `source` | `1` / `szse_pcf` | 固定版本与来源 |
| `code` / `date` | string | 6 位代码 / 上海业务日 YYYY-MM-DD |
| `fundName` / `fundType` / `fundManager` / `targetIndexCode` | string 或 null | 基本信息，名称、代码、类型为必需 |
| `netSubscribeLimitShares` / `netRedeemLimitShares` | 非负安全整数或 null，份 | 当天净申购/净赎回份额上限 |
| `netSubscribeLimitKind` / `netRedeemLimitKind` | `limited` / `unlimited` / `unknown` | 分开表达 0、不设上限、缺失 |
| `creationRedemptionUnitShares` | 正安全整数或 null，份 | 「最小申购、赎回单位」是同一个单位字段，不拆成两个猜测值 |
| `subscriptionAllowed` / `redemptionAllowed` | boolean 或 null | 允许/是/开放 → true；不允许/否/暂停 → false；未知 → null |
| `estimatedCashDifference` | 有限 number 或 null，元 | 预估现金差额，允许负值和零 |
| `cashSubstitutionRatioLimitPct` / `iopvRequired` | 0–100 number 或 null / boolean 或 null | 现金替代比例上限、是否公布 IOPV |
| `unitCashDividend` | 有限 number 或 null，元 | 最小申购赎回单位现金红利 |
| `localBasketSecurityCount` / `totalBasketSecurityCount` | 非负安全整数或 null | 本市场/全部组合证券只数，保留尾注到 rawFields |
| `accountNetSubscribeLimitShares` / `accountNetRedeemLimitShares` | 非负安全整数或 null，份 | 单账户当天净申购/净赎回上限 |
| `totalSubscribeLimitShares` / `totalRedeemLimitShares` | 非负安全整数或 null，份 | 当天累计可申购/可赎回上限 |
| `accountTotalSubscribeLimitShares` / `accountTotalRedeemLimitShares` | 非负安全整数或 null，份 | 单账户当天累计可申购/可赎回上限 |
| 上述六个额外额度对应的 `…LimitKind` | 同净申赎 LimitKind | 区分有限、无限制、未知 |
| `rawFields` / `basicRawFields` | 字段名 → 原文字符串 | 保留当日整段与基本信息全部字段，未知字段不丢失；不存组合明细 |
| `warnings` | string[] | 可选字段缺失或无法识别的说明 |
| `sourceUrl` / `fetchedAt` / `expiresAt` | string / UTC ISO 时间 | 审计、业务过期检查 |
| `cached` | boolean，仅响应增加 | 不写进持久化数据 |

精确匹配完整 label，份额可接受千位分隔符、去除明确的「份」单位；0 保留，超安全整数或小数份额拒绝。`不设上限/不限` 映射 null + unlimited，空值/横线映射 null + unknown，不将大数哨兵推断为无限制。必需基础信息/日期缺失、核心净申赎上限 label 缺失或其数字损坏视为格式错误；明确空值可为 unknown。可选字段缺失保留 null + warning，不能补成 0 或允许。

已实际读取 [159941 示例文件](https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt)（HTTP 200、25,954 字节，GBK）：2026-10-13 段净申购 1300000 份、净赎回 1000000000 份、最小单位 1300000 份、申赎均允许、预估现金差额 4275.36 元；基本名称「纳指ETF广发」、类型「跨境ETF」。文件另有 2026-10-09 信息段与账户额度，必须纳入防串字段测试。

### 2.3 KV 设计与写读路径

复用 `FUND_LIMIT_KV`；结果 key 为 `etf-pcf:<code>:<yyyymmdd>`，例 `etf-pcf:159941:20261013`。固定 `expirationTtl: 86400`，从抓取成功时间算 24h；不复用 `limit:*`，不写 raw 文本、candles 或 R2。

顺序为请求内/inflight memory → KV 小对象 → 外部源（仅明确刷新或内部缓存优先服务）。GET 在 memory/KV 缺失后立即返回 404。memory 与 KV 共用身份和过期校验；memory 不延长 TTL，首次读取 KV 不得重算 expiresAt。

KV 读取必须验证 source、schemaVersion、code/date、数据形态、fetchedAt/expiresAt 有效且未过期（包括未来时间异常），失败视为 miss；JSON 损坏视为 miss，KV 服务异常返回 503。单标的与 cron 只使用同一个 key 构造器，进入模块后再次校验；URL 和 KV key 不接受原始输入拼接。写前再次核对输出身份与形态。

POST 和 cron 成功抓取并解析后必须 **await KV put**，成功写入才计为刷新成功；写入失败返回 503/批量 kv_write_failed，不能宣称已缓存。缺 binding 在访问外部前返回 503。刷新失败不覆盖同日有效旧值，不冒充成功，不返回其它日期数据。模块内以 code/date 为 key 去重 inflight，完成后 finally 清理；不同 isolate 无全局锁保证。

### 2.4 路由设计

- `GET /api/etf-pcf-limit?code=159941&date=2026-10-13`：只读缓存，命中 200 返回 schema + cached:true；缺失/过期 404 `cache_miss`。date 缺省为当天 `Asia/Shanghai` 日期。即使携带 `force=1` 或 `refresh=1` 也绝不抓取上游（忽略该开关）。
- `POST /api/etf-pcf-limit`，JSON `{ "code": "159941", "date": "2026-10-13" }`：单 code 明确手动刷新，date 同样可省略；服务端传 forceRefresh:true，成功写 KV 后 200 + cached:false。客户端不控制 forceRefresh，不支持 codes 数组或批量刷新。
- 非法参数/JSON/重复 code 或 date 参数返回 400；其它 method 返回 405 + Allow: GET, POST, OPTIONS；OPTIONS 复用现有全局 CORS。成功返回数据对象，错误返回 `{ error, reason, code?, date? }`，沿用 `jsonResponse`。
- POST 上游 404 返回 404 `upstream_not_found`；上游超时 504，HTTP/解码/解析错误 502，KV 缺失/读写失败 503。区分缓存 miss 与文件不存在，不把缺失当作申赎关闭。

### 2.5 cron 设计

增加 `0 1 * * *`（UTC 01:00，北京时间每天 09:00），保留 `0 12 * * *` 原分支。仍选 09:00：VM 实测 1000 code 探测约 3–5 分钟，再加约 600 个有效文件抓取约 2–4 分钟及 KV 写入，正常预计 5–9 分钟以上，预留到 09:30 开盘的 30 分钟仍有余量；不能再按仅抓取 571 个文件论证。Workers 实际耗时必须测量，不保证所有文件在 09:00 前发布；提前 cron 可能增加未发布的 404，故不提前。晚发布文件可 POST 手动补刷，首轮观察发布率与阶段耗时后再调整时间，不增加隐藏回源。

scheduled 根据 controller.cron 独立分发，用 controller.scheduledTime 换算上海业务日期，避免执行跨日期或测试使用当前时钟漂移。ETF 分支通过 ctx.waitUntil 托管整个刷新：**探测发现（159000–159999，共 1000 code，mapLimit）→ 对比 KV 名单（新增/消失记日志并告警）→ 对当日探测有效名单逐项抓取、解析、await 写 KV**。发现不完整时走上一有效 KV 名单降级刷新，明确记录未完成校准。日常非发现刷新使用 KV 名单。

分阶段记录 probeTotal、probeExists、probeNotFound、probeFailed、probeSkippedDeadline、probeDurationMs、addedCodes、missingCodes、removedCodes、degraded，以及抓取阶段 total、success、notFound、fetchFailed、parseFailed、kvWriteFailed、skippedDeadline、durationMs、universeSourceAge；探测分类合计等于 1000，抓取分类合计等于 total。不把结果写入 fund-limit overview。

## 3. 关键决策点与取舍

### universe 来源：采用 (a)+(c)，深交所文件探测为准，KV 名单缓存与降级

已验证 eastmoney push2 clist 的 `fs=b:mk0021` 分页拉全 1357 条后，仅得到 571 个 159xxx，仍遗漏真实深市 ETF：159941、159632、159659 均不在其中。159941 的 [2026-10-13 深交所文件](https://reportdocs.static.szse.cn/files/text/etf/ETF15994120261013.txt) 正常可访问，GBK 解码可解析「当天净申购的基金份额上限：1300000份」。因此 clist 不能作为完整 universe 来源，取消分页发现与分页完整性门槛。

拍板采用 **(a)+(c)**：(a) 每日枚举 `159000–159999` 的全部 1000 个合法代码，探测 `https://reportdocs.static.szse.cn/files/text/etf/ETF<code><yyyymmdd>.txt`；优先 HEAD，实施时确认其状态与 GET 一致，不支持 HEAD 时使用受大小/超时限制的 GET。200 表示当日文件存在，404 正常跳过，超时/429/5xx 等归为探测失败，不能当作不存在。(c) KV 维护 `etf-pcf-universe:v1`，包含 codes、source=`szse_pcf_probe`、fetchedAt、lastProbeDate、total 及逐 code 的 lastSeenDate/连续消失计数，TTL 7 天；codes 去重排序，严格匹配 `^159\d{3}$`，身份、source、时间、形态和计数均需校验。仅完成全部探测且无未决错误的校准才更新 fetchedAt，部分结果不得冒充完整名单。

取舍：深交所源站是唯一事实来源，覆盖新上市、跨境等特殊 ETF，不依赖第三方板块分类；代价是每日约 1000 次探测与约 600 次有效文件抓取，必须重新预算。KV 名单稳定可审计，日常刷新优先读取它，源站抖动时可降级使用不超过 7 天的上一有效名单；代价是需要维护 diff、消失计数和校准状态。每日探测仍为准，KV 不是另一个权威源。深交所官网 ETF 名录接口 (b) 仅为未验证的备选研究项，本计划不采纳、不深入验证。

新增/消失均记录代码和日期并告警；不输出正文。发现失败或未完成时可降级使用已校验旧名单，无可用名单则报告失败，不把部分发现写成完整名单。不扫描 R2。非交易日/全量 404 或相较旧名单骤降超过 20% 视为发布/源站异常，保留名单、不推进消失计数；非空且无骤降的完整校准中，某 code 连续 5 个有效校准日消失才从持久名单移除，重新探测出现即恢复并清零计数。有效校准日不等同自然日，源站错误及未完成扫描不累计。被保留但当日 404 的 code 不进入当日正常抓取名单。

### mapLimit 并发：探测 5，抓取 5，阶段顺序执行

探测与抓取分别用 **5**，考虑 Workers 同时出站连接上限 6，给 KV 操作留一条连接余量。每个 lane 先消费/取消 HTTP body，再进行下一请求或 await KV put；无后台写入堆积，两个阶段不重叠，不另开重试并发池。HEAD 不支持时 GET 替代也计入预算，VM 3–5 分钟不能视为 Workers 性能保证。

约 600 文件分 120 波，平均每波 1–2 秒约 2–4 分钟（另计 KV）；叠加探测正常约 5–9 分钟以上。两阶段全部超时的理论耗时超过 15 分钟，不能承诺全量完成。整个 job 使用 12 分钟软 deadline，到期停止分配并取消外部请求，留 3 分钟汇总；探测未完成走降级仅在剩余预算允许时执行，否则记录跳过。记录两个阶段耗时与截断原因，实测超预算再另行规划拆分。

外部请求尝试总上限 **2200**：正常 1000 探测 + 约 600 抓取；最坏 1000 探测 + 1000 抓取仍有 200 次余量。HEAD→GET 替代与重试均计入此上限，若需要大量替代则直接选 GET 探测，避免每 code 双探测。单个瞬态错误最多额外一次，总重试不超过初始任务数的 10%，同时受总次数与 deadline 约束；404、解码、解析错误不重试。达到预算明确保留失败/跳过列表，POST 后续补刷。

### 失败隔离

每项返回分类结果，mapLimit 自身异常捕获也转为失败统计，不因单项 throw 拒绝整批。成功立即落 KV，批末不做“全部成功才写”。探测 404 是正常不存在结果，不计 fetchFailed；探测错误与 404 分开。探测到文件但抓取/解析失败仍保留发现身份，不用解析成功决定 universe。404 和失败不删除其它 code 或其它 date 缓存；日志只含身份、耗时、错误分类，不输出完整组合明细。发现列表失败与单文件失败分开统计。

## 4. 边界情况

- 非交易日/文件未发布：上游 404 只说明该 code/date 文件缺失；不自动找上一交易日，不推断节假日或关闭状态，不写虚假的 0。每日仍执行，404 不重试且不写负缓存到结果 key；GET 只读 miss。保留历史独立日期 key 直至 TTL。周末若源站有文件也可正常解析。
- 探测到但解析失败：仍属已发现 code，记录 parseFailed，不写结果 KV、不覆盖旧有效值、不从名单移除。
- KV 名单中的 code 当日文件 404：可能退市、暂停或尚未发布，不能凭单日缺失判定退市；正常发现阶段跳过当日抓取，降级刷新遇到 404 记 notFound。连续消失按第 3 节的 5 个有效校准日策略移除并告警，非交易日、骤降和探测错误不累计。
- code：严格字符串 `^159\d{3}$`，不接受数字、数组、空白、URL、路径、`159941.SZ`、其它六位代码；合法前缀但无文件由上游 404 处理，POST 不额外发现 universe。
- date：只允许字符串 `YYYY-MM-DD`，省略才默认上海当天；空串/null/数字非法。验证真实公历日期并 round-trip，拒绝 2026-02-30、非闰年 02-29、斜杠、时间戳、尾随字符、重复 query。范围定为 `2000-01-01` 至上海当天（含），拒绝未来日期；下限仅为接口防御范围，不保证深交所存档覆盖。测试固定 now，覆盖 UTC 16:00 上海跨日。
- 参数在路由、服务入口、key 构造、write 之前防御；非法输入不得触发 fetch、KV get/put，不能通过移除连字符或截断字符串“洗白”非法 date/code。
- code/date 与正文不匹配、缺当天段、HTML 错误页伪装 200、重复冲突字段、GBK 非法字节均不写 KV。单 code 失败不拖垮整批，已写成功缓存继续可读。
- KV 最终一致性：POST 返回已解析并完成写入的对象；其它地区 GET 短期仍可能 miss。不能保证立即全局可见，避免以 GET 自动抓取补偿。重复刷新同 key 用 isolate inflight 合并；实现阶段处理 KV 同 key 写频限制，写失败显式报告，不引入伪分布式锁。

## 5. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 上游字段名/段落改版 | 精确字段映射、rawFields 保留新增字段、schemaVersion、冲突拒写、多样 fixture；解析失败率单独记录 |
| 编码变化/乱码 | fatal GBK 解码、中文标题及核心 label 校验、拒绝错误页；Node 与 workerd 同 fixture 双验证，不自动猜编码 |
| universe 探测不完整/源站抖动/文件未发布 | 全部 1000 code 探测、200/404/错误分类；名单 diff、异常骤降保护、连续消失策略、7 天内旧名单降级；不以部分结果冒充完整校准 |
| 源站限流/超时/延迟发布 | 并发 5、5 秒全程超时、有限重试预算、404 不重试、手动补刷；09:00 是初始时间选择 |
| Workers 子请求额度 | 以 Paid 为运行前提，确认实际账户与配置；1000 次探测 + 约 600 次抓取 + 约 600 次 KV put + 少量 KV read/名单 put，正常约 2200；最坏 1000 有效 code 时约 3000，加外部尝试上限 2200 对应的写入和少量读取仍约 3200，低于 Paid 10,000 上限；HEAD 替代与重试也计数，不沿用旧“1000 子请求”假设 |
| cron 执行时长/CPU/内存 | VM 探测实测 3–5 分钟 + 抓取约 2–4 分钟及 KV，正常预计 5–9 分钟以上，Workers 需实测；最坏超时可能超限，12 分钟软 deadline、15 分钟平台 wall time 留余量；不同时执行场外任务、不囤积所有文本、单文件 1 MiB；现有 cpu_ms=300000 不代表网络 wall time |
| KV 写失败/一致性/过期 | await 写入、分类计数、source/身份/业务时间校验，24h TTL 不承诺历史档案；不以旧日值填新日 |

配额依据为 2026-10-13 查阅的 [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)：Paid 默认子请求上限 10,000、Free 外部子请求 50、同时出站连接 6、cron wall time 15 分钟。全量任务不能在 Free 单次 invocation 下满足目标；部署者须确认 Paid 及未下调子请求额度。将实际抓取/写入计数及预算截断原因纳入统计，防止数量增长或平台设置导致静默漏刷。

## 6. 测试计划

使用 node:test、mock fetch 和 fake KV，测试不依赖在线源站；fixture 保存真实 GBK 二进制而非 UTF-8 文件冒充 GBK，TextEncoder 不支持生成 GBK，不能用于构造该 fixture。

- `test/fixtures/etf-pcf/ETF15994120261013.gbk.txt`：保存示例原始字节；附 `README.md` 记录来源、日期、编码及预期值。Node 先 TextDecoder('gbk') 验证中文字段，再测纯解析。新增变体覆盖其它基金类型、CRLF/LF、全角冒号、千分位、0、不设上限、未知状态、负现金、可选字段缺失、未知字段保留。
- `test/etfPcfLimit.test.mjs`：验证示例全部当日字段与基础信息、账户额度不串净额度、前日段不串当天；重复冲突、错 code/date、无当日段、HTML、非法字节、超限大小/安全整数均拒写。
- 同文件覆盖 memory/KV 命中、过期、source/schema/身份/形态不匹配、未来时间、损坏 JSON、KV 读写失败、TTL=86400 和精确 key；POST/live 成功确实 await 写入；forceRefresh 仅刷新调用绕过缓存；失败不覆盖有效旧值；并发 inflight 去重与清理。
- `test/etfPcfRoute.test.mjs`：GET 命中、miss、过期、`refresh=1/force=1` 均断言 fetch 次数为 0；POST 单标的、默认上海日期、200/400/404/502/503/504/405、畸形 JSON、非对象 body、数组批量、重复 query、无效日期/非法 code；非法参数断言 KV get/put 与 fetch 均为 0。
- `test/etfPcfUniverse.test.mjs`：完整枚举 1000 code、mock 200/404/超时/429/5xx、HEAD 不支持时 GET 替代与响应体清理、去重排序、名单新增/消失 diff、连续 5 个有效校准日移除与重新出现、全量 404/骤降不推进计数、部分失败不写完整名单、成功写 key、source/年龄/形态失效、发现失败使用 7 天内旧名单、冷启动无列表；覆盖 159941/159632/159659 不依赖 clist 仍被发现；最大探测并发不超过 5。
- `test/etfPcfScheduled.test.mjs`：仅新 cron 触发 ETF；旧 cron 仍原有顺序；scheduledTime 上海换日；1000 code 探测 + 约 600 项有效名单 mock 全量、单项 throw/404/超时/写失败不影响其它项；两阶段顺序执行、探测/PCF 最大并发各 5，成功写与统计一致、重试次数/软 deadline/子请求预算受限。
- 实施时在本地 Wrangler/workerd（相同 2026-03-26 兼容日期）运行 GBK fixture 解码与模拟 scheduled，记录结果，不部署。Node 侧可用子进程调用本地测试 harness，补充 `test/etfPcfRuntime.test.mjs`，不新增生产探测路由。

提交前运行：`node --test test/etfPcf*.test.mjs test/fundLimitRoute.test.mjs test/fundLimitOverview.test.mjs`、`npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`。当前 lint 脚本只扫描 src，不能将其通过描述成 Worker 已 lint；Worker 改动仍需相关 Node 与运行时验证。本次纯计划任务不执行实现测试或提交。

## 7. 实施步骤

1. **确定样本和运行时能力。** 验证深交所 HEAD/GET 文件存在性探测及 159941/159632/159659 等 clist 遗漏品种；保存原始 GBK fixture；本地 workerd 解码核验。产出 `test/fixtures/etf-pcf/ETF15994120261013.gbk.txt`、该目录 `README.md`、`test/etfPcfRuntime.test.mjs`。来源/运行时门槛不通过先解决，不把不完整列表带入后续全量验收。
2. **纯解析与参数防御。** 实现规范日期、code 校验、统一 key 构造、GBK 解码与分段解析、字段 schema。产出 `workers/ocr-proxy/src/etfPcfLimit.js`、`test/etfPcfLimit.test.mjs`（先覆盖纯函数）。
3. **单 code 抓取与 KV。** 增加 mapLimit 单标的抓取、全程 abort/大小限制、分类错误、缓存读写验证、inflight。产出同一模块与单测的网络/缓存覆盖，确保成功写入才返回刷新成功。
4. **universe 与全量调度。** 实现 1000 code 文件探测、KV 名单 diff/校准/消失策略与降级；新增探测及抓取各并发 5 的逐项刷新、预算及统计。产出 `workers/ocr-proxy/src/etfPcfUniverse.js`、`test/etfPcfUniverse.test.mjs`，扩展 limit 模块及其批量测试。
5. **路由与 cron 接入。** 新增 GET/POST handler；index 增加独立路由、scheduled 分支，wrangler 追加 `0 1 * * *`，保留原 cron 与 KV binding。产出 `workers/ocr-proxy/src/etfPcfRoutes.js`、`test/etfPcfRoute.test.mjs`、`test/etfPcfScheduled.test.mjs`；修改文件仅 `workers/ocr-proxy/src/index.js` 和 `workers/ocr-proxy/wrangler.toml` 的必要接入段。
6. **验证与交付。** 更新 `workers/ocr-proxy/README.md`，说明 schema、单位、只读 GET、刷新 POST、日期范围、cron、失败分类与配额前提；运行第 6 节检查并复核 diff。后续实现任务最终在 `cn` 分支 commit 代码与测试，不混入工作区已有无关文件；若届时不是 cn，先报告情况而非擅自切分支。本次只交付本文档，不执行该提交步骤。

## 8. 验收标准

- [ ] GBK fixture 在 Node 与当前兼容日期的本地 Workers runtime 解码出正确中文，未引入生产 GBK 转码依赖。
- [ ] 159941 / 2026-10-13 输出净申购 1300000、净赎回 1000000000、最小单位 1300000、允许申赎、预估现金 4275.36；名称/代码/类型正确。
- [ ] 当日整段所有 label 均保留 rawFields，已列字段完成结构化转换，账户/累计额度与全基金净额度独立；不解析组合证券明细。
- [ ] unlimited、unknown、0、负现金、暂停状态正确区分，不猜缺失数据。
- [ ] GET 任意缓存状态和 refresh/force 参数均无外部请求；date 默认上海当天。
- [ ] POST 仅允许一个有效 code/date，成功写入精确 `etf-pcf:<code>:<yyyymmdd>`、TTL 86400，再返回成功。
- [ ] 非法参数、错误源、过期数据、身份不符、损坏正文不会污染 KV；源站 404 不写虚假额度、不返回其它日期。
- [ ] universe 完整探测 159000–159999；159941/159632/159659 等 clist 遗漏品种被覆盖，200/404/错误分类正确；KV 名单 diff、消失移除与失败降级可观测，部分探测不冒充完整校准。
- [ ] 新 09:00 上海 cron 全量刷新；1000 code 探测与约 600 项有效名单模拟、两阶段各并发 5、失败隔离、执行/重试预算与分类统计通过；现有 20:00 场外 cron 行为保持。
- [ ] 相关 node --test、本地运行时验证、check:refactor、lint -- --quiet、git diff --check 全部通过。
- [ ] 后续实现交付代码、测试、文档并 commit 到 cn；无部署、push 或前端/现有 fund-limit 业务变更。

## 9. 明确不做的

- 不部署：按本任务给定边界，Cloudflare connector 被拦；部署由用户另行提供 token 或使用本地 Wrangler 处理，本计划不尝试 connector、索取凭据或执行部署。本次未验证 connector 状态。
- 后续实现以「代码 + 测试 + commit 到 cn 分支」为终点，不 push；当前规划任务仅修订 `docs/plan-etf-pcf-limit.md`，不 commit、不切分支。
- 不修改 `fundLimit.js`、fund-limit 路由业务、overview 逻辑或原 cron 刷新行为；仅复用导出的 mapLimit，并为新功能添加必要的 index/wrangler 接入。
- 不接入前端、不预拉列表重数据、不覆盖沪市 ETF/其它代码、不做场外金额换算、不抓净值/K 线/财务/AI summary。
- 不做历史持久档案、自动交易日回退、组合成分解析、全量 HTTP 刷新端点、Queue/Workflow/新增 Worker；规模突破预算时另行规划拆分。
- 计划文档只放 docs/，不增加仓库根文档。
