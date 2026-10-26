# etf-history：份额页单只基金历史（SVIP）

`build_history.py` 生成 `/var/lib/ai-dca-etf-history/{code}.json`（13 只纳指 ETF，2025-10-13 起每个交易日一行：
总份额 / 新增 / 生效申购上限 / 是否允许申购 / 收盘价 / 单位净值 / 溢价率），前端「份额新增 → PCF 清单弹窗 → 历史」页签读取。

- 访问控制：nginx `location ~ ^/api/etf-history/(\d{6}|index)\.json$` + `auth_request /_rbac/etf-history`
  （auth 服务 `api:etf-history`，迁移 `services/auth/migrations/004-etf-history-perm.sql`，授予 svip，admin 继承）。
- 定时：`cron.d-ai-dca-etf-history` 安装到 `/etc/cron.d/ai-dca-etf-history`（工作日 09:45 / 12:30 / 22:30 CST），日志 `/var/log/ai-dca-etf-history.log`。
  增量：已完整的行跳过，最近 6 个交易日重抓。
- 数据源：腾讯日 K（不复权收盘，东方财富兜底）、东方财富 lsjz 单位净值、上交所 ETF 规模（STAT_DATE）、深交所基金规模 xlsx、
  申购额度先读种子 `/var/lib/ai-dca-etf-history-seed/limits-seed.json`（一次性从 CF KV `etf-pcf:{code}:{yyyymmdd}` 导出），缺的日期走本机 etf-mirror `/etf-pcf-limit`。
- 溢价率 = 收盘价 / 同日单位净值 − 1（QDII 净值 T+1 公布，当日溢价次日补齐）。
