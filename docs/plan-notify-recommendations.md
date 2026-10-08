# 通知 Tab「基于持仓自动推荐」计划

## 目标
通知 Tab 顶部新增「为你推荐」区：基于用户持仓 + 实时行情，自动生成可一键开启的提醒推荐。把配置题变成选择题。

## 设计决策
1. **推荐只映射到现有预设**（daily/gain/loss/premium/dca/plan），不新增提醒类型。Worker 零改动，风险最小。
   - 用户举例的"溢价回落到 3% 提醒"属于新类型（方向向下），本次不做，后续单独排期。
2. **推荐文案带具体数据**：引用触发推荐的标的和实时数值（如"159659 当前溢价 8.9%"），而不是泛泛的开关。
3. **一键开启复用现有链路**：`handleTogglePreset(presetId, true)`，阈值调整复用 `handlePresetThreshold`。
4. **展示规则**：
   - 仅当对应预设未开启时出现；开启后自动消失。
   - 每条可单独关闭（x），关闭后不再出现（localStorage 记录）。
   - 无持仓时整个区块隐藏。
   - 行情请求失败时降级：只展示不依赖行情的推荐（gain/loss/daily/dca）。
5. **行情请求轻量**：仅对持仓中的 6 位场内代码调一次 `fetchQuotes`（自带去重/缓存），上限 50 个标的。

## 推荐规则
| ID | 触发条件 | 文案示例 | 动作 |
|---|---|---|---|
| premium:{symbol} | 持仓场内标的当前溢价 ≥ 5%，且 premium 预设未开 | 159659 当前溢价 8.9%，超过 8% 时提醒你 | 开启 premium 预设（阈值可调，默认 8%） |
| gain:all | 有持仓（holdingCost>0）且 gain 未开 | 你持有 N 只基金，单日大涨超 2% 时提醒 | 开启 gain 预设 |
| loss:all | 同上，loss 未开 | 单日大跌超 2% 时提醒 | 开启 loss 预设 |
| daily:all | 有持仓且 daily 未开 | 每天 15:30 推送持仓总览 | 开启 daily 预设 |
| dca:all | 有定投计划且 dca 未开 | N 个定投计划，扣款日提醒你 | 开启 dca 预设 |

排序：premium（按溢价从高到低，最多 2 条）→ gain → loss → daily → dca。

## 文件改动
1. 新增 `src/pages/notify/notifyRecommendations.js`
   - `readHoldingPositions()`：从 ledger 读有持仓标的（复用 useNotifyPresets 内的逻辑，抽成独立函数）。
   - `buildNotifyRecommendations({ positions, quotesBySymbol, presets, dcaCount })`：纯函数，输出推荐列表。
   - `readDismissedRecommendationIds()` / `dismissRecommendation(id)`：localStorage `ai-dca-notify-rec-dismissed-v1`。
2. 新增 `src/pages/notify/NotifyRecommendationCard.jsx`
   - 「为你推荐」区块 UI：图标 + 一句话 + 开关 + 阈值 stepper（premium/gain/loss）+ 关闭 x。
   - 内部 effect：读持仓 → 按需拉行情 → 生成推荐；埋点 view/enable/dismiss。
3. 修改 `src/pages/NotifyPresetCard.jsx`
   - `NotifyPresetSection` 内渲染推荐区块（置于提醒预设卡片上方），透传 hook 返回的 `notifyPresets/handleTogglePreset/handlePresetThreshold/isApplyingPreset`。
4. 测试 `test/notifyRecommendations.test.mjs`
   - 覆盖：无持仓不推荐、已开启预设不推荐、溢价≥5% 触发、溢价<5% 不触发、被关闭的不再出现、行情失败降级。

## 风险
- 通知 Tab 新增一次行情请求：仅持仓标的、一次批量、有缓存去重，可接受。
- 推荐阈值调整与预设阈值共用同一 state：在推荐卡上调阈值会同步到预设卡片，行为一致，符合预期。

## 进度
- [x] 计划文档
- [x] 可交互 demo（HTML widget）确认文案与布局（用户已确认）
- [x] 生产代码实现
- [x] 测试 + lint + refactor guard（推荐逻辑 11 项测试全过，既有 notifyPresets 10 项全过）
- [x] 推送 + 部署 + 线上验证
  - 远端提交 d16c74b9，Deploy CN Frontend run 36403994829 成功
  - 线上 NotifyExperience chunk 验证含「为你推荐」与推荐关闭存储 key
