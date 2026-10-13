# BUG-001 回归简报：Bark / Server酱 推送超时保护被整体还原

编写：Muse（research）· 2026-10-09 16:40 CST · 状态：已从 git 历史和当前代码核实，修复计划待 Codex 出 plan

## 回归链条（已核实）

- `21b8146e`（2026-09-11）加了 6 秒超时保护：
  - `workers/notify/src/channels/bark.js`：`NOTIFY_PROVIDER_TIMEOUT_MS = 6000` + `buildProviderSignal()`（`AbortSignal.timeout`），`sendBarkNotification` 的 `fetch('https://api.day.app/push', …)` 带 `signal`，超时抛 `Bark 推送失败：上游 6 秒内未响应`；
  - `workers/notify/src/channels/serverChan3.js`：同等保护；
  - `test/notifyChannelTimeout.test.mjs`：44 行配套测试。
- `8f297351`（2026-09-12，"chore(notify): sync cn worker to main"）把 `bark.js` 整体还原回 `9c4ff19c`（diff 证明：删除了全部超时相关代码）；`serverChan3.js` 同理被改回。
- 当前 `cn` 分支（生产 notify worker 的构建源）：
  - `bark.js`：`grep -c "AbortSignal.timeout\|NOTIFY_PROVIDER_TIMEOUT"` = 0；
  - `serverChan3.js`：`grep -c "AbortSignal.timeout\|TIMEOUT_MS"` = 0，`fetch(endpoint, …)`（L147）无 signal；
  - `test/notifyChannelTimeout.test.mjs`：`cn` 分支不存在（只在 work-holiday-main 等分支有）。

## 影响

生产 notify worker 的 Bark（api.day.app）和 Server酱（serverChan3）推送是无超时 `fetch`。
若上游挂起（hang），推送任务会卡住当前 worker invocation 的等待窗口，
可能拖慢整批通知的投递结算。10-08 的 15:30 批次验证通过不代表链路有超时保护。

## 修复方向（供 Codex 出 plan 时参考）

1. 恢复 `buildProviderSignal()` + 6 秒 `AbortSignal.timeout` 到两处 `fetch`；
2. 超时错误信息保持中文可读（`Bark 推送失败：上游 6 秒内未响应` 同类文案）；
3. 恢复 `test/notifyChannelTimeout.test.mjs` 到 `cn`（用 21b8146e 的版本为基线，按当前文件结构适配）；
4. 检查是否还有其他 channel 的 `fetch` 同样无超时（顺带审计，非必须）。

## 验收标准

- `cn` 分支两处 channel 的 `fetch` 均带 6 秒 signal；
- 超时测试在 `cn` 重新跑绿（21b8146e 的测试逻辑移植）；
- `npm run check:refactor` / lint 不新增问题；
- 部署 notify worker 后，用一个指向黑洞地址的测试配置验证 6 秒内失败而非挂起（生产配置不动）。

## 备注

- known-bugs.md 已在 phase-0（06712e1e）中记录此 bug；本文件是可直接交给 Codex 出 plan 的输入。
- 生产部署走新流程（timoma2005-dev 仓库 + deploy-unified.sh），不再经 GitHub Actions。
