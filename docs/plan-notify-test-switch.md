# Plan：送达测试包含高级规则（switch 切换规则）

日期：2026-10-21。需求：dudu 截图反馈，通知页「高级规则」区的「送达测试」弹窗里选不到下方的切换规则（招商-华安 切换、博时-华安），要求加上。

## 根因（已查实）
- `src/pages/NotifyTestDialog.jsx` 的 ruleOptions 只有四类：price-alert（marketAlerts+holdingAlerts）、trade-plan、dca、holdings。组件 props 没有 switchConfig。
- 高级规则列表的数据在 `src/pages/NotifyExperience.jsx:73`：`useSwitchNotifyRules()` 返回 switchConfig，已传给 NotifyRulesCard（src/pages/NotifyRulesCard.jsx:66,155 渲染 switch 行），但没传给 NotifyTestDialog。
- 后端无需改：CN `services/cn-data/src/notify/routes.js` 的 POST /api/notify/test 用 `notificationFromTestPayload` 透传 title/body/ruleId，不校验 ruleType；`deliverTestNotification` 走账号全部渠道。

## 改动
1. `src/pages/NotifyTestDialog.jsx`
   - 新增 prop `switchConfig`。
   - ruleOptions 新增一类：key `switch`，label「切换规则」，description「基金切换提醒」，icon 用 lucide 的 Shuffle（与列表行一致）。
   - rules 口径与 NotifyRulesCard:66/155 完全一致：仅当 `switchConfig?.enabled` 为真时纳入；规则过滤 `(rule?.benchmarkCodes?.length || rule?.enabledCodes?.length)` 且 `rule.enabled !== false`；id 用 `rule.id || \`switch-${index}\``；label 用 `rule.name || \`切换规则 ${index + 1}\``；detail 用 `持仓基准 ${benchmarkCodes.length} 只 · 候选 ${enabledCodes.length} 只`；type 为 'switch'。
   - handleSend 把选中规则的 label 作为第三参传给 onSendTest：`onSendTest?.(selectedType, selectedId, currentRule?.label)`（第三参可选，其他调用方不受影响）。
2. `src/pages/NotifyExperience.jsx`
   - 给 NotifyTestDialog 传 `switchConfig={switchConfig}`。
   - `handleSendTestNotify(ruleType, ruleId, ruleLabel)`：body 拼接，有 ruleLabel 时用 `这是「${ruleLabel}」的测试通知`，没有时保持原文案 `这是一条来自"${ruleType}"的测试通知`。其余（title、埋点、toast）不变。
3. 不改后端，不改 NotifyRulesCard。

## 测试与验收
- `test/notifyManagementUi.test.mjs` 增加断言：NotifyTestDialog 源码包含 switch 类（key/label/过滤口径关键片段）、NotifyExperience 源码包含给 dialog 传 switchConfig。
- 跑 `node --test test/notifyManagementUi.test.mjs`（注意该文件有既有基线失败，只许零新增）、相关文件 eslint、`npm run build:app`、`git diff --check`。
- 合入 cn 并 push fork，autorelease 发布后在 fast 站核查 RELEASE.json commit。
