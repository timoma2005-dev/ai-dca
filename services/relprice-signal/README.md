# relprice B_REL 信号（CN）

独立 Python 标准库任务；不使用证券账户、券商接口、下单或自动交易。冻结定义与验收进度见 [计划](../../docs/plan-relprice-live-signal.md)。

## 运行方式

生产源码位于 CN `/root/ai-dca-relprice-live/services/relprice-signal`（独立 git worktree）。配置 `/etc/ai-dca-relprice.json`；运行状态与信号日志 `/var/lib/ai-dca-relprice/`。cron 文件 `/etc/cron.d/ai-dca-relprice` 每工作日北京时间 14:40 启动一次；日历再过滤休市日，未知年份失败关闭。

14:40 等待 8 秒后读取本机 `/latest`，校验快照和 12 只逐标的行情时间（上限 45 秒，未来时间容差 2 秒）。历史从只读 `stockdb_m1.db` 取前 30 个交易日的 **14:40 mark**。腾讯 `ifzq.gtimg.cn` 同源分钟接口补足完成的 14:40 bar close/volume 资格证明，最多 3 个并发；不以快照累计日量冒充分钟量。12 只的 14:40、14:41 close 已逐只与 2026-11-06 的 CN 分钟库交叉核验。

每次先写同一冻结输入的 dry-run 计算记录。持有日只记日志；换仓目标冻结后等待 14:41 或之后双方首个共同正量完成 bar，记录其 close 作为回测口径参考，才通知。为确认完成的分钟数据，正常通知约在 14:41:08 之后，取决于源站更新时间；没有共同 bar、行情过期或取数失败均不推送。最晚观察 15:00 bar，15:00:45 后取消。所有 HTTP 均显式绕过代理。

`state.json` 是**策略参考持仓**，初始假设 513110，截至 2026-11-06，实际持仓未确认。有效持有日或模拟换仓执行后推进该参考状态；这不表示用户已经实际成交。推送失败也会保留已记录的策略路径，失败记录不会自动重发。网络结果不确定时，宁可漏发。

## 运维入口

```bash
# 默认也是 dry-run：写日志，不投递、不推进实盘状态。
python3 -B /root/ai-dca-relprice-live/services/relprice-signal/run-cn.py \
  --config /etc/ai-dca-relprice.json --dry-run

# 只核对账号已有 email 绑定是否已验证/启用，不发送测试邮件。
python3 -B /root/ai-dca-relprice-live/services/relprice-signal/run-cn.py \
  --config /etc/ai-dca-relprice.json --check-notify

# 用户实际持仓不符时覆盖，写审计日志；as-of 取待算信号之前的持仓日期。
python3 -B /root/ai-dca-relprice-live/services/relprice-signal/run-cn.py \
  --config /etc/ai-dca-relprice.json --set-holding 159501 \
  --as-of 2026-11-06 --reason '用户确认并纠正实际持仓'

# 查询首次实际事件的 D1 投递记录，不发送、不重试投递。
python3 -B /root/ai-dca-relprice-live/services/relprice-signal/run-cn.py \
  --config /etc/ai-dca-relprice.json --verify-delivery relprice:B_REL:YYYY-MM-DD
```

`signals.jsonl` 每次记录日期、持仓、目标（持有日也记录最优替代候选）、差值 bp、决策、新鲜度、输入哈希与模式。`decision-YYYYMMDD.json` 是单日已提交凭证；`first-delivery.json` 只在 Worker 从 D1 查询到真实 email `delivered` 后生成。不可手工删除单日凭证以重发；纠正持仓使用上述命令。

关闭推送可将配置的 `notifications_enabled` 设为 false；仍记录参考状态。停止任务可移除本任务自己的 cron 文件。不要启停 `ai-dca-switch-monitor` 或编辑它的配置/状态，不访问 `/opt/quant-shadow/` 写路径。

## 通知链路与密钥

Worker 独立入口 `relpriceEntry.js` 将 relprice 路由交给 `relpriceSignalRoute.js`，其余 fetch/queue/scheduled 继续交给现有入口。CN 启动器仅在运行时内存中继承原有、root 所有且 argv 精确匹配的 sync daemon 的 `INTERNAL_SYNC_TOKEN`；找不到就失败关闭。既不把密钥复制到配置/日志，也不读取 provider 密钥、session token_hash 或邮箱原文。

路由仅接受 lovexl、当天交易时段、60bp 达标的换仓消息，固定事件 ID `relprice:B_REL:YYYY-MM-DD`。调用现有 `deliverAccountNotification` 动态解析 D1 `client-channel`，仅选 email，继续使用现有 Resend → Brevo → Cloudflare Email Service 降级、每日配额与 `notify_delivery_attempts` 幂等。不创建或更改通道。

客户端使用明确服务 UA，并复用同仓库 market-collector 的 CF IPv4/TLS 优选（最多 6 秒探测），保留真实域名、SNI、Host 与证书验证；本进程启用此选项，不改其他服务。代理与重定向关闭，POST 结果不确定时不自动重试。

投递后路由再次按 owner + event ID 从 D1 查询 email 状态；只有 `delivered` 才返回成功及脱敏后的投递行。`--check-notify`、`--verify-delivery` 均为只读且绝不发消息。周末或持有日不得发历史回放/测试邮件来冒充首次真实推送。

## 验证

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/relprice-signal \
  python3 -B -m unittest discover -s services/relprice-signal/tests -v
node --experimental-vm-modules --test \
  workers/notify/test/relpriceSignal.test.mjs \
  workers/notify/test/accountDeliveryIsolation.test.mjs \
  workers/notify/test/emailProviders.test.mjs \
  workers/notify/test/reliability.test.mjs
python3 -B services/relprice-signal/build_reference.py \
  --backtest-root /home/hatch/workspace/quant-backtest \
  --output services/relprice-signal/tests/fixtures/backtest-reference.json
python3 -B services/relprice-signal/replay.py \
  --db /root/m1store/stockdb_m1.db \
  --reference services/relprice-signal/tests/fixtures/backtest-reference.json \
  --output-dir /var/lib/ai-dca-relprice/replay
```

回放验证最近 30 个交易日（2026-09-18 至 11-06）的信号、目标、持仓、分差、成交时刻和成交 close 与冻结回测一致；特殊检查 10-15 的 159501→513110、11-06 持有 513110。回测输入及实现哈希包含在 oracle/报告中，回测目录保持只读且禁写旧 pyc。
