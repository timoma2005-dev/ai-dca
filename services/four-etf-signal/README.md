# 四 ETF 溢价切换（CN 实盘信号）

只发信号，不自动交易。定义和实测来源见 [计划](../../docs/plan-four-etf-live-signal.md)，部署证据见 [验收](../../docs/validation/four-etf-live/deployment.md)。

- 池：513100/159696/159501/159941；初始参考持仓 **159696**，截至 2026-11-06，用户已确认。
- 标准库 Python，无 pip 依赖。独立 cron 每分钟进入，交易日 09:30–11:30、13:00–15:00 在端点后 8 秒评估已完成 bar。09:30/13:00 如无完整 bar 只记日志。腾讯 m1 close/分钟量（手转换成份）+ collector `/latest` 时间/停牌资格；所有 HTTP 显式绕过代理。
- NAV 从东方财富 f10 带日期历史取精确上一中国交易日。06:00–09:29 每五分钟（含 09:29 最后一次）准备；09:30 前四只未全部就绪则全天关闭。盘中不拉 NAV 解锁，不使用 IOPV/PCF。
- 常态为最近一年正量分钟溢价中位数，初值按任务书，2027-01-01 起季度首日更新；完整历史/NAV 不齐不沿用过期常态。日历未知年份关闭；需在官方年度日历发布后只更新本服务 Python/Worker 的日历。
- 严格偏离差 `>0.5pp` 才锁定目标，下一分钟双方正量新鲜 close 确认。午休 11:30 后的下一完成 bar 为 13:01。下一分钟缺失或不可交易取消，15:00 触发当日取消，不跨日。持有日不推送。
- `notification_mode=enabled` 从首日允许真实确认换仓推送；账户 lovexl 的已有 email，经现有 Resend → Brevo → Cloudflare。配置/日志无密钥；启动时只从精确 root sync daemon 进程内存继承内部认证。
- 状态先提交、事件发送意图先落盘、POST 不自动重试。可能漏信号，避免重复。事件 `fourETF:YYYY-MM-DD:HHMM`，Worker 先在独立 D1 `notify_four_etf_signal_claims` 用 owner/event 主键原子认领，再走原 email 投递器；并发或未知失败也不重发。上线前应用 `deploy/20261108-four-etf-claims.sql`（只建独立表），`first-delivery.json` 仅在 D1 真正 `delivered` 后生成。

CN 路径：源码 `/root/ai-dca-four-etf-live`，配置 `/etc/ai-dca-four-etf.json`，状态/`signals.jsonl`/`inputs`/`events`/`history.sqlite3`/`nav-*`/`normal-*` 均在 `/var/lib/ai-dca-four-etf`；任务 `/etc/cron.d/ai-dca-four-etf`；stdout `/var/log/ai-dca-four-etf.log`。

```bash
python3 -B services/four-etf-signal/run-cn.py --config /etc/ai-dca-four-etf.json --dry-run
python3 -B services/four-etf-signal/run-cn.py --config /etc/ai-dca-four-etf.json --check-notify
python3 -B services/four-etf-signal/run-cn.py --config /etc/ai-dca-four-etf.json --verify-delivery fourETF:YYYY-MM-DD:HHMM
python3 -B services/four-etf-signal/run-cn.py --config /etc/ai-dca-four-etf.json --set-holding 159696 --as-of 2026-11-06 --reason '用户确认实际持仓'
python3 -B services/four-etf-signal/run-cn.py --config /etc/ai-dca-four-etf.json --recalculate
```

`--dry-run` 默认不投递、不推进持仓或消费分钟；仅日志（首次调用可初始化初始状态）。`--check-notify`/`--verify-delivery` 只读，不会创建事件/占额度/发测试邮件。手工覆盖只纠正参考持仓并清 pending，保留最后处理分钟防重发。停推将本配置改为 `disabled`；停整个任务只移除本任务 cron，不能操作其它监控或 relprice。

初始化 archive 使用 `seed-history.py --source /path/to/quant-backtest/data --data-dir /var/lib/ai-dca-four-etf`，拒绝覆盖已存在库。每季度还会只读补取 `/root/m1store/stockdb_m1.db`，缺交易日/分钟或 NAV 则失败关闭。该库必须继续由既有采集流程维护；本服务不改源库。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/four-etf-signal python3 -B -m unittest discover -s services/four-etf-signal/tests -v
node --experimental-vm-modules --test workers/notify/test/fourETFSignal.test.mjs workers/notify/test/relpriceSignal.test.mjs
python3 -B services/four-etf-signal/replay.py --data-root /home/hatch/workspace/quant-backtest/data --output-dir /tmp/four-etf-replay
```

回放必须区分历史参考持仓与本次实盘初始持仓。11-05 持有日从原复现 ledger 的 159941 开始。11-06 全天按本次 159696 初值走真实分钟路径；15:00 冻结持仓 159696 的诊断单列，历史常态得 16.86 vs 15.78，实盘常态得 12.8560 vs 12.0294，均指向 159941，但 15:00 没有下一分钟而不推送。不可把该诊断假称为已经确认的全天末笔换仓。

Worker 生产使用 [fourETFEntry.js](../../workers/notify/src/fourETFEntry.js) 包装原 relprice 入口。独立 `wrangler.four-etf.toml` 用于构建；原 `wrangler.toml` 未改。本次直接 CF API 仅新增模块/切入口并保留现网所有旧模块和 bindings（与 relprice 的部署模式一致），不从过时本地源码重建覆盖线上 Worker。
