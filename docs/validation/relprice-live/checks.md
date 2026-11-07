# 2026-11-07 relprice 验证记录

- CN 分钟库只读抽取前 60 个交易日（172,800 根分钟 bar，加各标的一个前置 seed），样本文件 SHA256 `1dc10dd187477cb4cb99da216dac3059825bb89ae3205d1cc226e8697ff13c2d`。仅临时验证副本，未修改来源库。
- `replay-last30.csv` / `replay-report.json`：30/30 日逐日一致，14:40 价格误差 0，最大分差误差 `2.6361135496699717e-12 bp`（标准库与 numpy 浮点实现差异）。三次换仓的首个共同 bar 均为 14:41，双方成交 close 也一致。
- `source-probe.json`：腾讯实时分钟接口返回的 2026-11-06 12 只 × 14:40/14:41，24 个 close 与 CN 历史库完全一致，正量资格也一致。此为历史源站交叉核验，不冒称交易时段 live dry-run。
- 本任务 Python 与通知相关 Node 测试通过；覆盖历史回归、公式、阈值/容差、缺失/停牌/无量、成交取消、快照陈旧/未来、节假日、状态纠正、幂等、dry-run 无副作用、D1 投递核验。
- 扩大检查发现基线已有问题，已在未改动的 `7e25bef4` detached worktree `/tmp/ai-dca-relprice-baseline-20261107` 复现：
  - `npm run check:refactor`：NotifyExperience.jsx 938/880 行、NewPlanExperience.jsx 652/650 行。
  - `npm run lint -- --quiet`：account-data-migration-modal.jsx:399 Hooks 调用位置；NotifyEventDetailDialog.jsx:74 空块。
  - 通知扩展集原 111 个测试 105 过/6 失败：email 第五次配额提示 1 个，nasdaqRadar 4 个，radarScoring 1 个。原隔离测试需要 `--experimental-vm-modules`，加参数后这 3 个通过。
- 交易时段真实 dry-run 与首封真实换仓邮件属于待到市况触发的验证；当前周六不会制造历史换仓/持有日推送来填充 D1。所有完成声明须保留这一区别。
- CN 部署 worktree 在 `/root/ai-dca-relprice-live`，原库回放也通过，系统 Python 浮点误差上限 2.78e-12bp；CN 系统 Python 单元测试 18/18 通过。实际运行的周末 dry-run 正确写 `non_trading_day`，参考持仓仍为 513110。
- 只读通知预检：Python urllib 默认 UA 受到 Cloudflare 1010 限制；客户端标识 `ai-dca-relprice/1.0` 后返回 HTTP 200，email `ready=true`。使用既有内部认证，未读取/落盘/输出密钥值，未修改防火墙或通道。
