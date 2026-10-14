# 管理员雷达「份额新增」实施计划

**本文只代表计划，不代表已执行。** 本次只读核查并编写此文档；没有实现代码、创建 demo、恢复提交、切换分支、安装依赖、回源、commit、push 或部署。首次执行 `git rev-parse --abbrev-ref HEAD` 为 `cn`，核查 HEAD 为 `7cd41dac`。文中全部开发、测试与验收均为未来任务。

## 1. 依据、分支状态与目标

已完整分段阅读 AGENTS.md、docs/plan-etf-pcf-events.md、提交 ef01cac9 中 etfPcfEvents.js / etfPcfShares.js / index.js，以及当前 AdminRadarExperience.jsx、experience-ui.jsx。另核查提交中的 PCF parser/schema、事件路由，当前 API URL 服务、ocrHttp、wrangler 配置、管理员门控、前端测试惯例及真实 XLSX。旧事件计划用于理解背景，cron/KV/schema/fetch 的基线以 ef01cac9 实现为准。

按用户背景假设，线上 Worker 已部署包含事件信号的版本；此次未在线验证。当前 cn 不包含该提交，两个事件源文件缺失，进一步发现 etfPcfLimit.js、etfPcfRoutes.js 也缺失；当前 wrangler 仅配置 `0 12 * * *`。不能把线上能力写成当前工作树能力。parent 在正式实现前必须核对并对齐分支、PCF 基础模块、路由及 cron 配置的来源和版本，形成可审阅基线；此次不恢复代码、不改写历史，也不部署当前旧配置。

目标在 AdminRadarExperience 内增加「套利雷达 | 份额新增」两个 tab，默认套利雷达。份额页覆盖固定 8 只：159501、159509、159513、159632、159659、159660、159696、159941。展示今天可获得的最新已验证报表及两交易日份额差，明确数据日期和源抓取时间。SSE、其它标的不加入，原 PCF 全量入口范围不收窄。

## 2. 已实现链路与拟增加的投影

提交中的 09:00 上海时间 cron（UTC `0 1 * * *`）通过 waitUntil 顺序运行 SSE → SZSE → events。SSE 默认软预算 60 秒；SZSE 成功回调收集目标 PCF，pcfData 直接传给事件阶段，避免写后立即读 KV。20:00 的 `0 12 * * *` 场外任务独立。

事件阶段默认 deadlineMs=20000，先精确读取前 10 个日历日的永久紧凑状态；key 为 `etf-pcf-events-limits:<yyyymmdd>`、`etf-pcf-events-shares:<yyyymmdd>`，事件日志为 `etf-pcf-events:<yyyymmdd>`，均不传 TTL。限额 source=szse_pcf，份额 source=szse_fund_report，schemaVersion=1。普通当日 PCF key `etf-pcf:<code>:<yyyymmdd>` 保持 86400 秒 TTL，不改变它的严格 validator。

原默认 downloader 有条件执行：current 有数据，且有历史限额（或注入测试 downloader）时，依次尝试当前 XLSX URL 和 T-10 至 T-1 的历史 XLSX URL；已有 records 至少两个日期后停止，最多两次下载。当前 URL 为 `fund.szse.cn/api/report/ShowReport?SHOWTYPE=xlsx&CATALOGID=1000_lf&TABKEY=tab1`；历史 URL 的 CATALOGID=scsj_fund_jjgm、jjlb=ETF。不是无条件每日已有份额下载；休市、冷启动或缺 PCF 时可能完全不下载。新 tab 不为补齐展示改变这些条件，不增加请求次数，不补历史下载。

拟在同一次下载、解析和验证后的结果上生成列表小投影，写 FUND_LIMIT_KV 的 `etf-pcf-shares:<yyyymmdd>`。不重新解析另一份下载，不由 API 或前端读取永久事件状态/R2来现场派生。投影需要的旧份额与历史限额复用事件阶段已读的内存输入；金额缺证据则留空。

投影是独立旁路：下载/解析缺日期只影响份额可用性，原限额放开计算和 PCF 入库仍继续；新增收集回调必须吞并记录自身异常。先完成原事件辅助状态和日志持久化，再在剩余总预算内尝试投影；投影 validator、put、latest 更新各自捕获异常，不能令已完成事件被标为失败、覆盖事件日志或回滚 PCF。原输入读取/事件写入失败的行为保持，不借此修改事件算法。预算不足跳过投影，保留旧有效 latest 并记录原因。后续补投影只可在下一次原 cron 的有效输入上进行，不新增下载/刷新入口。

## 3. 投影 schema、日期与派生口径

新 schema 独立 version=1，source=`szse_pcf_shares_projection`，保留 inputSource=`szse_fund_report`。顶层包含 date（实际报表日 YYYY-MM-DD）、prevDate（已确认的上一交易日或 null）、fetchedAt（本批实际源下载完成时间 ISO UTC）、projectedAt、expiresAt、availableOn（本批抓取的上海日）、status=complete|partial、records（固定 8 条按代码排序）、dateEvidence（列名/日期类型/源身份）。缺全批有效报表日期不允许生成成功对象。

每条包括 code、name、date、prevDate、shares、prevShares、deltaShares、deltaAmountWan、unit='份'、status/reasons；另包括 price/priceDate/priceKind/priceSource/priceEvidence，totalLimitKind/totalLimitShares/limitDate、utilization、atLimit=true|false|null、nearTotalLimit=true|false|null。缺值统一 null，不能用 0 表示缺失；name 优先同批已验证基金简称或同代码 PCF 名称，缺名称可使用已审阅静态名称，不能触发详情查询。8 条占位用于让用户知道覆盖范围，至少一只有效 shares 才可发布；全无有效值是 miss。

shares 为非负安全整数，按份标准化；prevShares 必须同代码、同源、同单位，并有上一交易日证据。deltaShares=shares(D)-shares(P)，有符号安全整数，负值显示净减少，零值显示 0。prevDate=P 不等于日历昨天；只有最近有效日期还不足以证明相邻交易日。提交 selectPreviousDate 实际是 10 日窗口中 evidence 内最大较早日期，不含完整交易日历，必须如实标注其证据局限。新投影另校验可核实的交易日序列/日历，无法排除中间交易日漏报时 prevDate、prevShares、delta 全部 null，reason=unconfirmed_previous_session；不修改原事件行为、不把较早快照冒充昨日。每行可因缺标的而 partial，顶层 prevDate 仅在可比较行一致时填写，否则 null 并按行标注。

新增金额定义为净份额变化的估算金额，非成交额或总申购金额：`deltaAmountWan = deltaShares × D 日每份人民币单位净值 / 10000`。priceKind=unit_nav_cny，priceDate 必须等于份额日 D，必须有可核验的净值字段、币种及日期证据；使用十进制定点乘法，内部保留精度，展示万元两位小数。不得使用当前实时行情、T 日价格、IOPV、篮子现金替代量或未经日期确认的「净值」替代。提交 PCF schema 未提供已验证的 D 日单位净值字段；真实当前 XLSX 虽有「净值」，却无净值日期、报表日期及币种证据，因此它不能用于金额计算。v1 默认 price 与 deltaAmountWan=null，reason=missing_dated_nav；未来仅在原下载/已存在的小缓存证据满足合同后启用，禁止为金额另行下载、调用 quote/净值历史或读 R2。金额来源尚未落实是未决事实，UI 必须支持整列 `—`。

「是否顶格」定义为 D 日净差分精确等于 D 日 PCF 累计申购限额，且限额 limited、正数、日期身份一致；显示「是（净增等于累计限额）」；有效未相等为否，超过上限显示「否（超过上限观测）」并保留真实比率，不截断。累计不限显示「不适用」，unknown/缺日/零上限显示「—」。不是比较 T 日上限，也不是净申购上限。nearTotalLimit 与原信号2的 >=90% 阈值一致，仅非负差分和有限正累计限额可判断，90% 是「接近累计上限」而非「顶格」；负差分为 false/净减少，不计算近限额信号。份额净差分可能抵消赎回，等于累计上限也不能证明实际总申购顶格。

## 4. 真实 fixture 与数据日期文案

已用 Python3 标准库 zipfile/XML 只读检查 `test/fixtures/etf-pcf-events/szse-current-20261013.xlsx`，未安装依赖。大小 72392 字节，SHA-256=`541505aba7ecdb106679e02b6c7b90341edec97bfa76f5b96c3a3d42cf1c7d23`。单表「基金列表」，表头：基金代码、基金简称、基金类别、投资类别、上市日期、当前规模(份)、基金管理人、基金发起人、基金托管人、净值。没有报表/as-of 日期；上市日期绝不作为份额日。文件名日期、README 所记下载日 2026-10-13、ZIP/文件时间也不是报表日期。

以下是原件可核对的绝对值，**无报表日期，不可入日期投影，不提供真实 prevShares/delta**：

| 代码 | 原件简称 | 当前规模（份） | 原件净值（未确认日期/币种） |
| --- | --- | ---: | ---: |
| 159501 | 纳指ETF嘉实 | 7062986575 | 1.9460 |
| 159509 | 纳指科技ETF景顺 | 6790564118 | 2.3992 |
| 159513 | 纳斯达克100ETF大成 | 4891549100 | 1.7262 |
| 159632 | 纳斯达克ETF华安 | 5120720640 | 2.3533 |
| 159659 | 纳斯达克100ETF招商 | 4687744064 | 2.2387 |
| 159660 | 纳指ETF汇添富 | 2589151363 | 2.2639 |
| 159696 | 纳指ETF易方达 | 3004824034 | 1.9292 |
| 159941 | 纳指ETF广发 | 22942710164 | 1.5499 |

原件份额为带千分位字符串。提交 decimalShares 不接受逗号，且 parser 首先拒绝 missing_report_date；不因能读取这些值而宣称生产 parser 接受原件。未来若源格式带逗号，需严格校验三位分组后归一化，并保持缺日期拒绝。历史两日报表原件未提供，现有测试 OOXML 为 synthetic，不足以确立真实历史源列名和发布时间。

「T 日早晨通常可获得 T-1 盘后份额」是业务假设，旧计划直接采用，但本 fixture 无法证明；提交只接纳 date<T 且最近 10 日的有日期 records。必须从可信报表日及发布规律证据确认，不能补造 T-1。周末、长假按交易日判断，上海今天可获得数据不等于今天实时新增。

固定说明：「今天可获得的最新场内份额报表，非今日实时新增；新增份额为数据日与上一交易日之差。」有效日期位置在 tab 下、表格上：「数据日期：2026-10-12 · 对比日期：2026-10-09」，下一行「源抓取时间：2026-10-13 09:03:20（上海时间）」；所有时间使用 Asia/Shanghai，年月日和秒完整，不把 API 返回/本地读取时间替代 fetchedAt。

建议列头用「本期份额（10-12）」「上期份额（10-09）」替代「今日份额/昨日份额」，名称列为「代码 / 名称」，其余为「新增份额（份）」「新增金额（万元，估算）」「是否顶格」。没有共用 prevDate 则上期列逐行标日期。日历证据充分且 D 早于预期最近可用交易日显示「数据滞后：最新报表截至 YYYY-MM-DD，尚未获得预期交易日数据」；日历证据不足显示「最新已验证报表：YYYY-MM-DD，更新及时性待确认」。缺日期源不展示未归属值：「报表缺少数据日期，暂无法计算份额新增」。缓存 miss：「暂无已验证份额快照，等待定时任务更新」。缺上期：「缺少可确认的上一交易日份额，暂无法计算新增」。

## 5. KV 生命周期、latest 与只读 API

投影不是事件永久档案：日期对象采用 30 天 TTL（2592000 秒），expiresAt=fetchedAt+30天；put 的 expirationTtl 按 expiresAt-写入当前时间向下取整，不因重跑旧输入续命，剩余不足 60 秒不写。永久事件辅助 key 不变。另维护小指针 `etf-pcf-shares:latest`，包含 schemaVersion/source/date/fetchedAt/expiresAt/目标日期 key，期限与目标对象一致。日期对象成功写入后才更新指针；不发布更早日期或更旧 fetchedAt，不把失败空值清空 latest。读失败/损坏指针时写者停止指针覆盖，记录问题。单 cron 写者、同 isolate inflight/按 key 串行队列、同 key 至少 1 秒间隔及内容不变跳写；不宣称 KV 有 CAS。

默认 GET `/api/etf-pcf-shares` 与显式 `?date=latest` 完全同义：今天访问时读取当前 latest 已验证报表，不默认为上海今天。不沿用事件 API 默认上海当天的不同语义。`?date=YYYY-MM-DD` 是实际报表日期的精确查询，不是抓取日。latest 只精确 get 指针，再 get 指针的日期 key；指定日期只 get 一次。无 KV list、无扫日期、无 R2、无事件状态临时拼装；指针先可见但对象暂未可见时返回 404，下一次只读重试即可，禁止补写/回源。可返回有效旧报表并标注滞后，物理/逻辑过期对象不能返回 200。

路由放 ocr-proxy，复用 jsonResponse 和 CORS；GET 成功返回投影合同（可加 `ok:true,data` envelope，但前后端在实现前统一，本计划选顶层投影直接返回），HTTP Cache-Control:no-store，让显式本地缓存控制有效期。OPTIONS 204，Allow:GET, OPTIONS；其它方法 405。date 只允许缺省、单次 latest 或严格 YYYY-MM-DD，空串、重复、非法公历日、2000-01-01 前、未来上海日为 400。其它 query 参数包括 refresh/force/forceRefresh/code 一律 400 unsupported_query_param；不能触发刷新。返回错误结构 `{error,reason,date}`（latest 未解析时 date=null）。缺 key、坏 JSON、过期/source/schema/身份不符为 404 cache_miss；binding 缺失为 503 kv_unavailable，任一 KV 读取抛错为 503 kv_read_failed。

日期 key builder 只接收已校验日期并再次验证，不能拼接用户任意 key。读/写共用严格 validator：source/inputSource/version、目标8只代码唯一且固定顺序/数量、顶层及行 date、prevDate<date 和交易日证据、整数/有限数/null 配对、delta 算式、价格与金额证据/算式、限额日期与比率、状态原因均检查；fetchedAt/projectedAt/expiresAt 是严格 ISO 时间，禁止未来抓取/投影，projectedAt>=fetchedAt，expiresAt=fetchedAt+30天且 now<expiresAt，date 不晚于抓取上海日或当前上海日。指针 key/date/fetchedAt/expiresAt 与目标对象完全一致；不匹配拒绝。未知字段不作为来源替代。API 所有分支的外部 fetch、put、list、R2 调用数均为 0，不提供 POST/手动刷新。

前端 URL 不盲用现有 fetchWithFallback：它会对 5xx 重试 CF，且新路径不在 DIRECT_API_PREFIXES。后续先确认 cn 网关如何转发到 ocr-proxy；未发现当前 cn-data 内该路径 handler。采用单一确定的只读 Worker 路由或经已核实网关的 apiUrl，不为了该功能扩大全局 fallback 白名单。浏览器请求不带 credentials，UI 管理员门控不是 API 服务端鉴权；延续现有公开小行情数据接口范围，不声称门控保护 KV 数据。

## 6. 前端调度、缓存与状态

复用 isAnalyticsAdmin(session)，未授权时不挂载数据子页、两类请求均为 0。AdminRadarExperience 负责 tab 调度，复杂 loader/schema/缓存放拟新增 `src/app/etfPcfSharesClient.js` 和独立份额面板，避免把 Worker 派生移到 React。复用 experience-ui 的 PageTabs、Card、Pill、SectionHeading 和按钮样式，补 tablist/tab/tabpanel、aria-selected/键盘焦点可访问语义；现有 PageTabs 为 a 标签，不能假定已具有 ARIA tab 行为。套利雷达原手动计算只在其 tab 可见，份额 tab 不提供 forceRefresh 或计算动作。

仅激活且管理员才加载对应 tab：默认雷达页不能预取份额，份额页不能新发雷达/compute 请求。卸载不再消费的后台 effect/刷新闭包；不为了隐藏列请求数据。固定 8 只一个小对象，不添加逐标的详情、kline、nav snapshots/nav history、财报、raw detail、AI summary、场外限额、quotes 请求；若未来增加详情需用户选择后另审，当前不加。

顺序为组件/服务 memory 与 inflight → localStorage → Worker KV 小对象。内存和本地持久层共享 `etf-pcf-shares:v1:<endpoint身份>:<上海访问日>:<latest或报表日期>`，对象 source/schema/身份/expiresAt 同样严格验证。成功读取客户端 TTL=5分钟（以 receivedAt 计且不超过对象 expiresAt）；跨上海午夜默认 latest 的访问日 key 失效，面板在前台可见时重算并只读检查，不能沿用昨日 latest 指针解析结果当今日命中。指定历史日缓存也最多5分钟，以接受修订。重复切 tab 5分钟内不再请求；过期只做一次 GET，不使用 forceRefresh、无自动后台轮询。

inflight 以 endpoint/query/访问日去重；StrictMode 同周期两个消费者共享同一 Promise。每个消费者有取消订阅和请求 generation，inactive/门控变化/卸载后禁止 setState；AbortController 管理实际请求，无消费者时延迟至当前调度周期结束再 abort，避免 StrictMode 立即重挂造成双请求，已 abort 的任务不复用。超时8秒，不能让旧日期响应覆盖跨日新请求。localStorage 损坏/配额错误仅丢弃/降级 memory，不阻止 UI。缺失对象只查缺失 query，一个批次；404 可在 memory 负缓存30秒，不存成功值，不自动重试；503/网络失败允许用户「重试读取」，该按钮仍为相同只读 GET，保持 inflight 去重。

loading 首次骨架+「正在读取份额快照…」；error 显示「份额快照读取失败，请稍后重试」；empty 用前述暂无文案；partial 保留可用行，缺字段 `—` 并标原因，新增为0不能误判空；stale 包括超过客户端TTL的旧有效结果和报表滞后两种，明确「本地缓存待重新确认」或「数据滞后」。读取失败可展示尚未超过服务对象 expiresAt 的旧数据并加「读取失败，展示上次快照」，不将其当新命中，过对象期限则只显示错误。所有状态保持日期说明可见；没有数据不能伪造抓取时间。

桌面完整六列（代码名称合并一列），数值等宽右对齐；移动端建议同字段卡片布局或卡片内可横滚表格，禁止整页横向溢出，不隐藏日期/金额缺值说明/顶格定义。此功能不需要底部浮窗。

## 7. dudu demo 必须先行

未来任务先提交可交互 demo，dudu 明确确认布局、文案与状态后，才写正式前端或 Worker 代码。建议形式为独立静态 HTML/CSS/JS，未来路径 `docs/demos/etf-pcf-shares-tab/index.html`，以本地浏览器可打开的离线页面交付；只使用标为 synthetic 的日期、增量/金额，真实绝对值若出现必须附「日期未确认、不可计算」标识。不接 API、不引入依赖、不把 demo 写进正式组件。**本次不创建 demo。**

demo 提供 tab 切换、键盘操作、管理员/无权限切换、loading/error/empty/partial/stale/缺日期场景选择、只读重试交互、日期与源抓取时间，及 90%接近/100%等于/>100%/负差分/不限/unknown 的解释。dudu 在桌面与 390px/320px 移动视口核对六字段、长名称/大数字、横滚或卡片、对比日期和两行时间、空值符号、颜色不夸大信号、底部导航不遮挡。确认记录需列具体版本、选择的移动布局及文案，不能以无回复视为确认。demo 被确认前只做必要基线/证据核查，不进入正式实现。

## 8. 安全边界、离线测试与未来检查

复用原 downloader 的 redirect:'manual'，所有新 fetch（包括客户端 GET）显式 manual；300–399 均拒绝并 cancel body，不跟随 Location，取消异常也不得进入成功路径。Workers 不支持 redirect:'error'，禁止使用。若浏览器跨域返回 opaqueredirect 则视为读取失败，不假定能读取/取消不可访问 body。保留原每请求全程8秒、事件20秒总deadline及AbortController，最大两次既有下载顺序执行（现有实际并发1，不因旧计划写<=2而增加），PCF 原并发/上限/预算不变，新投影不额外下载。保留1MiB下载、32 ZIP条目、4MiB单条目/8MiB总解压、100倍膨胀、20000行/200000单元格、50000共享字符串/4096字符、CRC/目录/XML/日期系统校验。剩余预算不足不开始投影写入；KV abort 不保证远端写未完成，需验证幂等恢复。

Worker 使用 node:test、mock fetch、fakeKV，参考 test/etfPcfShares.test.mjs 的合成 ZIP builder 与 test/etfPcfEvents.test.mjs 的 get/put 记录。扩展假时钟、到期删除、延迟可见、写失败/读失败/写频率模拟；真实 fixture 从本地读取，禁止网络和安装。当前这些测试引用的源模块缺失，必须基线对齐后才运行，不宣称当前可通过。

覆盖：真实 XLSX 拒绝 missing_report_date，上市日期/文件名不兜底；千分位规则与未知单位；synthetic 两交易日差分、负/零/安全整数溢出；非相邻交易日、10日边界、休市/长假/跨上海日界；日期净值缺失不调用金额源；90%与精确顶格区别、累计日期错配、unknown/unlimited/零限额。synthetic 算术例：D=2026-10-12、P=2026-10-09、prevShares=1000、shares=10001000，delta=10000000；同日累计上限10000000，则atLimit=true、nearTotalLimit=true。若另 synthetic 净值=2.0000人民币/份且日期D，金额2000万元；这些绝对值和价格都不是原件历史值。

API覆盖200完整/partial/有效零增量、404 miss/损坏/过期/指针悬空、400空/重复/非法/未来/date注入/不支持参数、405、OPTIONS、503；每例断言 fetch=put=list=R2=0。缓存命中/过期/source不匹配、schema/时间/代码/行身份、防写错key全部覆盖；TTL精确、latest单调、投影成功但指针失败/指针先可见/对象后可见、内容不变跳写、同key1秒、重跑和跨实例旧指针风险覆盖。投影失败不影响限额放开、signal2计算、永久事件写入、PCF入库或20:00任务；与基线比较上游请求数量、并发、超时，新增下载数为0。所有3xx、HTML、body超限、abort/超时回归。

前端真实惯例：test/marketsWatchData.test.mjs 用 node:test 测可注入服务及调用计数；test/notifyManagementUi.test.mjs 用源码契约检查；test/e2e/app-smoke.spec.js 使用已有 @playwright/test 和 mockAcceptanceNetwork。package.json 没有 RTL、Vitest 或 jsdom，不虚称使用它们。拟新增 test/etfPcfSharesClient.test.mjs 对纯loader/缓存/订阅生命周期测试，配源码契约门控/tab/文案断言；新增 test/e2e/admin-radar-shares.spec.js 在现有 Playwright harness 中模拟管理员身份及接口，验证真正挂载、快速切tab/StrictMode、卸载abort、状态、移动布局。源码正则测试不能替代请求行为的浏览器验证，不新增测试依赖。

明确「不会调用」断言：非管理员=0请求，未激活份额=0份额GET，份额激活=0新雷达GET/compute POST，缓存命中/重复切tab=0额外GET，隐藏列不额外fetch，所有场景重接口=0。localStorage过期/source错误正确回退至一个GET，写错cache key拒绝；跨上海午夜仅active触发新查询，旧响应不能写入新日key。

后续实现完成后运行相关 `node --test`（包括上述新client/API测试及原 etfPcfEvents/etfPcfShares 回归）、既有 Playwright 定向用例、`npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`。lint 脚本仅扫src，不声称它覆盖Worker。此次不运行这些实现测试，仅文档范围检查。

## 9. 逐项验收与风险

- [ ] parent 提供对齐后的基线说明：线上事件版本与cn差异、基础模块/09:00 cron可用；此次没有恢复代码或改历史。
- [ ] dudu 已确认独立交互demo，桌面/移动端及全部状态/文案有可复核记录，确认早于正式实现。
- [ ] 原件SHA/72392字节、8只上述绝对份额逐条一致；生产日期parser拒绝该缺日期原件，不写日期投影/指针，不伪造真实delta或金额。
- [ ] synthetic 两日例得到10000000份差、100%精确顶格、2000万元（仅在synthetic同日人民币净值有效时）；90%例只标接近，错日限额与价格均无派生值。
- [ ] 默认与date=latest返回同份已验证数据；指定D精确命中D，latest不按今日造key；无list/R2/外部请求/写操作，错误码与schema防御逐例通过。
- [ ] 30天KVTTL、5分钟客户端TTL、30秒负缓存与上海午夜行为可用假时钟核验；错误source/key/过期数据不能命中，指针悬空有明确404且不修复写入。
- [ ] 仅active+管理员请求；切tab缓存/去重/abort及不会调用重接口的计数通过；原雷达手动计算只在原tab，份额无forceRefresh。
- [ ] UI六列含单位/实际日期，两个时间语义清晰；partial、stale、无日期、无金额皆可读且不造零；390/320px页面不横向溢出。
- [ ] 同次cron复用下载，新增下载=0；原两次上限/并发1/8秒和20秒边界不变，3xx拒绝取消body，投影失败原PCF/事件仍完成。
- [ ] 后续相关node:test、refactor guard、lint和diff检查及定向浏览器结果可查；测试数据的真实/synthetic标识清楚。

风险与待决：目前没有真实带报表日期的两日历史XLSX，也无D日人民币单位净值证据，可能上线只能显示暂无/partial/金额空值；不得以UI目标倒逼假日期。原日期选择证据不能证明漏报交易日，需确认已有交易日历的可信性。格式（千分位/列名/单位/净值币种）变化须拒绝或partial，不静默猜测。SSE60秒、SZSE原长预算之后再运行事件20秒，整体cron墙钟和剩余KV写预算未测；需在未来离线记录基线/投影耗时与CPU，预算不足跳过投影。

额外KV写量通常一次日期投影+一次latest指针；同次两日修订最多两日期对象+一次指针，独立计于原永久事件/辅助状态写量，不宣称免费或零写入。30天投影不提供永久历史查询，事件档案仍保留。KV最终一致性可导致短暂404，跨isolate无CAS可能指针回退/版本不匹配；单写者调度、内存串行仅降低风险，读取严格拒绝不匹配，下一cron可修复，不承诺exactly-once或全球即时最新。路由网关及线上版本仍待parent对齐，不由当前配置直接推断上线可访问。

## 10. AGENTS.md 约束逐条映射

| 约束 | 本计划落实或适用范围 |
| --- | --- |
| 列表轻量接口、禁逐标的重接口 | 一个8行投影GET；不调用kline/净值历史/财报/raw/AI等，测试调用数0。 |
| 选中详情后重数据 | 此次不实现详情，因而无详情请求。 |
| 隐藏内容不预取 | 只有active tab请求；隐藏列不触发增强查询。 |
| 删除不消费props/state/effect/刷新 | 原页请求改为active门控；不留跨tab后台effect，份额无刷新计算函数。 |
| 无源模块本地短路 | 字段证据缺失显示—；无金额源不调用固定空接口，缺日期不生成成功快照。 |
| 最近层缓存优先 | inflight/memory→localStorage→KV；此小对象链路不需要R2/外源兜底。 |
| 批量/单标的共享key | 本次仅日期聚合接口；不新增单标的接口；若以后有，复用同日期投影key而非另一份缓存。 |
| R2大对象与小元数据分离 | cron生成KV小投影；列表和只读API不读取/扫描R2或历史序列现场派生。 |
| 非核心字段缓存缺失降级 | 金额/顶格/上一期缺失均—，禁止重接口同步兜底。 |
| 场内高点仅1d缓存，禁high52w/highest，quotes不含candles | 此tab无高点/行情列，无这些字段与请求；不得扩展兜底。 |
| 场外quote可用不取NAV、场外限额仅场外列表 | 此tab仅场内，不调用NAV快照及场外限额。 |
| 外部并发mapLimit/数量限制 | 无新增源站请求；原份额顺序并发1与两次上限、PCF原mapLimit边界不变。 |
| live成功写缓存、同类入口共享 | 原cron输入缓存保留；有效投影写统一日期key，GET只读该key；写失败隔离。 |
| source/时间/shape验证 | 输入、投影、指针、客户端缓存均严格验证身份和时效。 |
| K线按需详情、列表仅小元数据 | 不需要K线或R2。 |
| forceRefresh限明确刷新入口 | 本tab完全无forceRefresh，重试仅普通只读GET。 |
| MarketsExperience调度/重逻辑抽取/refactor guard | 不修改MarketsExperience；Admin页只调度，份额服务抽src/app并跑guard。 |
| 可见行/active list与useVisibleMarketSymbols | 固定8只小批次按active tab控制；不新建行情标的请求故无需该hook，不绕开现有Markets用法。 |
| 本地缓存/缺失集请求 | 同query只请求缺失或过期对象；不按切tab全量重拉、不逐行重复查询。 |
| effect去重/inflight/abort | 共享订阅Promise、取消订阅、generation和AbortController，StrictMode/跨日验收。 |
| 底部Dialog/Sheet隐藏导航 | 当前无底部浮窗，不适用；若dudu要求新增，打开/关闭必须setMobileBottomSheetOpen(source,true/false)，纳入验收。 |
| 不会调用测试 | API副作用、非active/非管理员、命中、金额缺源、重接口均有调用计数断言。 |
| 缓存命中/过期/source/key防御 | fakeKV和client测试覆盖各层读写、TTL、指针及错误身份。 |
| 缺缓存列表空值与禁隐式重兜底 | 缺上期/金额/限额显示—，真实缺日期拒绝，测试禁止伪造/回源。 |
| 提交前相关node:test/guard/lint/diff | 列为未来实现必跑检查；本次仅计划，按用户范围只做git diff --check、git status --short，不提交。 |
