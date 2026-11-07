# CN 部署与验收状态（2026-11-07）

- 分支：`feat/relprice-live-signal-20261107`；最终实现提交 `1860c02b`（含首次启用门禁；此前实现 `20c3a058`、客户端 `65fa6539`、IPv4 `90b6a9ef`）。本地及 CN 均使用独立 worktree；通过本地 bundle 传输，未推送任何 remote。
- CN 源码：`/root/ai-dca-relprice-live/services/relprice-signal/`。
- 运行配置：`/etc/ai-dca-relprice.json`（无密钥）；初始参考持仓 513110，日期 2026-11-06，实际持仓未确认。
- 任务：`/etc/cron.d/ai-dca-relprice`，北京时间工作日 14:40；独立日历过滤。先完整 dry-run，冻结目标，等双方首个共同正量完成 bar 后，只有换仓才投递。
- 日志：`/var/lib/ai-dca-relprice/signals.jsonl`；cron stdout：`/var/log/ai-dca-relprice.log`；原库回放：`/var/lib/ai-dca-relprice/replay/`。
- 首次 D1 投递核验通过后才会生成：`/var/lib/ai-dca-relprice/first-delivery.json`。没有这个真实成功证据不能宣称全部验收完成。
- Worker 部署证据见 `worker-deployment.json`。保留原 Worker bundle / source map / bindings / secret / 原 handlers，新增独立 relprice 入口；投递后按 owner + event_id 查询 D1 email 状态。
- CN 配置、cron/源码哈希、进程、首批日志与当前 D1 查询结果见 `cn-deployment.json`。系统 Python 23/23、相关 Node 21/21 通过；30/30 交易日回放一致。
- 今天为周六：实际 dry-run 记录 `non_trading_day`。交易时段新鲜数据完整 dry-run 及首次真实换仓邮件 D1 成功记录仍待发生；每次 live 自动在投递前先验证并记录 dry-run。
- 当前推送配置为 `notification_mode=after_dry_run`，等待首个交易时段完整新鲜数据 dry-run 成功后自动改为 `enabled`，周末不会启用。停推设为 `disabled`；停止整个任务可移除自己的 cron 文件。持仓纠正命令见服务 README。
- fork 推送等待用户一次性 token。不会 force push，也不改写共享历史。

改动文件清单：

- `docs/plan-relprice-live-signal.md`
- `docs/validation/relprice-live/checks.md`
- `docs/validation/relprice-live/cn-deployment.json`
- `docs/validation/relprice-live/deployment.md`
- `docs/validation/relprice-live/replay-last30.csv`
- `docs/validation/relprice-live/replay-report-cn.json`
- `docs/validation/relprice-live/replay-report.json`
- `docs/validation/relprice-live/source-probe.json`
- `docs/validation/relprice-live/worker-deployment.json`
- `services/relprice-signal/README.md`
- `services/relprice-signal/build_reference.py`
- `services/relprice-signal/config.example.json`
- `services/relprice-signal/deploy/cron`
- `services/relprice-signal/relprice_signal/__init__.py`
- `services/relprice-signal/relprice_signal/__main__.py`
- `services/relprice-signal/relprice_signal/data.py`
- `services/relprice-signal/relprice_signal/notify.py`
- `services/relprice-signal/relprice_signal/rules.py`
- `services/relprice-signal/relprice_signal/runner.py`
- `services/relprice-signal/replay.py`
- `services/relprice-signal/run-cn.py`
- `services/relprice-signal/tests/fixtures/backtest-reference.json`
- `services/relprice-signal/tests/test_notify.py`
- `services/relprice-signal/tests/test_signal.py`
- `workers/notify/src/relpriceEntry.js`
- `workers/notify/src/relpriceSignalRoute.js`
- `workers/notify/test/relpriceSignal.test.mjs`
- `workers/notify/wrangler.toml`
