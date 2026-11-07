# relprice B_REL 实盘信号实施计划

## 范围与决策

- 仅产生信号，不连接交易接口。独立 `services/relprice-signal/` Python 服务 + CN cron，隔离于 market-collector 与已停用的 premium switch monitor；不改其配置、持仓或进程，不修改 `/opt/quant-shadow/`。
- 代码基于 fork `cn` 的 `7e25bef4`，本地隔离 worktree `/home/hatch/workspace/ai-dca-relprice-live`，分支 `feat/relprice-live-signal-20261107`。只提交本任务文件；没有用户一次性 token 不推任何 remote。
- 初始参考持仓 **513110**，截至 2026-11-06；这是回测路径假设，用户实际持仓未确认。提供独立状态文件和带日志的人工覆盖命令。信号后的策略参考持仓与人工持仓明确区分，不声称执行过交易。
- 北京时间工作日 14:40 触发一次；交易日历再过滤节假日，未知年份关闭信号。仅换仓日调用通知；持有、缺数据、停牌、过期、非交易日均只写日志。

## 冻结规则（以源代码为准）

已阅读 quant-backtest `round3b/{core.py,run.py,PROTOCOL.md,legacy.py}`、`round3/{core.py,run.py,PROTOCOL.md}` 和真正实现规则的 `discovery/engine.py`。

`round3b.legacy` 调用 `Features.get('rp',30,1440)` 和 `generate(...threshold=60,cost_penalty=0,delay=1)`：

1. 12 只基金按回测完整带交易所代码排序，固定池不增删。
2. `x(t,j)=log(P_14:40(t,j))-mean_j(log(P_14:40(t,j)))`；分数 `x(t,j)-mean(x(t-30:t-1,j))`，不含当日。
3. **回望必须是各日 14:40 mark，不能用 15:00 日收盘替代。** mark 沿历史最后有效正量分钟 close 前向持有；当日信号资格另查 14:40 bar 正量与正价格。实盘缺失必须失败安全，不能随意缩池或改用收盘。
4. 目标是持仓以外合格候选中分数最低者，稳定并列按回测代码顺序。`gap >= .006 - 1e-14` 换仓；低于阈值持有。
5. 冻结 14:40 目标，模拟执行最早 14:41，同日双方首个共同正量 bar close；无共同 bar 则取消。通知须说明只发信号和最早执行时刻，绝不宣称自动成交。

## 数据与通知

- 历史只读 `/root/m1store/stockdb_m1.db` 的 `k1`，从分钟数据提取回测一致的 14:40 mark；校验完整的前 30 个交易日及最近交易日，严禁跳过缺失日凑数。
- 本机 `http://127.0.0.1:18080/latest` 使用 `ProxyHandler({})`，校验快照和逐标的原始行情时间。还需证明 14:40 当分钟的正量与 close，不能用全日累计量大于零替代分钟正量。具体取数适配完成后记录在本计划。
- lovexl 的 D1 `client-channel` 记录已只读确认：只有已验证且启用的 email。通知必须由现有 `deliverAccountNotification` → `deliveryEngine` → email providers 投递，动态读绑定，保留 D1 幂等和投递记录。不写死邮箱，不读取/输出密钥原文，不新增或改写绑定。
- CN 到 Worker 的无人值守入口采用独立的 relprice 路由、复用现有内部同步认证；校验 owner、信号日期/时刻和换仓决策。部署前核对线上 Worker 源码，保留所有现有绑定、密钥与任务配置。

## 步骤、产出与进度

- [x] 冻结规则审阅；创建隔离 worktree；核对 CN 时区、行情形态、分钟库 schema、D1 通道元数据。
- [x] 实现纯规则、历史读取、live 适配、状态覆盖、每日 JSONL 审计与单日幂等。
- [x] 实现复用 notify 的独立投递入口和 CN 客户端，不触碰 premium switch。
- [x] 单元测试：公式、并列、60bp 两侧和等号、停牌/无量/缺失、过期、节假日、重复运行、dry-run 不投递/不推进实盘状态。
- [x] 历史回放：最近 30 个交易日逐日对齐封存 B_REL 持仓/换仓；特别核对 2026-10-15 159501→513110 和 2026-11-06 持有 513110；保存机器可读证据与输入哈希。
- [x] 已运行相关 Node 测试与仓库检查；新增代码及通知链路测试通过，现有分支的 refactor/lint/6 个旧测试失败均在干净基线复现，详见 `docs/validation/relprice-live/checks.md`。
- [x] CN 独立 worktree 部署，原库回放与 18 个 Python 测试通过；周末 dry-run 正确跳过，首次只读 email 预检已确认 ready。
- [ ] 安装最终 cron 和推送运行配置；核对日志/状态/部署文件哈希。
- [ ] 交易时段的完整新鲜数据 dry-run（每次 live 在投递前自动完整执行并落日志）；当前周六，尚不能进行此实测。
- [ ] 首次实际换仓通知后，按 owner + event_id 查询 D1 `notify_delivery_attempts`，仅 email `delivered` 才通过最终投递验收。
- [ ] 提交并汇报文件清单、提交状态；fork 推送等待用户一次性 token。

## 风险与完成条件

- 周六 2026-11-07 不产生实盘换仓信号。不得发送历史换仓邮件、持有日测试邮件来绕过“仅换仓日推送”。真实 D1 成功记录出现前，本任务的投递门保持待验收，不报全部完成。
- 快照新鲜不等于每只标的源行情新鲜；累计日量不等于信号分钟有量。任何证明不足均跳过，日志保留原因。
- 无自动交易时无法自动知道用户是否跟随换仓。独立参考状态的含义与人工纠正入口必须随交付说明。
- 推送失败、超时和重复触发使用固定单日事件 ID；没有 D1 email 成功记录不能仅以 HTTP 200/入队宣称送达。

## 实测记录

2026-11-07：CN `cn` HEAD 与 worktree 基线一致；分钟库 `k1(code,ts,open,close,high,low,vol,amt)`，主键 `(code,ts)`。最新行情为 2026-11-06 收盘后，属于正常周末陈旧数据，必须被 live 新鲜度门拒绝。D1 relprice 投递记录目前为零。

回放（CN 分钟库 60 日只读样本）：2026-09-18–11-06 共 30/30 个交易日一致；14:40 价格误差为零、最大分差误差 2.64e-12bp。10-15 换仓差值 63.427191837737bp；11-06 继续持有 513110，最优替代 159513 的持仓减目标差为 -2.070135907841bp。全部三次换仓的 14:41 双方 close 同回测。

Live 分钟资格适配确定为腾讯 `ifzq.gtimg.cn/appstock/app/kline/mkline` 的完成分钟 bar，最多 3 并发。12 只 × 11-06 的 14:40/14:41 共 24 个 close 与 CN 库逐个一致。快照用于源新鲜度与停牌门禁，分钟 bar 用于固定 14:40 价格及分钟正量；不会以 15:00 价格替换。冻结目标后等首个共同正量 bar，通常 14:41:08 后通知，正常一分多钟延迟用于落实回测执行资格。

Cloudflare 部署采用 content-only API 增加入口包装，保留线上原 bundle 与 source map（仅额外导出现有投递函数供新模块调用）。已发现线上 index.js 与 fork 基线有既有差异，故不从本地全量重打包覆盖线上内容；其余现有 67 份 sourcemap 源码匹配已核对。保留线上所有原任务、绑定、secret 与配置，不用需要 git push 的 CI 触发流程。未来普通源码部署使用新的 wrangler entry，既有线上差异需要由原维护任务另行回收。

CN 原库实测：30/30 一致，最大分差浮点误差 2.78e-12bp；系统 Python 下 18/18 测试通过。周末 dry-run 记录 `non_trading_day`，不推进初始参考持仓。通知客户端的 urllib 默认 UA 被 Cloudflare 1010 拒绝；使用明确 `ai-dca-relprice/1.0` 服务标识后只读认证预检 HTTP 200、email ready，未发送邮件，未修改任何防火墙配置。

通知传输又复用既有 `market_collector.cf_ip_selection` 的 IPv4/TLS 优选，以处理 CN 直连 CF anycast 偶发超时；仍保留真实域名/SNI/Host 和证书校验，且无代理、无重定向、不重试未知结果的 POST。CN 原型已用优选地址完成只读 email ready 预检；增加 3 个传输安全测试，本地 Python 共 21/21 通过。
