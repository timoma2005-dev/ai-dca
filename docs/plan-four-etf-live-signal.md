# 四 ETF 溢价切换实盘信号实施计划

结论：按任务书实现季度常态、逐分钟决策和下一分钟确认；只发信号，初始参考持仓 159696，首日启用 lovexl 已有 email。

## 范围与隔离

- 基线 `af9745fb`；独立分支 `feat/four-etf-live-signal-20261108`，本地 worktree `/home/hatch/workspace/ai-dca-four-etf-live`，CN `/root/ai-dca-four-etf-live`。通过本地 bundle/scp 部署，不推任何 remote。
- 新建 `services/four-etf-signal/`、`fourETFEntry.js`、`fourETFSignalRoute.js`；入口包装现有 relprice 入口，原 fetch/queue/scheduled 和具名导出保持原样。relprice 源码、配置、状态、cron 不改。
- 不操作本地 ai-dca 主工作区、`/opt/quant-shadow` 或 `ai-dca-switch-monitor`。CN 的行情库、collector、mirror 只读。
- 新配置 `/etc/ai-dca-four-etf.json` 无密钥；状态、独立历史库、逐分钟日志和投递凭证只写 `/var/lib/ai-dca-four-etf/`。

## 已实测的数据决定

1. CN `/latest` 显式 `ProxyHandler({})` 绕过代理。它提供快照/逐标的时间和停牌资格；不把 IOPV 或 `computed_premium_percent` 当成净值溢价。快照或需要交易的标的时间过期即关闭该次交易。
2. 每分钟 close 使用与 collector 同源的腾讯已完成、右端标记 m1 bar；完整分钟 close/正量证明不能由采样价或累计日量替代。每分钟端点后 8 秒取数，三并发上限；只读精确当前分钟，不补发错过分钟。2026-11-06 四只各 180 个可返回 bar（10:31–15:00）与 CN 原始 k1 库交叉核对，720/720 close 和正量资格一致。腾讯 volume 单位为手、原库为份，只比较正量资格。
3. NAV 选择 CN 直拉东方财富 `api.fund.eastmoney.com/f10/lsjz` 的带日期单位净值（小页请求）。已实测 159696 的 2026-11-05 NAV=1.6589，与本地新浪历史一致；上线前补四只交叉核验。只接受精确上一中国交易日的 NAV，禁止 latest-before 任意回填、IOPV、PCF T−2 替代。
4. 被拒的候选：collector `nav_daily` 最新停留在 2026-09-10；mirror 最新 11-06 PCF 的 `prevDayDate` 是 11-04；均不满足 T−1。新浪 HTTPS 本次从 CN 可访问，但不作为生产依赖；无需 VM 同步和 VM 常驻凭证。
5. 每日 06:00–09:29 每五分钟尝试 NAV，原子冻结当天 `nav-YYYY-MM-DD.json`。截至 09:30 未完整就绪，当天全部关闭；盘中晚到数据不能解锁。成功记录包含 expected NAV date、四只数值、源、获取时间、哈希。

## 策略与调度决定

- 常态初值（pp）：513100=7.7054、159696=6.7413、159501=7.2303、159941=6.7483；拟合窗 2025-11-07–2026-11-06；2027-01-01 起每自然季度首日用此前一年正量分钟溢价中位数重算。独立历史库由本地原始分钟/NAV 种子初始化，盘中补写完成 bar，季度时再只读合并 CN k1。完整交易日日历、分钟和逐日 T−1 NAV 缺失则重算失败，旧常态过期后禁止信号。
- `premium_pp=100*(close/NAV(T−1)−1)`；`deviation_pp=premium_pp−normal_pp`。可交易池按偏离最小选目标，平局按代码升序；差值严格 `>0.5pp`，保留浮点容差。持仓停牌/无量则等待；停牌/无量候选排除。
- 触发即锁定目标，下一完成分钟双方都正量且新鲜才记参考换仓。午休后的下一完成 bar 是 13:01（腾讯右端标记）；15:00 无下一 bar，只记取消且不跨日。下一分钟缺失/无量/过期即取消，不延期成交、不重新选择该挂单目标。
- 独立 `/etc/cron.d/ai-dca-four-etf`：工作日 06:00–15:59 每分钟短任务，程序过滤盘前准备、09:30–11:30/13:00–15:00、休市；季度另有自然季度首日 00:10 重算。选择 cron 而非新 supervisor：无需修改共享 supervisor、崩溃后下一分钟自愈，flock 防并发；每日状态保存 pending 和最后处理分钟。
- 日历从仓库 collector 的已配置年份复制到本服务；未知年份失败关闭，不猜休市日。2027 日历需在官方发布后补入本服务（不能改 relprice）。季度重算不依赖重算日为交易日。

## 投递与可恢复性

- 新路由 `/api/notify/internal/four-etf-signal`，事件 ID `fourETF:YYYY-MM-DD:HHMM`（信号分钟）。新鲜性、交易日/时段、严格阈值、T−1/pre-open NAV 和下一分钟执行证明在 Worker 再检查。
- 沿用现有 root sync daemon 内存中的 INTERNAL_SYNC_TOKEN；不保存密钥、不读邮箱原文/用户 session、不新建或更改绑定。只传 `['email']` 给现有账户投递链路，复用 Resend → Brevo → Cloudflare、额度和 D1 幂等。
- 参考持仓与一次性投递标记先持久化再 POST；超时/失败不自动重发，宁可漏发。Worker 用独立 D1 `notify_four_etf_signal_claims` 的 owner+event 主键先原子认领，再调用共享投递器；并发重复请求和未知失败均不得重发。迁移只建本策略表，不改账户/通道或旧投递表。重启不得重复执行/推送；只能只读查询事件的 D1 结果。提供带原因的持仓覆盖命令。
- 保留部署前 Worker 全部模块与设置，只新增两个模块并改 main_module；通过 CF API 独立下载核对原模块哈希、bindings、版本和原 handlers。不得从落后的本地 bundle 覆盖现网。此方式沿用 relprice 的直接 API 部署；用户本次禁止 push，不能触发依赖 push 的旧 CI 流程。

## 实施步骤与验收

1. 隔离 worktree、数据源实测及本计划。
2. 实现纯策略引擎、日历/NAV 门禁、分钟适配、原子状态/日志、季度重算、CLI 和独立 cron。
3. 实现 Worker 包装入口/校验/email-only 路由，补真实行为测试。
4. 单测：偏离、严格 0.5pp、停牌/无量、NAV 缺失/过期、下一分钟确认/锁定、15:00、日界/午休、幂等、宕机/失败不补发、季度完整性。
5. 本地原始分钟+NAV 完整回放 11-05/11-06；分别报告历史冻结常态和实盘初值。任务书的 16.86 vs 15.78（差 1.08）来自冻结 2.74/3.00；实盘初值对应 12.8560 vs 12.0294（差 0.8266），两者最后一分钟目标均为 159941。不得为复现历史数字篡改实盘常态。
6. 相关 Node 测试、refactor guard、lint、diff 检查；只提交本任务文件。
7. 用本地 bundle 部署 CN 独立 worktree，初始化独立数据/159696 状态，装本任务 cron；现网新增路由，API 独立验证版本/保留内容。
8. 周末 dry-run 真实跳过并日志；检查 CN 文件/任务/源码哈希；只读核对 lovexl email 已验证启用、绑定哈希不变、没有虚构测试换仓邮件。
9. 交付 `docs/validation/four-etf-live/deployment.md` 及机器可读证据；2026-11-09 开盘开始评估，第一天真实信号由主助手人工核对。

## 风险与验收边界

- 源站更新延迟、缺 bar、缺 T−1 或网络异常均会漏信号，这是本策略失败关闭的选择。盘前 NAV 在 QDII 场景可能尚未发布；不得用 T−2 顶替。
- 邮件仅在真实换仓确认后投递；周末不能验证真实投递和周一采样延迟。报告明确区分已验证部署/回放与待首个真实事件的 D1 成功证据。
- 参考状态并不代表证券成交；初始 159696 是用户确认，之后为策略路径。人工实际持仓不同时必须审计纠正。


> 2026-11-09 更新：用户决定改用 NAV(T−2)，`premium_pp=100*(close/NAV(T−2)−1)`；上文 T−1 及「不得用 T−2 顶替」条款作废。常态按 T−2 重算，见服务 README。
