# 四 ETF 实盘信号部署与验收

结论：四 ETF 信号已隔离实现并部署 CN/线上 Worker，63 项相关测试、原库回放、真实 cron 周末跳过和只读 email 绑定核验通过；已从首日启用推送，周一实际盘中采样及首笔真实换仓邮件仍待市场事件验收。

## 部署目标

- 本地独立 worktree：`/home/hatch/workspace/ai-dca-four-etf-live`；分支 `feat/four-etf-live-signal-20261108`；基线 `af9745fb`，实现提交 `e21cdab6`。
- CN 独立 worktree：`/root/ai-dca-four-etf-live`；配置 `/etc/ai-dca-four-etf.json`；状态/历史/输入/事件/日志 `/var/lib/ai-dca-four-etf/`。
- 初始参考持仓：**159696，截至 2026-11-06，用户已确认**；`notification_mode=enabled`，首个交易日起允许确认换仓邮件，不设置额外启用门槛。
- cron：`/etc/cron.d/ai-dca-four-etf`；工作日 06:00–15:59 每分钟入口，程序按北京时间过滤；06:00–09:29 准备 NAV，09:30–11:30 / 13:00–15:00 逐分钟评估。自然季度首日 00:10 重算，首个重算日 2027-01-01。
- Worker：`ai-dca-notify`，独立入口 `fourETFEntry.js`，新增路由 `/api/notify/internal/four-etf-signal`。
- 上线版本 **`65b34fdc-82c6-4102-b822-733b55c1304a`**，100%；deployment `31308db8-5c71-480f-892d-74d7e68222b3`，2026-11-08 00:38:15 北京时间。回滚版本 `75c05acc-77fa-4e64-8d48-b006365ef08f`。

## 数据及规则证据

- 四只起始常态从原始分钟+NAV 独立重算，四舍五入均与任务书一致：7.7054 / 6.7413 / 7.2303 / 6.7483pp。正量分钟数分别 53,300 / 54,165 / 52,965 / 53,813；独立 archive 包含每只 58,080 分钟及 245 个 NAV 日期。
- `/latest` 只提供新鲜性/停牌资格；腾讯完成 m1 提供精确当前分钟 close/正量证明，端点后 8 秒读取、三并发、全部绕过代理。可返回的 11-06 四只各 180 bar 与 CN k1 close/正量资格逐条一致（720/720）；volume 转换手→份。
- NAV 生产来源选择 CN 直拉东方财富 f10（pageSize=10）。四只最近 10 日期与本地原始 NAV 交叉核对；只用精确上一中国交易日，且当天 09:30 前全部就绪。mirror PCF 的 `prevDayDate=11-04`、collector 停留 09-10 的 NAV 均被拒；不使用 IOPV 或任意旧 NAV 补齐。
- 触发阈值严格 `>0.5pp`，目标锁定；下一完成分钟双方正量新鲜 close 才推进参考持仓并投递。下一分钟缺失/无量取消，15:00 候选取消，无跨日挂单。持仓停牌等待，可交易池排除停牌/无量目标。
- 投递前先持久化状态及一次性意图；不自动重试超时/失败邮件。事件 ID `fourETF:YYYY-MM-DD:HHMM`。只复用 lovexl 既有 email，无真实换仓不发信。

## 回放口径

| 检查 | 初始状态/常态 | 结果 |
|---|---|---|
| 2026-11-05 全天 240 分钟 | 原复现 ledger 当日初始 159941；实盘常态初值 | 持有 159941，0 换仓、0 待推送、0 实际邮件 |
| 2026-11-06 全天 240 分钟 | 本次部署初始 159696；实盘常态初值 | 10:32 触发 159696→159941，10:33 双方正量 close=1.982/1.579 确认；仅离线记录，0 实际邮件 |
| 11-06 15:00 固定持仓诊断 | 固定 159696；历史冻结常态 4.04/2.74/2.77/3.00 | 偏离 16.8573 vs 15.7777，差 1.0796pp，目标 159941；无下一分钟而取消，0 待推送 |
| 11-06 15:00 固定持仓诊断 | 固定 159696；任务书实盘初值 | 偏离 12.8560 vs 12.0294，差 0.8266pp，同一目标并取消，0 待推送 |

任务书把历史固定持仓收盘诊断与实盘全天状态路径放在同一验收句中。上表分别验证两者，不为凑 16.86/15.78 修改实盘常态，也不把 15:00 候选伪称为已成交换仓。11-05 的历史起始持仓从原结果 `supplied_d1_zero_daily.csv` 只读取证；本次真实 CN 初值仍然是用户确认的 159696。

本地原始数据报告见 [replay-local/replay-report.json](replay-local/replay-report.json)，CN 原库见 [replay-report-cn.json](replay-report-cn.json)。两个交易日的输入哈希、240 条分钟状态 trace 哈希、成交和收盘诊断均逐项相同；没有发送历史邮件。数据源实测见 [source-probe-cn.json](source-probe-cn.json)。

## 检查结果与边界

- Python 本地和 CN 均 32/32：偏离/阈值、目标排除/持仓停牌、下一分钟锁定/确认/取消、15:00/午休/日界、NAV 精确日期及盘前获取结束时间、行情过期、状态先于发送、幂等及失败不重试、正量分钟季度中位数/缺历史失败关闭。
- 相关 Node 本地和 CN 均 31/31（新增路由 10 项 + relprice/account/email/reliability 21 项）：email-only、认证、大小限制、严格阈值/下一分钟/T−1 门禁、只读绑定/投递查询、D1 成功证明、重复/不确定事件拒绝重发、旧 fetch/queue/scheduled 及具名导出保留。
- 新增 Worker 文件 eslint 和 esbuild 打包通过；`git diff --check` 通过。
- 全局 `npm run check:refactor` 仍失败：基线 NotifyExperience 938>880、NewPlanExperience 652>650；全局 `npm run lint -- --quiet` 仍报基线两处错误（account-data-migration-modal:399 hooks、NotifyEventDetailDialog:74 empty block）。四个文件逐字节等于基线，未修改。详见 [checks.json](checks.json)。
- API 独立查询确认线上版本和全部 handlers；重新下载确认原四模块/源码 map 哈希不变，27 bindings、设置及 10 个原 cron 均保持。见 [Worker 部署证据](worker-deployment.json) 与 [独立 API 核验](worker-independent-check.json)。旧 Worker compatibility date / observability 也保持原设置，未顺带调整共享服务。
- 部署用本地 bundle/scp 和已连接 Cloudflare API。未 push 任何 remote。旧 CI 依赖 push，本次按用户禁令沿用 relprice 的保留现网模块 API 部署方式（[Cloudflare 上传文档](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/)）。
- CN 源码逐文件与本地实现 SHA256 一致，worktree 干净；独立历史库与本地种子 SHA256 一致。初始 state 仍为 159696 / revision 0 / pending=null / actual_holding_confirmed=true。无密钥配置和正式 cron 均 root 所有、0644。系统时区文件逐字节匹配 Asia/Shanghai。
- 临时独立 cron 于 **2026-11-08 00:43:01 北京时间** 真正启动本服务 dry-run，记录 `non_trading_day` / `push=none`；验证任务随后删除，正式工作日 cron 保留。详见 [cn-deployment.json](cn-deployment.json) 内的 cron_verification；不以手工运行冒充调度器证明。
- lovexl 仍只有一条既有 email 绑定，verified/enabled=true；部署前后 payload SHA256 同为 `f3762c885e7a8dda5d5afbcdabcdec0a4af6a42ae45354cc54d53a07dd04b833`。CN 新路由只读检查 ready=true，投递查询 null；D1 没有 `fourETF:*` 投递记录，未占用额度或发送测试邮件。见 [email-binding-after.json](email-binding-after.json)。
- relprice 本地 22 个文件及 CN 22 个保护哈希（含配置、状态、cron 和 root crontab）部署前后相同，见 [isolation.json](isolation.json)。禁止路径和 ai-dca-switch-monitor 没有读写/启停命令。

## 改动清单

所有改动均在新 worktree；仅新增四 ETF 文件及验收产物，没有改已有 relprice 或其它产品源码。

- `docs/plan-four-etf-live-signal.md`：步骤、数据源实测选择、冻结规则、隔离边界、风险与验收。
- `services/four-etf-signal/`：标准库服务（rules/calendar/data/history/storage/notify/runner）、`run-cn.py`、历史种子/回放/数据源探针、配置示例、正式 cron、可选 logrotate 模板、保留现网模块的 Worker 上传器、四组 Python 测试与 README。
- `workers/notify/src/fourETFEntry.js`、`fourETFSignalRoute.js`：独立入口和确认换仓 email-only 路由。
- `workers/notify/test/fourETFSignal.test.mjs`：新路由及旧入口保留测试；`workers/notify/wrangler.four-etf.toml`：独立构建配置，原 `wrangler.toml` 未动。
- `docs/validation/four-etf-live/`：本报告、checks、CN 源/状态/cron 证据、数据探针、原始分钟回放 trace/报告、Worker 上传/独立 API 版本证明、email 绑定前后哈希、隔离保护哈希。

CN 系统没有 logrotate 命令，本次未安装新系统包；模板随源码交付，正式 cron/日志不依赖它。完整文件清单见 `git show --stat e21cdab6` 和本目录证据；运行产物均位于独立 data_dir，没有将 archive 或密钥提交进 Git。

## 周一交接与运维

2026-11-09 开盘开始按分钟评估；主助手人工核对当天真实信号。06:00 起查当天 `nav-2026-11-09.json` 是否存在、`nav_date=2026-11-06`、四只正值、ready_at<09:30。周末实测源站最新仍为 11-05，这不满足周一 T−1；必须等正确日期发布，不能预填 ready 或用 T−2 顶替。

每笔真实确认换仓后核对 `events/fourETF_YYYY-MM-DD_HHMM.json`、`signals.jsonl`、相应冻结 `inputs/`，再运行：

```bash
/usr/bin/python3 -B /root/ai-dca-four-etf-live/services/four-etf-signal/run-cn.py \
  --config /etc/ai-dca-four-etf.json --verify-delivery fourETF:YYYY-MM-DD:HHMM
```

只有 D1 email `delivered` 才能计为首次真实投递成功并出现 `first-delivery.json`。周末不发送测试/历史邮件；持有或数据缺失日无邮件属于预期。首个真实盘中采样及真实邮件投递须在实际市场事件发生后验收，当前不能宣称已经发生。

2027 官方交易日历发布后须只补本服务 Python/Worker 日历；未知年份失败关闭。季度重算如缺源库完整分钟或精确 T−1 NAV，也失败关闭且不沿用过期常态。

停止推送只改本配置 `notification_mode=disabled`；停止整个任务只移除 `/etc/cron.d/ai-dca-four-etf`。持仓纠正使用 README 的 `--set-holding --as-of --reason`，不手删事件凭证重发。Worker 如需回滚，只回到上面的部署前版本；relprice 配置/状态/cron 不改。
