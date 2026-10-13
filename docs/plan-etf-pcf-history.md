# 深交所 ETF PCF 历史缓存读取实现计划

本次只新增本文档；不写实现代码、不修改源文件、不切换 cn 分支、不 commit、不 push、不部署。以下修改、测试、数据检查与提交均为后续实现任务，本文不代表已经执行。已完整阅读 `docs/plan-etf-pcf-sse.md`、`workers/ocr-proxy/src/etfPcfLimit.js`、`workers/ocr-proxy/src/etfPcfRoutes.js`，并阅读 `index.js` 的 scheduled 部分、仓库 `AGENTS.md`。任务提供的历史回填、源站保留期与线上行为直接作为已核实事实采用，不重新在线推导。

## 1. 目标与非目标

目标：`GET /api/etf-pcf-limit?code=159941&date=2025-10-13` 能读取 `FUND_LIMIT_KV` 中已有 backfill，返回正确历史限额；当日查询仍严格验证缓存及有效期，GET 始终只读缓存。历史 POST 保留为显式修正通道，修正后不丢失永久保存属性。

已有 1944 条归档：159501、159509、159513、159632、159659、159660、159696、159941，每只 243 个交易日，区间 2025-10-13 至 2026-10-13。value 为 `parseEtfPcf` 的 schemaVersion=1、source=szse_pcf 解析结果，有 `basicRawFields` 和 `warnings:[]`，删除了 `rawFields`，没有 `fetchedAt`、`expiresAt`、`sourceUrl`；KV 本身无过期时间。入口已经允许历史日期，问题在读取时使用当日严格校验。

非目标：不改解析口径、份额单位、前端、批量接口、universe、cron 时间、binding 或源站；不增加 GET 回源、latest 指针、自动回退交易日或自动归档任务。不将服务代码白名单收窄到上述 8 只，继续接受合法 159xxx。SSE 历史不在范围内，`ssePcfLimit.js`（0474c288，未部署）及其公共路由分发、调度接入保持原状。**上交所历史从部署日开始累积**，接口只提供当日清单；本文不解决 SSE 历史保存机制，也不承诺其现有 24h TTL 能永久累积。

## 2. key 方案

**复用 `buildEtfPcfCacheKey` 和 `etf-pcf:<code>:<yyyymmdd>`，不迁移、不增加独立前缀。** 例如历史 key 为 `etf-pcf:159941:20251013`，当日 key 为 `etf-pcf:159941:20261013`。1944 条已经按此格式入库，date 自然隔离清单身份；cron 只写当日，历史 key 不参与名单发现，universe 使用独立 `etf-pcf-universe:v1`。

独立前缀可让归档导出、权限和生命周期管理更直观，也便于同日缓存与归档双份保存；代价是搬迁已回填数据、增加两套读写及回退规则、可能形成不同值的双份真相，并要求处理“昨日 key 变为历史”的迁移。当前无需这些能力，接受运维清理必须按 code/date 精确选 key 的成本。

历史与当日是请求相对于上海当天的分类，不是 key 的永久类型。同一个 key 到次日会进入历史读取规则，但 KV 的已有 TTL 不会因此取消。复用前缀并不自动将每次 cron 结果变为永久归档。

## 3. 历史校验及读取路径

### 函数与分支决策

新增纯函数 `validateEtfPcfHistoryData(data,{code,date,now})`，返回现有 `{ok,reason?}` 风格。保留 `validateEtfPcfCachedData` 当日严格契约；若提取私有公共 shape helper，必须以回归证明严格分支接受/拒绝集合不变，历史专用的可选字段规则不得泄漏到严格分支。

先执行 `validateEtfPcfRequest`，再以规范化的 `date < shanghaiDateKey(now)` 选择历史校验，否则选严格校验。合法 YYYY-MM-DD 可以按字符串比较，禁止原始 query 直接比较。选择显式日期分支而非“严格失败再回退”，避免当日缺时间或过期对象被误当归档接受；不以 value 的字段缺失、KV expiration 或 schemaVersion 猜类型。

`readEtfPcfLimitCache` 的 memory、KV 和等待已有 inflight 成功结果三个位置均使用同一选择规则；inflight 返回前再次校验身份与对应分支，不保留绕过校验的快捷成功路径。一次调用使用同一个注入 `now`，上海午夜跨日的分类以该调用的业务时刻为准。历史 validator 自身也防御非法 code/date 及非历史日期，不能单独拿它校验当天对象。

### 历史 shape / identity 契约

| 字段 | 历史规则 |
| --- | --- |
| 顶层 | 非空对象、非数组；schemaVersion 必须等于 1，source 必须为 szse_pcf |
| code/date | 与已校验请求严格一致；拒绝错误 key 对应的 value，不接受 sse_pcf |
| fundName/fundType | 与严格分支一致，非空字符串 |
| fundManager/targetIndexCode | 沿用严格分支：nullish 或字符串 |
| 8 组限额 | 每个 kind 必须是 limited/unlimited/unknown；limited 的 shares 必须为非负安全整数，深交所 0 仍是 limited；历史分支要求 unlimited/unknown 的 shares 为 null，拒绝非空数值的矛盾配对 |
| creationRedemptionUnitShares | nullish 或正安全整数 |
| subscriptionAllowed/redemptionAllowed/iopvRequired | nullish 或 boolean，拒绝字符串布尔值 |
| estimatedCashDifference/unitCashDividend | nullish 或有限 number；沿用现有缓存 shape，不新增现金口径推导 |
| cashSubstitutionRatioLimitPct | nullish 或有限 number，范围 0 至 100 |
| localBasketSecurityCount/totalBasketSecurityCount | nullish 或非负安全整数 |
| basicRawFields | 必须是 string record；拒绝缺失、null、数组及任何非字符串值 |
| warnings | 必须是 string 数组；空数组合法，缺失不能自动补成空数组 |
| rawFields | 允许属性缺失；若存在则必须是 string record，null、数组或非字符串值拒绝 |
| fetchedAt | 可缺失；存在时必须是可解析的 ISO 时间字符串且不晚于 now，用于来源审计，不用于有效期 |
| expiresAt | 可缺失；存在时校验 ISO 时间字符串形态，不检查是否已过期、与 now 的距离或 24h 窗口，不决定历史可读性 |
| sourceUrl | 可缺失；存在时须与 `buildEtfPcfSourceUrl(code,date)` 一致，不能由读取引发抓取 |

8 组为 netSubscribe、netRedeem、accountNetSubscribe、accountNetRedeem、totalSubscribe、totalRedeem、accountTotalSubscribe、accountTotalRedeem 对应的 `…LimitShares` / `…LimitKind`。历史配对规则比旧 validator 对非 limited 数值的检查更明确，但不顺带改变当日 validator。parser 正常输出的 unlimited/unknown 均为 null，与 backfill 兼容。

**选择放宽历史 rawFields 必填要求，不重抓 1944 个文件。** 原始当日 label record 不参与结构化限额读取，现有 shape、身份、basicRawFields 和 warnings 足以满足本次查询需求。重抓约 7 分钟虽可行，却带来源站负载、失败重试、覆盖风险及更大 value，不能仅为满足当日缓存元数据而设为上线前置条件。长期代价是历史缺少当日原文字段及采集时间，不能完整复盘 parser 映射，也不能仅靠 JSON 证明上游当时正文；需要审计时可对指定 code/date 通过 POST 重抓补齐，不伪造旧 fetchedAt。

历史数据没有业务过期概念。兼容曾以短 TTL 写入但仍存在的旧日期对象：即使其 expiresAt 已过期也可读取；这只改变 value 校验，不能让 KV 已删除的数据复活。读取不补写、不伪造 rawFields={}、sourceUrl 或时间；响应保留现有字段并添加 `cached:true`，允许历史响应缺这些元数据。损坏/无值返回 404 `cache_miss`，KV 不可用/读失败仍为 503，非法参数仍为 400。历史错误文案可使用“指定日期”或“历史”，保留当日原有行为。

当日请求（含无 date）仍要求完整 rawFields/basicRawFields、warnings、fetchedAt/expiresAt 与严格有效期；不能回退历史分支。2026-10-13 的 backfill 在上海当天尚属于当日，缺时间的版本仍 miss，必须由原 POST/cron 当日刷新提供完整缓存；到次日才可按历史规则读取仍存在的版本。

## 4. KV TTL 策略

| 写入来源 | KV 过期选项 | value 时间字段 |
| --- | --- | --- |
| 已有历史 backfill | 无 expiration / expirationTtl，保持现状 | 不要求补齐时间 |
| 历史 POST 成功刷新 | put 不传 expiration / expirationTtl | 保存真实 fetchedAt、sourceUrl、完整 rawFields；不生成 expiresAt |
| 当日 POST / 原每日 cron | `expirationTtl:86400` | 保留 fetchedAt 与 fetchedAt+24h 的 expiresAt |

历史覆盖写必须显式采用无过期写入方式，不能继承公共 put 的 86400 选项，也不能复制旧 expiration。fake KV 要模拟覆盖后移除旧 TTL，后续运维检查同时核对 Cloudflare key expiration 元数据。GET 不写 KV、不续期；历史 key 与当日 key 日期不同，彼此不会覆盖，只有相同 code/date 的显式刷新会替换 value。

当日 cron 仍有 24h TTL，次日不会自动永久化。2026-10-13 这 8 个无过期 backfill key 若被当天 cron 覆盖，会变成当日 TTL key，这是“当日行为不变”的明确取舍。要把该日也恢复为永久归档，可在次日用留存 backfill 仅恢复该日期，或历史 POST 重抓；不修改当天 cron 来保存永久历史。未来持续归档机制另行规划。

## 5. POST 历史日期修正

继续允许 `POST {code,date}` 旧日期，沿用单 code、forceRefresh=true、固定深交所 URL、GBK 解码与 `parseEtfPcf`。源站文件至少保留一年，合法入口范围不代表源站每个日期必有文件。404 `upstream_not_found`、下载/解析错误及 KV 写失败继续按原分类返回，失败不删除或覆盖旧历史值。

`fetchEtfPcfLimit` 在请求校验后确定历史分类，与读取使用相同 date/now。解析成功后，当日按现有方式构造 expiresAt 并严格校验、24h 写入；历史保留真实 fetchedAt、sourceUrl 与 parser 全部输出，省略 expiresAt、用历史 validator 写前校验、await 无过期 put。成功后才更新同 key memory 并返回 `cached:false`。不从旧 backfill merge 缺失业务字段，不修改 parser；上游身份异常一律拒绝写入。

同 isolate 的 `etfPcfInflight` 继续按同 key 合并请求，finally 清理；不同 key 独立。跨 isolate 无全局锁，采用最后一次成功写入为准，稳定上游结果重复刷新在业务内容、key、无过期属性上幂等，fetchedAt 可以变化。不能宣称严格一次写入或有序修正；必要修正由操作者核对内容后再刷新。午夜附近调用以固定 now 分类，当天开始的慢刷新可能仍写 24h TTL，属于原时间契约；可在次日显式历史 POST 永久保存。

fetch 保持已有全程 5 秒超时、1 MiB 上限及 body 清理。凡涉及 fetch 选项均使用 `redirect:'manual'`，显式拒绝所有 3xx，不跟随 Location；不得使用 Workers 不支持的跳转错误模式。历史修正不新增自动重试或批量 HTTP 刷新入口。

## 6. cron 兼容性

不修改 `index.js` scheduled、`etfPcfUniverse.js`、cron 配置或 universe 策略。`0 1 * * *` 为北京时间 09:00，SZSE 以 scheduledTime 推导上海当天并刷新当日 key，仍严格校验、TTL=86400。universe 独立 key，不 list `etf-pcf:`；1944 个历史 key 不进入探测名单、刷新数量或预算。

当前工作树已有 SSE → SZSE 的组合调度，保持阶段顺序、失败隔离及统计原样；本次仅调整 SZSE 单标的服务的日期相关校验/写入，不碰 SSE。`0 12 * * *` 场外任务不变。不增加历史自动回填、扫描、清理或归档步骤。

## 7. 回填核对与验证步骤

1944 条已入库，本方案不重新 bulk 写入、不重抓补 rawFields。后续先保留现有 bulk JSON、CSV、243 个交易日清单和 key 清单副本作为恢复材料；具体文件位置由实现时定位，不在本文虚构已经取得的 fixture 或 CSV 数值。

1. 运维只读导出每只 code 的 `etf-pcf:<code>:` key，处理 list 分页，与固定区间/243 日清单做集合比对。按区间计数每只应为 243，总计 1944；区间外新增 cron key 不计入，不能用整个 namespace 总数断言。此 list 仅用于核对，不加入生产读取路径。
2. 检查对应 key 的 KV expiration：历史归档应无 expiration；对 2026-10-13 当日被 cron 覆盖的 key 单独记录，按第 4 节次日恢复，不误报历史大量过期。
3. 抽查每只首日、中间日、末日 value，核对 schema/source/code/date、8 组限额、数值布尔、basicRawFields、warnings；缺 rawFields 和时间符合预期。对 1944 条运行离线历史 shape 审计时把 now 固定到上海 2026-10-14 或之后，以覆盖末日的历史分类；当日严格验证另测。
4. 从真实 backfill 与 CSV 保存最小 fixture，尤其 159941/2025-10-13；记录其 `netSubscribeLimitShares` 与 kind 的 CSV 期望值，不猜数字。先用 fake KV 路由端到端读取证明正确，再于后续具备运行版本的本地环境验证 HTTP。
5. 用以下已核实 2026-10-13 净申购真实值作独立断言，明确是 `netSubscribeLimitShares` / `netSubscribeLimitKind`，不混入累计字段。上海当天以完整当日缓存测试，次日以 backfill 历史对象测试。

| code | netSubscribeLimitShares | netSubscribeLimitKind |
| --- | --- | --- |
| 159501 | 5000000 | limited |
| 159509 | 8000000 | limited |
| 159513 | null | unlimited |
| 159632 | null | unlimited |
| 159659 | null | unlimited |
| 159660 | 500000 | limited |
| 159696 | 1000000 | limited |
| 159941 | 1300000 | limited |

本文不执行远端 KV 检查或生产 HTTP 验证。后续终点不部署，端到端验收由真实留存 fixture + 本地路由/runtime 完成；线上验证待另行部署授权。

## 8. 测试计划与实现顺序

使用 node:test、mock fetch、fake KV，不依赖在线源站。复用 `clearEtfPcfRuntimeStateForTests` 防止模块 memory/inflight 污染。真实 fixture 来自留存 backfill/CSV；异常对象由该 fixture 派生，不将合成值称为真实历史证据。fake KV 记录 get/put/key/options，支持缺值、损坏 JSON、读写 throw、覆盖后的 expiration 状态；fetch mock 记录次数、URL、redirect 与返回 body。

| 范围 | 接受/拒绝及副作用断言 |
| --- | --- |
| 历史 validator | 缺 rawFields/fetchedAt/expiresAt/sourceUrl 接受；warnings=[] 接受；已过期但合法 ISO expiresAt 接受；完整 parser 输出接受；错误 schema/source/身份、非对象、空基金名/类型、损坏 basicRawFields/warnings/rawFields 拒绝 |
| 限额与形态 | 8 组逐一覆盖非法 kind、limited 无 shares、负数/小数/溢出/字符串、unlimited/unknown 搭配非 null 数值；0/limited 合法；正申赎单位、现金有限数、比例边界、布尔及计数规则；未来 fetchedAt、坏时间/错误 sourceUrl 拒绝 |
| 日期分流 | date 小于上海当天走历史，等于当天/无 date 走严格；未来和非法日期入口拒绝；UTC 16:00 上海换日边界；同一 memory 对象次日重新按历史校验 |
| GET 历史 | 真实 backfill 命中200/cached:true，精确同 key；第二次 memory 命中；缺值、损坏 JSON、错误身份等404/cache_miss，fetch 次数均为0且 put=0；refresh/force 参数也 fetch=0；KV 缺 binding/读失败503 |
| 当日回归 | 历史精简对象放当日 key 必须 miss，不能回退；完整对象命中；过期、未来时间、异常有效期及缺 rawFields 仍拒绝；无 date 只读当天，不回退前日 |
| inflight | 已有历史 POST 的 GET 等待结果仍按历史校验，返回 cached:true；失败继续读旧 KV；异常身份/形态结果不能直接成功；不同日期 key 不交叉；finally 清理 |
| 历史 POST | 固定历史 URL、manual 与3xx拒绝；强制刷新已有 backfill；成功完整字段、真实 fetchedAt、无 expiresAt、同 key put 无 expiration/expirationTtl、cached:false；原无 TTL 与原有 TTL 两种覆盖均变为无 TTL；失败 put=0/旧值保留，写失败不进入新 memory |
| 并发与幂等 | 同 key 同 isolate 合并为一次 fetch/put，不同 key 独立；重复成功业务字段相同、永久属性保持；失败后可再次刷新，无残留 inflight |
| cron 回归 | fake KV 预置历史 key，09:00 SZSE 仍只写当天 key/86400，历史 key 值与无过期属性不变；universe 不 list 历史前缀；scheduledTime 日期换算、探测预算、失败隔离、现有 SSE 阶段与20:00任务不变 |
| 全部已有套件 | etfPcfLimit、etfPcfRoute、etfPcfUniverse、etfPcfScheduled、etfPcfRuntime 全回归；公共路由已有 SSE 用例通过，不能因 SZSE 改动改变 SSE 行为 |

后续预计主要修改 `workers/ocr-proxy/src/etfPcfLimit.js`：新增历史 validator、读取统一分流与 inflight 校验、历史写入无 TTL。扩展 `test/etfPcfLimit.test.mjs`、`test/etfPcfRoute.test.mjs`、`test/etfPcfScheduled.test.mjs` 并加入最小历史 fixture；仅在确需文字调整时改 SZSE 错误文案，不改路由分发或调度实现。实现顺序为真实样本及失败测试 → validator → 三个读取出口 → POST 持久化 → cron/当日回归 → 检查和提交。

后续执行 `node --test test/etfPcf*.test.mjs`，覆盖 runtime 所需本地 harness；仓库已存在的 SSE 及场外相关回归也应运行。然后执行 `npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`。lint 当前扫描 src，不能宣称它覆盖 Worker；Worker 由 Node/mock runtime 验证。测试运行配置不得通过跳过关键 runtime 验证冒充全部通过。本次只做文档审阅与 diff 空白检查，不运行尚未实现的功能验收。

## 9. 验收标准

以下是后续实现任务的可勾选终点，本次不勾选为已完成。

- [ ] `GET /api/etf-pcf-limit?code=159941&date=2025-10-13` 返回真实 backfill、code/date/source 正确、cached=true，`netSubscribeLimitShares` 与留存 CSV 一致，fetch=0。
- [ ] 8 只各243条、总1944条的固定区间清单核对通过；历史无 KV expiration，末日当日覆盖例外已有记录及恢复步骤。
- [ ] 历史精简对象不需 rawFields/时间/sourceUrl 即可读取；basicRawFields、warnings、身份及业务 shape 损坏必拒绝；历史已过期 expiresAt 不影响可读性。
- [ ] `GET /api/etf-pcf-limit?code=159941`（无 date）仍走上海当日严格路径，当日精简对象和过期对象仍 miss；无任何历史回退。
- [ ] 所有 GET 命中/miss/损坏场景 fetch=0、put=0，返回状态及 cached 标志正确。
- [ ] 历史 POST 成功写回同 key、无 expiration/expirationTtl，原永久归档不会变为24h TTL；失败保留旧值，await put 后才成功。
- [ ] 2026-10-13 八只净申购数值/kind 符合第7节真实值表，历史与当日 fixture 两种路径分别验证。
- [ ] 09:00 cron 写入当日 key 的 TTL 仍为86400，历史 key 不参与 universe、不被修改；现有双市场/场外调度回归通过。
- [ ] `node --test` 相关 etfPcf* 及已有公共路由回归通过，`npm run check:refactor`、`npm run lint -- --quiet` 通过，`git diff --check` 干净。
- [ ] 后续终点为代码 + 测试 + commit 到 cn；只提交本功能文件，不混入工作区已有无关改动，不 push、不部署。本次任务终点仅为新增本文档，不 commit。

## 10. 风险与恢复

| 风险 | 影响及处理 |
| --- | --- |
| KV 最终一致性 | await put 只表示写操作成功，不保证所有边缘节点立即读到新值；同 isolate memory 可立即返回，其他 isolate 可能短期旧值/miss。写后验证应有限重试、记录 code/date/采集时间，不能借 GET 回源或将短期不可见当永久丢失 |
| value 体积 | 精简单条约1.3KB，1944条约2.5MB（未含 key/元数据）；不补 rawFields 避免明显膨胀。POST 完整对象会更大，保留已有响应体上限，不扫描全量 value 作为普通查询 |
| etfPcfMemory | 同 key 缓存，有500条上限，约650KB精简正文量级，另有 JS 对象/Map 开销；历史查询可挤出当日条目，增加当日 KV 读取，但不触发 GET 外部 fetch。保留现有插入顺序淘汰，不预载1944条，不新增无界 Map；历史无时间淘汰，但容量和 isolate 生命周期仍限制驻留 |
| 修正后的旧 memory | 跨 isolate memory 可能继续保存旧历史对象，历史不再依赖 expiresAt 自然失效。容量淘汰/isolate 重建后才会重新读 KV，需明确不承诺跨节点立即修正；此次不引入版本指针或全局失效协议，紧急修正可安排后续实例更新并核对结果 |
| 缺原文与时间的长期成本 | rawFields 缺失无法复核当日原文，fetchedAt 缺失不知采集时刻；basicRawFields 与CSV支撑业务核对但不等同完整审计。保留原 bulk 及 CSV，不伪造元数据；有审计需求时按日重抓或另做归档格式升级 |
| SSE 边界 | 仅从部署日起取得清单；没有历史源站接口，本计划不会让已有 SSE validator 或 TTL 获得永久历史能力 |
| 当日TTL与持续累积 | 已有永久历史和当日短缓存共存，但今日变昨日不取消TTL；末日可能被cron短TTL覆盖。次日恢复末日归档或历史POST可修复，自动每日永久累积不属于本次 |
| 误删历史 key | 优先从留存 bulk JSON/CSV清单恢复同 key、无expiration，并离线校验身份/shape。源站至少保留一年，可在保留期内复用固定URL、GBK解码、parseEtfPcf重建，限并发2、失败有限退避重试、记录失败清单，成功项同 key 无TTL覆盖；fetch 使用manual并显式拒绝3xx。全量1944份约7分钟仅为原规模估计，受限流/重试影响；超出源站保留期不能承诺恢复，CSV也不能凭空补全完整parser字段 |

恢复流程是运维预案，不是本次必须执行的重抓任务。应保留可独立于 KV 的回填文件副本及字段格式说明，防止“冷备份”和唯一可恢复材料都只在同一个 namespace。
