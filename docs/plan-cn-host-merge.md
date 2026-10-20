# CN 主机代码回收合并 plan（merge-cn-host ← cn-host-import）

> 生成：2026-10-20，Codex CLI 分析（只读，未改任何文件、未提交）
> worktree：`/tmp/cn-merge2`（分支 `merge-cn-host`，HEAD 为未提交 merge）
> 本机侧 HEAD = `7908fc3d`（cn），导入侧 MERGE_HEAD = `496fd89b`（cn-host-import），merge base = `2be06e0d`

## 总览

| 项目 | 核实结果 |
|---|---|
| 当前分支 | `merge-cn-host` |
| 本机侧 HEAD | `7908fc3d3f9877c8c3dc4d19d3b12d4b59683f98` |
| 导入侧 MERGE_HEAD | `496fd89b6ebdc6c2bf7be3a4273fa66a4c6151aa` |
| merge base | `2be06e0d14e0e749328727d0ba8653eb1321cc94` |
| `e2056609` 是否为 HEAD 祖先 | 否，`--is-ancestor` 返回 1 |
| `e2056609` 是否为 MERGE_HEAD 祖先 | 是，返回 0 |
| 未解决文件 | 5 个 UU、1 个 AA |

**关键判断：`e2056609` 不是共同祖先。**它在导入侧集中带入了许多与本机侧独立提交相同的代码，不能因提交不同就重复保留实现，也不能把导入侧全部变更视为新增生产修复。

导入侧 base 之后实际可见 13 个提交；其中 `1d24c9c0` 至 `496fd89b` 是后续回收的 10 个提交，之前还有 `eb4f6f57`、`c83502e3`、`e2056609`。分析范围包含这三笔提交。

| 冲突文件 | 状态 | 解决方向 |
|---|---|---|
| `aggregates.py` | UU | 保留已有场内/场外识别，叠加导入侧 NAV 防冻结和日期防倒灌 |
| `calendar_cn.py` | UU | 使用导入侧 15:35 窗口；节假日计数去重 |
| `core.py` | UU | 保留共享快照写入，使用导入侧指数退避 |
| `product_snapshot.py` | UU | 保留场内优先规则，叠加导入侧 NAV 刷新保护 |
| `paper_trade.py` | AA | 导入侧为基底，恢复本机解析入口的兼容契约 |
| `fundMetricsRoutes.js` | UU | 同时保留腾讯主源和 fundmob 兜底，修复字段衔接 |

分类约定：

- **A 类**：同语义重复实现，保留一份。
- **B 类**：互补实现，拼接保留。
- **C 类**：同一行为冲突，依据生产行为决定。

下文行号均指**当前含冲突标记的工作区**；执行时优先按函数名和 hunk 内容定位。已有自动合并、已暂存的其他文件也属于本次合并结果，不应被整批覆盖或恢复。

## 逐文件分析与解决步骤

### 1. `services/market-collector/market_collector/aggregates.py`

**两侧改动意图**

本机侧主要提交：

- `25d27b6b`、`12666426`：行情快照缓存、请求合并、限并发和上游失败保护。
- `72c6e223`：份额字段。
- `b2de39db`、`75d65cc1`：腾讯 K 线兜底及更完整历史覆盖。
- `44bdaa66`、`0ff1afe1`：纠正 539001 等场外 QDII 分类，保留可用 NAV。
- `b0a95d3a`、`fee6a59d`、`556629d6`：明确场内 LOF 优先，直接读取 collector 场内快照，避免旧 OTC 产品行遮蔽成交价。

导入侧：

- `e2056609` 集中带入上述大量相同逻辑。
- **核实 HEAD 文件与 `e2056609` 该文件完全相同。**
- `f3cbcf7f` 新增真正的生产修复：自动推断为 OTC/QDII 的代码也检查 NAV 历史，并仅用更新历史覆盖旧值。

| Hunk / 位置 | 分类 | 决策 |
|---|---|---|
| 621–634，`load_navs` 函数体 | C | 导入侧；仅消费传入的 `nav_codes` |
| 639–659，待更新代码集及调用 | C | 导入侧；显式或推断 OTC/QDII 均纳入 |
| 681–697，NAV 覆盖条件 | C | 导入侧；缺值或日期更新才覆盖 |
| 冲突外的分类、缓存、场内优先逻辑 | A | 保留当前一份，不重复添加 |

**逐 hunk 解决指令**

1. `fund_metrics()` 内，保留已经自动合入的签名：
   ```python
   def load_navs(nav_codes: list[str]) -> dict[str, list[dict[str, Any]]]:
   ```
2. 第一个 hunk 使用导入侧：
   - 空 `nav_codes` 直接返回空字典。
   - 调用 `self.nav_histories(nav_codes, 45)`。
   - 删除 HEAD 内部重新计算 `missing` 的逻辑。
3. 第二个 hunk 使用导入侧，待更新代码集包含：
   - `explicit_kind_hints[code]` 为 `otc/qdii`；
   - 或 `kind_hints[code]` 为 `otc/qdii`；
   - 或当前没有 `latestNav`。
4. 调用统一为 `navs = load_navs(missing_nav_codes)`，不能保留无参数调用。
5. 第三个 hunk 使用导入侧：
   - 提取历史末行日期和当前 NAV 日期；
   - 当前 NAV 缺失，或历史日期非空且严格更新时，才一起更新最新及前次 NAV 字段；
   - 相同日期或更旧历史不覆盖。
6. 保留冲突外 `_infer_fund_kind_hint()`、`_load_exchange_quote_map()`、场内快照优先合并顺序、限并发及缓存逻辑。

**保留注释说明**

完整保留导入侧关于 **2026-09-10 起净值冻结、旧值回写回声循环、30 分钟缓存**的说明，以及"防止旧缓存倒灌"的注释。它们解释了为何不能重新采用"已有 NAV 就跳过历史"的优化。

### 2. `services/market-collector/market_collector/calendar_cn.py`

**两侧改动意图**

- 本机 `25d27b6b`：交易窗口内 2 秒缓存，闭市缓存至下一个刷新窗口。
- 本机 `175a14ba`：增加 `count_holiday_workdays_between()`，对齐浏览器 NAV 节假日规则。
- 导入侧 `e2056609`：带入快照 TTL 实现。
- 导入侧 `f3cbcf7f`：下午窗口延至 15:35，并增加与本机完全相同的节假日计数函数。

| Hunk / 位置 | 分类 | 决策 |
|---|---|---|
| 45–52，下午窗口 | C | 导入侧 12:59–15:35 |
| 60–69，TTL docstring | A，随行为更新 | 保留导入侧更完整说明 |
| 文件尾节假日计数函数 | A | 仅保留当前一份 |

**逐 hunk 解决指令**

1. 下午窗口使用 `(day_time(12, 59), day_time(15, 35))`。
2. 保留上午 09:29–11:30、窗口内 `return 2` 和闭市寻找下一交易日的算法。
3. docstring 使用导入侧，解释 writer 在 15:31 前仍发布收盘快照。
4. 文件尾仅保留一份 `count_holiday_workdays_between()`：
   - 区间 `(previous, latest]`；
   - 只统计周一至周五的配置节假日；
   - 非正跨度或超过 60 天返回 0。
5. **同步更新旧测试**：`test_aggregates.py` 的 `test_quote_snapshot_cache_ttl_tracks_a_share_sessions` 当前断言周五 15:01 返回周末长 TTL；应改为 `2`，并另测 15:35 后进入长 TTL。

**保留注释说明**

保留 15:31 写端边界、15:35 读端缓冲的中英文说明。不能只修改时间而留下"15:00 后闭市缓存"的旧语义。

### 3. `services/market-collector/market_collector/core.py`

**两侧改动意图**

本机侧：

- `12666426`：腾讯请求合并、历史采集限并发。
- `72c6e223`：份额字段及数据库写入。
- `e04574b0`、`287eeb70`：腾讯失败时使用东财价格，保护场内数据不被 OTC 覆盖。
- `1b142fee`：行情源恢复、失败时固定 15 秒退避。

导入侧：

- `eb4f6f57` 汇集了许多相同的源切换、份额和缓存逻辑。
- `f3cbcf7f` 新增原子共享 tick 快照，以及 15→30→60 秒指数退避。

两端完整文件差异仅涉及共享快照和退避增强，不能为此重新引入第二套 collector 流程。

| Hunk / 位置 | 分类 | 决策 |
|---|---|---|
| 1058–1063，`_iopv_loop()` 初始化 | C | 导入侧 docstring、`fail_streak = 0` |
| 1072–1084，失败等待和闭市分支 | C | 导入侧指数退避及重置 |
| 约 930–976，共享快照调用及函数，已自动合入 | B | 完整保留 |
| 其他行情、份额、源回退逻辑 | A | 保留当前一份 |

**逐 hunk 解决指令**

1. `_iopv_loop()` 第一个 hunk 保留导入侧，循环前初始化 `fail_streak`。
2. 第二个 hunk 保留导入侧：
   - 成功：清零，等待 5 秒；
   - 连续失败：15、30、60 秒，之后封顶 60 秒；
   - 非交易时段：清零，等待 5 秒。
3. 保留调用前的 `refreshed = 0`，保证异常路径也被计入失败。
4. 保留 `Event.wait()`，不改成不可及时停止的 `sleep()`。
5. 检查已自动合入的 `_write_tick_snapshot()`：
   - 高频 rows 非空后、数据库 upsert 前调用；
   - 使用 `atomic_write_json()`；
   - 输出路径为 `Path(output_dir).parent / "tick-snapshot.json"`；
   - 价格/IOPV/溢价来自 rows，五档来自 `price_map`；
   - 写文件失败只记录日志，不阻断行情数据库更新。
6. 保留 `_fetch_tencent_price_map()`、东财价格兜底、`total_shares` SQL 字段及 OTC 覆盖防护。

**保留注释说明**

保留共享快照用于降低多进程重复打点的说明，以及指数退避保护出口 IP 池的说明。共享读取存在缺失/过期直抓例外，注释中的"只有一个进程直连"应理解为正常运行路径。

### 4. `services/market-collector/market_collector/product_snapshot.py`

**两侧改动意图**

本机侧：

- `0b87d981`：新请求基金缺少产品/快照时，按需补 NAV。
- `44bdaa66`、`0ff1afe1`：修复 QDII 分类，保留有效场外净值。
- `97f7fca1`、`4a5deb6c`、`526000df`、`9444a98f`：旧 OTC 产品行不能覆盖最新场内 LOF 价格、涨跌和溢价；保留产品表收益字段。
- `72c6e223`：份额字段。

导入侧：

- `e2056609` 带入同一套逻辑；**该文件与 HEAD 完全相同**。
- `f3cbcf7f` 修改 `fund_metrics()` 内 `apply_hint()`，补上 NAV 防冻结和日期保护。

| Hunk / 位置 | 分类 | 决策 |
|---|---|---|
| 284–320，`apply_hint()` 的历史查询及覆盖 | C | 导入侧完整代码块 |
| 冲突前场内提前返回 | A | 保留当前一份 |
| 产品和 fallback 合并优先级 | A | 保留当前一份 |

**逐 hunk 解决指令**

1. 保留 `kind == "exchange"` 时设置场内标签并提前返回的分支，不能让它进入 OTC NAV 查询。
2. 在已经确定 `kind in {"otc", "qdii"}` 的分支内，整个冲突块使用导入侧：
   - 无论是否显式 kind、是否已有 NAV，都调用一次缓存保护的 `nav_history(code, 45)`；
   - 查询异常时保留原 metric；
   - NAV 缺失或历史日期严格更新时才覆盖；
   - 最新及前次 NAV 成组更新。
3. 保留末尾 `_apply_non_exchange_fund_kind(normalized, kind)`，继续清除场外不适用的成交价、IOPV、溢价等字段。
4. 不改动 `_latest_by_symbol()`、`quote()` 和 `fund_metrics()` 产品行合并顺序：
   - 场内最新快照覆盖旧 OTC 行的行情字段；
   - 产品表区间收益字段继续保留。
5. 保留没有产品也没有 fallback 时的 NAV 初始化路径；同轮后续调用应命中缓存，不能形成额外外部请求。

**保留注释说明**

保留回声循环、迁移回填旧 NAV、2026-09-10 冻结事实和日期防倒灌注释；同时保留场内 LOF 快照优先的注释。

### 5. `services/market-collector/market_collector/paper_trade.py`

**两侧改动意图**

本机侧通过多笔量化功能提交逐步形成六标的、四个多 Q 模拟盘、100 股粒度、即时执行、价格冲击、成交原因、盘后估值和持久化恢复。

导入侧 `1bd846c8` 一次加入线上文件，策略主体与本机相同，额外使用 collector 共享快照、5 秒直抓限频和公共腾讯解析。完整比较及 11 个冲突块解决指令见后面的 add/add 专项。

### 6. `workers/markets/src/fundMetricsRoutes.js`

**两侧改动意图**

本机侧实际关联提交是：

- `126a7adf`、`44bdaa66`：539001 等场外 QDII 分类及明确交易场所。
- `0ff1afe1`：实时刷新失败时保留 KV 中有效 OTC NAV。
- `10c15f74`：增加 `totalShares`。
- `37022c70`：腾讯优先、雪球兜底，恢复成交额、市值、份额及五档盘口。

因此，本文件里的"份额页工作"体现为份额与流动性数据支持，不能简单概括为 UI 变化。

导入侧 `c83502e3` 增加 fundmobapi 的 NAV、ZJL 折价率兜底。**其写入字段仍是上游原始字段名，而当前归一化入口消费的是标准字段名，必须完成语义衔接。**

| Hunk / 位置 | 分类 | 决策 |
|---|---|---|
| 431–487，两个不同 helper 被挤入同一位置 | B | 两个函数都保留，分别闭合 |
| 约 491–510，已自动合入的主源及 fundmob 调用 | B | 腾讯主源与 fundmob 兜底串接 |
| 约 184–258，标准化字段与 fundmob 字段 | C，隐性冲突 | 按当前标准字段契约补齐 |
| 约 391–410、614–627，缓存源验证 | 衔接修复 | 支持腾讯源，两条读取路径一致验证 |

**逐 hunk 解决指令**

1. 在 `isDanjuanUpdatedToday()` 后完整保留 HEAD 的 `fetchExchangeQuote()`：
   - 腾讯优先；
   - 腾讯失败才请求雪球；
   - 双失败时保留 `tencentError`、`xueqiuError`。
2. 随后完整保留导入侧 `FUNDMOB_API_URL`、`FUNDMOB_UA`、`fetchFundMobPremium()`。
3. **手动检查两个 helper 的闭合括号。**冲突块后的公共 `}` 原本分别服务两套代码，不能机械拼接导致函数嵌套或缺括号。
4. `fetchFreshFundMetric()` 场内调用继续使用 `fetchExchangeQuote(code, env)`。
5. fundmob 判断改为检查当前标准字段：
   - IOPV 是否为有效正数；
   - `latestNav` 是否为有效正数。
   - 保留导入侧"二者之一缺失则尝试补充"的行为，不再检查通常不存在的 `unit_nav`。
6. fundmob 成功后按标准契约合并：
   - 原有效 `latestNav` 优先，否则补 fundmob NAV；
   - NAV 日期写入 `latestNavDate`，与采用的 NAV 对应；
   - 原有效 `premiumPercent` 优先；
   - 有有效 IOPV 时，保留当前价格/IOPV 计算链路；
   - 无有效 IOPV、原溢价也缺失时，才用 fundmob 的 `-ZJL` 补 `premiumPercent`；
   - 不再仅写入 `unit_nav`、`premium_rate`、`_fundmobNavDate`，这些字段不会被当前归一化代码消费。
7. `fetchFundMobPremium()` 保留负号转换和代码精确匹配，但修正空值解析：
   - `null`、空串、纯空白、`--` 视为缺失；
   - 合法 `"0"` 必须保留为零溢价；
   - NAV 必须为有限正数；
   - 避免 `Number(null)`、`Number('')` 生成伪造的零溢价。
8. 保留主 quote 的价格来源 `source`；fundmob 只补增强字段，不能把腾讯 quote 冒充雪球源。
9. 保留 `error.xueqiuError` 才触发雪球 Cookie 通知的本机逻辑。
10. 缓存衔接：
    - `readCachedFundMetric()` 当前只接受 `xueqiu-quote`，会拒绝本机新写入的 `tencent-quote`；
    - 场内接受经过验证的 `xueqiu-quote`、`tencent-quote`，其他来源继续拒绝；
    - 批量 `kvCached` 快速路径也应执行相同的代码、来源、时间及形态校验；
    - 缓存中的 code 必须与请求 code/目标 key 一致，防止串代码读写；
    - 时间校验沿用交易日/闭市策略，不能简单拒绝所有隔夜收盘快照；
    - 保留 `fund-metrics:<code>` 写入及现有 TTL，不另建绕过缓存的 fundmob 列表预取。
11. 保留 `mapLimit(..., 5)`、批量上限和现有 `forceRefresh` 入口边界。

**保留注释说明**

同时保留腾讯主源免 Cookie、份额/盘口覆盖说明，以及 **ZJL 负值表示溢价，`premium = -ZJL`** 的说明。将 fundmob 注释更新为针对标准化 quote 的补充，避免仍声称只服务雪球原始响应。

**溢价链路重点回归**

仅把两个 helper 都留下还不够：腾讯 quote 返回 `premiumPercent: null`，而导入代码补的是 `premium_rate`；归一化只读 `premiumPercent`。NAV 和日期也存在同样错位。这是本文件最重要的语义合并点。

## paper_trade.py add/add 专项

### 两个版本的实际差异

已分别读取 `git show HEAD:<path>` 和 `git show MERGE_HEAD:<path>` 并比较函数 AST。

| 项目 | HEAD | MERGE_HEAD |
|---|---|---|
| 行数 | 1103 | 1130 |
| 腾讯解析 | 本地 `parse_tencent_depth()` | 公共 `fetch_tencent_quotes()` |
| 行情读取 | 每轮直抓腾讯、东财 | 优先共享文件，缺失/过期后限频直抓 |
| 共享文件读取 | 无 | `read_shared_tick_snapshot()` |
| 新鲜度阈值 | 无 | 10 秒 |
| 直接请求限频 | 无 | 进程内 5 秒 |
| 主循环 | 不传共享路径 | 盘中、盘后均传共享路径 |

以下 16 个函数/类 AST 相同：`shanghai_now`、`in_trading_hours`、`parse_eastmoney_iopv`、`fetch_latest_premium`、`sweep_book`、`round_order_shares`、`max_buyable_shares`、`buy_price_impact`、`PaperPortfolio`、`cheapest_symbol`、`signal_target`、`signal_reason`、`PaperEngine`、`_Handler`、`serve_http`、`main`。

同名但变化的函数只有 `fetch_market_snapshot()` 和 `run_forever()`。策略主体不存在需要二选一的版本差异。

**基底决策：使用 MERGE_HEAD 的共享行情架构，补回 HEAD 的解析入口契约；不复制两套策略或两套盘口解析算法。**

### 逐 hunk 解决指令

| 当前行号 | 分类 | 具体解决指令 |
|---|---|---|
| 38–41，`import re` | A | 采用公共解析后删除；不保留无消费者 import |
| 53–57，sources import | B | 保留 `fetch_tencent_quotes`，另导入 `parse_tencent_quote_text`；去掉仅旧解析使用的 `to_float` |
| 83–98，腾讯 URL 与共享配置 | C | 使用导入侧共享阈值、直抓状态；删除无调用的本地 `tencent_symbol`、`TENCENT_URL` |
| 134–211，本地解析与共享读取 | B/A | 保留导入侧共享读取；另补兼容解析 wrapper，内部复用公共解析器 |
| 230–268，行情入口 | C | 使用导入侧 `fetch_market_snapshot(timeout_sec, snapshot_path)` 和 `_fetch_market_snapshot_direct()` |
| 283–287，循环取行情行 | A | 使用 `quotes.get(symbol) or {}` |
| 300–308，盘口和停牌 | A | 使用导入侧空数组兜底、布尔转换 |
| 1146–1150，共享路径 | B | 保留 `snapshot_path = data_path.parent / "tick-snapshot.json"` |
| 1155–1159，启动日志 | B | 保留包含共享路径的导入侧日志 |
| 1169–1173，盘后请求 | C | 保留 `snapshot_path=snapshot_path` |
| 1187–1191，盘中请求 | C | 保留 `snapshot_path=snapshot_path` |

**兼容解析入口的实现要求**

`test_paper_trade.py` 当前直接导入 `parse_tencent_depth`，删除它会导致测试收集失败。因此保留该名字，但采用薄适配：

1. 调用公共 `parse_tencent_quote_text()`，传入有效采集时间。
2. 仅保留 `SYMBOLS` 中的代码。
3. 输出本机旧契约中的 `symbol`、`price`、`bids`、`asks`、`suspended`。
4. 将公共解析器盘口的 `[price, shares]` 转为旧接口的 `(price, shares)`；现有测试明确断言 tuple。
5. 保持旧接口对过短盘口记录的过滤要求；不复制原来的正则和五档解析循环。
6. 保留字段索引、手转股的解释价值，可在 wrapper 注释中指向公共实现。

**必须保留的策略及运行语义**

- 六个标的、四个多 Q 模拟盘、100 股取整。
- 即时执行、买入价格冲击、成交原因。
- 磁盘/TiDB 恢复、盘后最后价格估值。
- 盘后刷新展示行情但不执行策略。
- 共享文件命中时不直接请求上游。
- 缺失/过期后的直抓同时受 5 秒限频保护。

**保留注释说明**

保留共享快照、10 秒新鲜度、直抓限频、collector 重启窗口说明。保留本机盘口单位说明；同语义算法只在 `sources.py` 留一份。

## 验证方法

以下命令供解决冲突后的执行代理运行。本次仅确认 `python3 -m pytest --version` 可用，版本为 **9.1.1**；没有运行测试套件。

### 1. 冲突与补丁完整性

```bash
cd /tmp/cn-merge2
git diff --name-only --diff-filter=U
rg -n '^(<<<<<<< |=======$|>>>>>>> )' services/market-collector/market_collector workers/markets/src
git diff --check
git diff --cached --check
```

标记清理后先审查文件；由执行代理按其授权暂存解决结果后，再确认 `--diff-filter=U` 为空。仅删除标记不会自动清除索引中的 unmerged 状态。

### 2. JS 重点测试

实际相关测试集中在仓库根目录 `test/`，不能只运行 `workers/markets/test-kline-batch.js`。

```bash
node --test \
  test/marketsFundMetrics.test.mjs \
  test/fundVenueRoutes.test.mjs \
  test/xueqiuQuote.test.mjs \
  test/xueqiuBatchQuotes.test.mjs \
  test/marketsBatchQuotesFallback.test.mjs \
  test/quoteCache.test.mjs
```

份额与溢价消费者验证：

```bash
node --test \
  test/etfPcfShares.test.mjs \
  test/etfPcfSharesApi.test.mjs \
  test/etfPcfSharesClient.test.mjs \
  test/etfPcfSharesProjection.test.mjs \
  test/marketPremiumDigest.test.mjs \
  test/cn-home-premium-chart.test.mjs \
  test/marketHighDrawdown.test.mjs \
  test/marketListHistoryMetrics.test.mjs
```

**应补充的合并回归用例**

| 场景 | 核心断言 |
|---|---|
| 腾讯成功、fundmob 成功 | 保留腾讯价格、份额、五档；补标准 NAV/日期/溢价 |
| 腾讯失败、雪球成功 | 保留雪球回退行为；不丢已有溢价 |
| 有 IOPV | 不让 fundmob ZJL 覆盖 IOPV 计算结果 |
| fundmob `ZJL=-2.5 / 0 / null / '' / '--'` | 分别得到 `2.5 / 0 / 缺失 / 缺失 / 缺失` |
| fundmob 错误、超时、代码不匹配 | 主行情继续成功，不误写其他代码 |
| OTC/QDII 请求 | **不调用**腾讯、雪球场内源或 fundmob |
| KV 命中 | **不调用** live 源和 fundmob |
| 腾讯缓存、错误 source、过期、串 code | 正确接受/拒绝，两条缓存读取路径一致 |
| 缓存写入 | key 与请求 code 一致，保留标准补充字段 |
| 列表请求 | 不增加 K 线、NAV 历史或 R2 大对象兜底 |

新增网络源后，现有腾讯成功测试的 fetch mock 必须显式处理 fundmob，不能意外向真实外部接口请求。

### 3. Python 重点及全量测试

`pytest` 可用，现有测试通过 `sys.path` 支持从仓库根目录运行。完整测试依赖是否齐全尚未执行确认；`requirements.txt` 仅列出 `PyMySQL==1.1.2`。

最关键的六个文件：

| 文件 | 原因 |
|---|---|
| `test_aggregates.py` | 自动推断 NAV 刷新、缓存/限并发、场内优先、高频行情兜底、TTL |
| `test_product_snapshot.py` | 旧 OTC 产品行与最新场内快照合并、新基金 NAV fallback |
| `test_paper_trade.py` | 解析兼容入口、100 股粒度、多 Q 策略、估值与恢复 |
| `test_sources.py` | 公共腾讯五档解析、手转股、东财溢价符号和份额 |
| `test_quality.py` | `classify_session()`、15:31 边界及节假日 |
| `test_backtest_contracts.py` | 节假日 NAV 规则与补齐模块契约 |

```bash
python3 -m pytest -p no:cacheprovider \
  services/market-collector/tests/test_aggregates.py \
  services/market-collector/tests/test_product_snapshot.py \
  services/market-collector/tests/test_paper_trade.py \
  services/market-collector/tests/test_sources.py \
  services/market-collector/tests/test_quality.py \
  services/market-collector/tests/test_backtest_contracts.py
```

```bash
python3 -m pytest -p no:cacheprovider services/market-collector/tests/
```

**需补充或调整的 Python 用例**

- 自动推断 OTC/QDII、已有旧 NAV 时仍检查历史；更新日期覆盖，相同/更旧日期不覆盖。
- NAV 查询失败保留有效旧值；缓存命中时不重复访问上游。
- 明确场内 LOF 不因本次修复进入 OTC 查询。
- 15:00、15:01、15:31、15:34:59 返回 2 秒；15:35 后进入闭市 TTL。
- 节假日计数验证开闭区间、周末排除、60 天边界。
- 共享文件命中时，腾讯和东财直接请求次数均为零。
- 文件缺失、损坏、过期时正确兜底；5 秒内重复请求不重抓。
- collector 快照写入路径、五档内容、原子写入及写入失败不阻断数据库更新。
- IOPV 连续失败等待 15→30→60→60 秒，成功和闭市后重置；使用 fake Event，避免真实等待。

### 4. 仓库要求与构建

```bash
npm run check:refactor
npm run lint -- --quiet
npm run build:app
git diff --check
git diff --cached --check
```

`lint` 当前脚本只检查 `src`，不能替代 Worker 的 Node 测试。`build:app` 还用于验证已经自动合入的 Vite 5→8 依赖变化，不只是验证六个冲突文件。

## 回归风险点

| 风险 | 合并后关注点 |
|---|---|
| NAV 再次冻结 | 两个 Python 入口都必须覆盖自动推断 OTC/QDII，不能只修一处 |
| 历史 NAV 倒灌 | 日期比较依赖统一可排序日期格式；同日修订不会被严格 `>` 接纳，属于保留的生产策略 |
| 场内 LOF 被 NAV 覆盖 | 保留明确交易场所优先、场内快照直读和旧 OTC 产品行覆盖防护 |
| 收盘价永久停在盘中 | API TTL 延至 15:35；writer 的 15:31 边界保持原义 |
| scheduler 行为扩大 | 15:35 是读取刷新窗口，不能据此扩大模拟交易时间或修改 OTC 调度时间 |
| 溢价补充无效 | fundmob 必须写入标准字段，不能停留在 `premium_rate/unit_nav` |
| 伪零溢价或符号反转 | 空值与合法零分开；ZJL 只反号一次 |
| 不同基准混用 | IOPV 优先；NAV 日期与采用的 NAV 对齐，避免把历史 NAV 溢价当盘中 IOPV 溢价 |
| 腾讯缓存不能复用 | 更新只接受雪球的缓存白名单，并统一批量快路径验证 |
| 错误代码缓存污染 | 校验请求 code、响应 code、缓存 key 一致 |
| 外部请求量与延迟增长 | 腾讯通常没有 NAV/IOPV，fundmob 可能成为常见增强请求；保留缓存、并发 5 和按需入口 |
| 共享路径不一致 | collector 写 `output_dir` 的父目录；paper_trade 读 `data_dir` 的父目录，部署参数必须指向同一文件 |
| 快照局部缺数据 | 当前共享读取只要求至少一个有效价格；不完整快照可能被接受，不能让缺盘口生成虚假成交 |
| 新鲜价格搭配旧 IOPV | `captured_at` 新鲜并不证明 IOPV 新鲜，尤其指数退避期间应观察溢价质量 |
| 直抓限频返回旧结果 | 5 秒窗口内复用上次结果；本次不要静默改变该生产行为 |
| 测试入口兼容 | 保留 `parse_tencent_depth` 名字及 tuple 盘口契约 |
| 自动合入文件被忽略 | `sources.py` 的 netutil 传输和五档、补齐模块、依赖漂移都需纳入全量验证 |
| UA 修复遗漏 | 当前 `http_server.py` 已有显式 `ai-dca-market-collector/1.0`，`sources.py` 已走 netutil；不得因只关注冲突文件而覆盖掉这些逻辑 |

验收条件是：六个文件完成上述语义合并，生产修复和本机新增字段都有对应断言，相关测试及仓库检查通过；合并继续保持未提交状态，供后续审阅。
