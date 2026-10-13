# 深市 ETF PCF 事件日志计划

**本文只代表计划，不代表已执行。** 本次仅文档审阅与 `git diff --check`；以下代码、测试、探针、评估和验收全部是未来计划。
首次分支检查为 cn；不切换分支、不写实现、不改其他文件、不安装依赖、不 commit、不 push、不部署，保留所有现有未跟踪文件。
已只读审阅 AGENTS.md、plan-etf-pcf-history.md、plan-etf-pcf-sse.md，以及 PCF limit/routes/universe、index scheduled、wrangler 配置与现有测试。
背景直接采用：SZSE 功能 ede6d5e7 + 2841cc34 + d1604d34；SSE 5 只仅 0474c288；已部署 459f55ff，不在线重验。
已验证限额放开后溢价常呈 V 形，下面 8 只上两信号有效；这只是研究背景，不构成收益保证。

## 1. 目标、范围与现有接入点

v1 只计算 159501、159509、159513、159632、159659、159660、159696、159941 两类事件，提供按事件日只读查询。
事件名单独立冻结，不收窄原 PCF 服务：159xxx 校验、159000–159999 探测及原 universe 名单继续使用原规则。
SSE 513100、513110、513300、513390、513870 明确不纳入 v1：份额源未验证，SSE PCF 无历史使上一交易日口径不一致，信号仅在深市验证。
不改前端、不预取详情、不自动交易、不增加事件 POST 或请求路径历史回源，不改原 PCF 限额语义。
实际字段为 netSubscribeLimitShares/netSubscribeLimitKind 与 totalSubscribeLimitShares/totalSubscribeLimitKind，kind 为 limited/unlimited/unknown。
实际缓存为 FUND_LIMIT_KV 的 etf-pcf:<code>:<yyyymmdd>；当日写入 expirationTtl:86400，保留 fetchedAt/expiresAt。
工作树已有 validateEtfPcfHistoryData 与历史日期分流；历史读取能力不等于每日永久归档，不能把 history 文档计划当作已上线归档任务。
index.js 的 runEtfPcfDailyRefresh 目前先 SSE 后 SZSE，scheduled 使用 ctx.waitUntil；新增事件阶段拟放在 PCF 两阶段结束后。

## 2. 信号 1：限额放开

以 cron 业务日 T 的有效 PCF，对净申购 net 和累计申购 total 分别比较，两个口径互不回填。
prev 必须取 KV 最近有效上一交易日的同 code/同口径 PCF 紧凑快照，不能用日历昨天，也不能拿缺字段的较早日掩盖最近日 unknown。
后台按日期精确 get 或维护有序有效日索引，最多检查 T-1 至 T-10 共 10 个日历日；超过边界为 unknown，不继续无限回溯。
交易日身份以已验证清单日期及份额日期序列确认；若不能排除中间交易日数据缺失，报告 unknown，不能把最近缓存日冒充上一交易日。
普通 API 不执行 KV list；索引只是查找辅助，仍需校验快照 source、schema、code/date、kind/数值配对和实际日期。
limited 正分母到 limited：cur/prev >= 5 触发 signal_type=limit_relaxation；恰好 5 倍触发，小于 5 不触发。
limited（含 0）到 unlimited：最强放开，触发并标 transition=to_unlimited；unlimited 到 limited 是收紧，非信号。
unlimited 到 unlimited：已完成比较但不触发；任一 unknown、缺快照或坏形态：status=unknown，不推导额度。
limited 0 到 limited 正数：不定义倍数，status=unknown、reason=zero_denominator；0 到 0 不触发，ratio=null。
limited 正数到 0 是收紧，不触发；0 不解释成“不限”，维持深交所已有 parser 语义。
事件字段含 code、date=T、signal_type、basis=net|total、prev、cur、ratio、when_detected，并记录 prev_date 与判定原因。
prev/cur 使用 {kind,shares}；unlimited/unknown 的 shares=null；Infinity 不进入 JSON，用 ratio=null、ratio_kind=unbounded 表示不限放开。

## 3. 信号 2：上一交易日净申购接近累计上限

cron 日 T 的最新可用份额是 T-1 盘后份额，实际净申购定义为 shares(T-1)-shares(T-2)，T-2 是再上一交易日。
事件 date=T-1、signal_type=net_creation_near_total_limit、basis=total，比较的是 T-1 PCF 累计申购上限，绝非 T 的 PCF 或净申购上限。
当累计上限为 limited 且 >0，净差分/累计上限 >=90% 触发；恰好 90% 触发，不强行截断超过 100% 的观测值。
累计不限为 status=skip、reason=unlimited_total_limit；累计 unknown/缺 PCF/零上限为 unknown，不除零。
缺份额日期、缺 T-2、日期不连续或最新数据滞后：unknown，不用日历减一天补日期，不把缺份额填零。
负差分代表净赎回，skip/negative_net_creation；零差分完成计算但不触发；净差分并不等于总申购，因为可能同时存在赎回。
已验证历史源：https://www.szse.cn/api/report/ShowReport?SHOWTYPE=xlsx&CATALOGID=scsj_fund_jjgm&TABKEY=tab1&txtStart=YYYY-MM-DD&txtEnd=YYYY-MM-DD&jjlb=ETF&random=...
历史查询单区间 <=6 个月；仅使用 xlsx，json/JSON/csv 均返回 HTML 错误页，不尝试这些格式。
已验证当日快照：https://fund.szse.cn/api/report/ShowReport?SHOWTYPE=xlsx&CATALOGID=1000_lf&TABKEY=tab1 ，全市场约 72KB。
不能假设快照支持历史：正常每日留存两日份额；冷启动或漏跑拟一次历史短区间请求取得两个真实交易日，仍须验证返回日期。
拟以最近 10 日短区间优先取得两日，节假日不足则 unknown；较长补齐属于显式历史回放，不在每日任务扩展到半年全量。
将报表日期、代码、份额值、列名和原始单位留作来源证据；“万份”精确乘 10000，“份”保持，未知单位拒绝。
采用十进制定点转换并检查安全整数，禁止浮点近似、按市值/NAV 反推份额或混用金额；当前不虚构实际列名，待留存 xlsx fixture 锁定。
份额源下载或解析失败时，仅信号 2 记 unknown 并跳过计算，不阻塞信号 1；若长期不可行，v1 可只上线信号 1，并明确返回信号 2 未启用的 skip 状态。

## 4. XLSX 解析与安全边界

推荐先评估 DecompressionStream("deflate-raw") + 手写 minimal ZIP/XML，只支持已验证报表子集；与可裁剪轻量库做同 fixture 对照后定案。
SheetJS 完整包太大，不作为默认方案；轻量库须兼容 Workers、无动态执行、可限制解压大小，不能以“轻量”名称替代测量。
ZIP 仅接受 stored/deflate，拒绝加密、ZIP64、嵌套归档、重复路径、路径穿越和不支持压缩法；校验目录、偏移、长度及 CRC。
只读 workbook.xml、关系文件、目标 worksheet、必要 sharedStrings/styles；限定工作簿单一目标表，不遍历任意表提取可疑数据。
XML 禁 DTD/外部实体，限制节点/文本长度并支持合法转义、命名空间、inlineStr/sharedStrings；损坏索引直接拒绝。
日期支持经 fixture 确认的文本及 Excel 日期序列，识别 1900/1904 日期系统与样式，不把任意数字当日期。
代码规范为六位字符串，保留前导零；数值单元格仅在代码列按明确规则补齐，不混淆基金代码、证券代码和名称。
拟硬限制：下载 1 MiB、ZIP 条目 32、总解压 8 MiB、单条目 4 MiB、膨胀比 100、行数 20000、单元格 200000。
共享字符串拟最多 50000 条、单文本 4096 字符；边解压边计数，达到上限 cancel/abort，防 ZIP 炸弹和 XML 内存放大。
仅返回 8 只所需小对象，不把完整工作簿或全市场行长期驻留，不存入事件 JSON；格式变化宁可 unknown。

## 5. Bundle 体积与运行时评估

本次没有构建、下载、安装或测量；所有下列数字都是拟定门槛，不能写成已测结果。
后续用同一构建配置、compatibility_date=2026-03-26 与 nodejs_compat，对基线/minimal/轻量库分别记录 bundle raw 和 gzip 字节及增量。
报告依赖树、实际保留模块、构建工具版本和测量方法；压缩工作簿大小与 bundle gzip 大小必须分开。
在本地 Workers runtime 离线验证 deflate-raw 构造及真实 ZIP 解压，Node 可用不能证明 Workers 可用；部署前另做授权 runtime 探针。
用约 72KB 真实快照、历史两日 fixture、最大合法体积及恶意压缩样本记录解析 CPU、墙钟时长和峰值内存。
拟优先门槛：raw 增量 <=100KiB、gzip 增量 <=30KiB、正常样本解析 <=2 秒、峰值新增内存 <=32MiB，最大合法样本 <=4 秒。
minimal 只有能力/正确性/安全测试全部过关才可选；轻量库过同样门槛且维护成本更低时可优先，未过门槛须重新审阅方案。
不因 deflate-raw 缺失静默引入大 polyfill，不因时间不足关闭安全校验；暂不可用时信号 2 降级 unknown，信号 1 可独立完成。

## 6. Schema、永久状态与幂等写入

建议事件 key 为 etf-pcf-events:<yyyymmdd>，按事件日保存：信号 1 写 T，信号 2 写 T-1，每天通常触及 1–2 个小事件 key。
顶层拟含 schemaVersion:1、source:szse_pcf_events、date、events:[]、checks:[]、updatedAt、run_id；写前严格验证 key/date 身份。
checks 按 code/signal_type/basis 存 status=ok|unknown|skip 与 reason、输入日期和来源；空 events 不代表全部已成功检查。
全部已评估但无触发为 events:[] + ok；缺数据为 unknown；不适用为 skip；不存在 key 是 miss，不能制造空成功结果。
事件唯一 ID 拟为 date/code/signal_type/basis，merge 去重排序；when_detected 保留首次发现时间，重跑不新增重复事件。
同日可能混合到达：次日信号 2 必须与昨天信号 1 合并，不能覆盖昨天整份记录；unknown 重跑成功可更新对应 check。
事件日志永久保存，put 不传 expiration/expirationTtl；固定 24h PCF TTL 到次日可能已删除，不能直接依赖昨日原 key。
推荐事件模块自有永久紧凑状态：etf-pcf-events-limits:<yyyymmdd> 与 etf-pcf-events-shares:<yyyymmdd>，各日聚合 8 只，source 分别保留 szse_pcf 与报表源身份。
限额状态从当天已严格校验且成功入库的 PCF 结果复制两组字段；份额状态从验证后的报表复制 code/date/shares/unit/fetchedAt，均无 TTL。
辅助快照及必要有效日索引写入另计，通常每日新增 1 个限额日 key、1 个份额日 key；冷启动两日或补齐会增加，不混入“1–2 事件 key”口径。
先保存输入再计算；PCF 24h 缓存和原当日严格 validator 不变，不为事件放宽源缓存校验，不自动把原 history 计划升级成归档实现。
cron 原抓取函数当前只返回汇总，拟在 refreshEtfPcfLimitCache 增加受隔离的成功结果收集点，仅收集目标 8 只，不二次回源。
计算依赖同次运行收集的成功对象，避免 await put 后立刻 KV get 的最终一致性 miss；历史永久状态仍按 source/时间/shape 校验。
KV 无 CAS，读改写不能保证跨 isolate 原子性；拟单写者串行归并、同 isolate inflight 去重，每 key 写入间隔至少 1 秒并跳过内容不变写入。
重跑须读取两日既有日志并保留另一路信号；读失败停止该 key 写入，不能用空对象覆盖；跨实例并发重跑须串行操作，严格并发保证需另审协调器。
保留输入快照用于确定性重算，最终一致性下延后有限重读再合并；冲突/写失败记录可恢复状态，不宣称全球即时可见或 exactly-once。

## 7. 只读 API 与 cron 预算

拟新增 GET /api/etf-pcf-events?date=YYYY-MM-DD：validate → 精确 KV get → 校验 → 返回，不回源、不 list、不触发计算或补写。
复用 etfPcfRoutes 的错误对象和 ocrHttp.js 的 jsonResponse/CORS；index 全局 OPTIONS 继续 204，新路由 Allow: GET, OPTIONS。
缺省 date 为上海当天；空串、重复 date、非法公历日期、2000-01-01 之前和未来日期 400；key 构造再次校验，不接受任意前缀。
有效日志包括空 events 返回 200；缺 key/损坏或身份不符 404 cache_miss；binding 缺失或 KV 读失败 503；其它 method 405。
refresh/force 参数不能触发 fetch；GET 永不写 KV，返回 checks 明确 unknown/skip，不将缓存 miss 变成空列表。
北京时间 09:00 的 0 1 * * * 保持，PCF 抓完再计算；用 controller.scheduledTime 推导 T，实际检测时间 when_detected 单独记录。
休市不伪造清单日或份额日，未确认交易身份只记 unknown/skip；可处理新到达的真实上一交易日数据但不能改写成休市当天事件。
事件阶段独立 try/catch，收集回调异常也隔离，不影响 PCF 入库、原阶段返回/退出及完成状态，也不改变 20:00 的 0 12 * * * 任务。
额外总预算 X=20 秒：下载估计 <=8 秒、解压解析 <=4 秒、8 只计算 <=1 秒、KV 读写与合并 <=5 秒、余量 2 秒；均待实测。
新 fetch 全部 redirect:"manual" 并显式拒绝 300–399，取消 body；Workers redirect:"error" 会抛 TypeError，不能使用。
mapLimit 并发 <=2、新下载最多 2 请求/运行、不自动无限重试；快照正常 1 请求，缺第二日才加历史请求，两者共享预算。
每请求全程 8 秒与总 deadline 联动 AbortController，检查响应头及流式 body 大小；HTML 即使 200 也拒绝，超限/源失败不污染状态。
到期停止分配并取消下载，同步解析按块检查 deadline/计数；保留已验证状态，未完成 check 标 unknown/timeout，事件写入留预算，不拖长原 PCF 阶段。

## 8. 离线测试计划

拟使用 node:test、mock fetch、fake KV，注入 now/scheduledTime 与失败；不依赖网络，不在本次执行实现测试。
复用现有 etfPcfRoute/etfPcfScheduled 的调用记录 harness，并清理 memory/inflight；fake KV 增加延迟可见、expiration 和写频率模拟。
真实已知断言：159659 在 2026-09-21 累计 2000000→10000000，ratio=5 触发信号 1；净一直 unlimited，不触发净口径。
真实已知差分 10000000、累计上限 10000000，利用率 100% 触发信号 2；曾连续 14 交易日净申购精确 10000000 顶格。
不虚构两天绝对份额；后续从留存真实 xlsx/PCF 取 fixture 并记录来源，若尚缺原件，仅把给定差分作为已知算术断言。
合成绝对份额、异常 ZIP/XML 和边界 fixture 明确标 synthetic，不把构造值称为真实历史；连续 14 日需真实日期序列才能验收。
覆盖 4.99/5 倍、89.99/90%、0 分母、不限转有限、有限转不限、双方不限、unknown、负差分和零上限。
覆盖周末/跨节假日、10 日边界与过界、最近日字段 unknown、缺 T-2 日期/缺 PCF、滞后日期、错误单位/源/身份和安全整数溢出。
覆盖 HTML 错误页、所有 3xx 不跟随、网络失败/超时/abort、body 上限、ZIP 炸弹、共享字符串/前导零/日期系统、并发与请求预算。
覆盖缓存命中/缺失/过期源数据/source 不匹配/写前 key 防御；永久辅助快照无 TTL，原当天 TTL=86400 与严格 validator 回归。
覆盖重跑幂等、同日两信号合并、昨日信号 1 保留、KV 延迟/写失败/读失败不覆盖、每 key 写频率以及原任务成功不受事件异常影响。
API 每种 GET 命中/miss/空列表/unknown/skip/400/405/503 都断言 fetch=0、put=0、list=0，原 PCF GET/POST 和 20:00 回归。
后续实现检查拟运行相关 node --test、npm run check:refactor、npm run lint -- --quiet、git diff --check；现有 lint 只扫 src，不声称覆盖 Worker。

## 9. 实现顺序与拟修改文件

后续先核对留存真实 xlsx/PCF fixture 和列名/单位/日期，再完成离线 minimal 与轻量库对照、bundle/runtime 门槛报告。
其次完成纯信号函数及快照/事件 schema，随后做永久状态与幂等归并，最后接入只读路由和受隔离 cron，运行相关回归。
拟新增 workers/ocr-proxy/src/etfPcfEvents.js、etfPcfShares.js；拟在 etfPcfRoutes.js 添加事件 handler，index.js 添加 GET 入口和事件阶段。
拟在 etfPcfUniverse.js 的成功刷新点提供目标结果收集，必要时仅复用 etfPcfLimit.js 导出校验/日期 helper，不修改严格校验接受范围。
拟新增 test/etfPcfEvents.test.mjs、test/etfPcfShares.test.mjs 及带来源说明的 fixtures，扩展 etfPcfRoute/etfPcfScheduled 测试。
wrangler.toml 的 cron/binding 默认无需更改；若选轻量库才另行评审依赖文件，本次不改配置和依赖，不产生构建产物。

## 10. 验收与风险

- [ ] 8 只事件范围、SSE 排除理由明确；原全量 PCF 服务及当日严格校验不变。
- [ ] 两信号阈值、交易日身份、T/T-1 日期归属、给定 159659 真实已知断言和 unknown/skip 规则逐项通过。
- [ ] 永久状态解决 24h TTL 缺口；按事件日合并无覆盖，辅助写入独立计数，最终一致性与重跑恢复可查。
- [ ] API validate→KV→404 与空列表 200、全部“不调用”断言通过；cron 隔离、20 秒预算和 20:00 回归通过。
- [ ] bundle raw/gzip 增量、deflate-raw 能力、CPU/内存报告可查，所有解析安全门槛和离线测试通过。
- [ ] 线上冒烟仅在后续另行授权部署后查询某历史日期事件；旧日期不会凭空产生，先离线真实 fixture 重放或另行明确历史回放任务。

历史冒烟示例：明确授权回放并写入后，GET /api/etf-pcf-events?date=2026-09-21 应返回 159659 的 total 放开事件（2000000→10000000、ratio=5）；信号 2 仅在取得对应真实两日份额并完成回放后核对，不凭给定差分伪造源数据。
Workers 到 www.szse.cn、fund.szse.cn 的出口连通性必须列入部署前授权探针；本次不执行探针、不在线重验、不部署。
bundle 增大、解析 CPU/内存及总耗时可能超预算，按第 5/7 节门槛降级，不隐瞒尚未测量的结果。
T+1 误读、节假日缺日期、报表单位变化及 KV 竞态可能产生假信号，须保留输入日期、单位、来源和可重算状态。
净差分存在赎回抵消，接近累计上限只是代理信号；V 形经验及两个信号不保证未来收益，不扩展为自动交易建议。
本次验收仅为该中文计划文档约 150 行、10 节及 git diff --check；不执行上述实现、测试、历史回放或发布步骤。
