# 修复：溢价推荐阈值静态导致开启即触发

## 现象

通知 Tab「为你推荐」中，溢价推荐行显示"当前溢价 11.6%，超过 8% 时提醒你"。
8% 是 `premium` 预设的静态默认值（`notifyRecommendations.js` 的 `thresholdOf('premium')`）。
用户直接点开关开启 → `handleTogglePreset('premium', true)` 用存储的 8% 建规则 →
当前溢价 11.6% > 8% → 下一次检查立即触发提醒。阈值没有基于当前溢价动态设置。

## 修复

1. **`src/pages/notify/notifyRecommendations.js`**：溢价推荐的 `threshold` 改为动态建议值：
   `max(预设已存阈值或默认 8%, ceil(当前溢价))`。
   - 159632（溢价 11.6%）→ 建议 12%
   - 161130（溢价 7.7%）→ 建议 8%（不触发，因为 7.7 < 8）
   - 用户之前存过自定义阈值（如 15%）→ 取 max(15, ceil(溢价))，尊重用户设置
2. **`src/pages/notify/NotifyRecommendationCard.jsx`** 的 `handleEnable`：
   开启时把该行显示的建议阈值带过去（`onTogglePreset(rec.presetId, true, rec.threshold)`），
   避免"只点开关不动步进器"时仍用旧阈值。
3. **`src/pages/notify/useNotifyPresets.js`** 的 `handleTogglePreset(presetId, nextEnabled)`：
   增加可选第三参数 `thresholdOverride`，透传给已支持它的 `applyAlertPreset`。
   `NotifyPresetCard` 的两参数调用保持兼容。
4. 步进器保持可调（调的是共享预设阈值，现有行为不变）；`threshold == null` 的推荐（daily/dca）不传 override。

## 验收标准

- 溢价 11.6% 的推荐行显示"超过 12% 时提醒"；溢价 7.7% 的显示"超过 8% 时提醒"。
- 点开关开启后，实际创建的 market-alert 阈值等于行内显示的建议值；开启后不会因当前溢价已超阈值而立即触发。
- 已存自定义阈值 15% 时，建议值不低于 15%。
- 步进器 ±1 可调、下限 1 的行为不变。
- `test/notifyRecommendations.test.mjs` 补充用例：
  - 溢价高于默认值 → 建议值为 ceil(溢价)
  - 溢价低于默认值 → 建议值为默认值
  - 已存自定义阈值 → 取 max(自定义, ceil(溢价))
- `npm run check:refactor`、`npx eslint <改动文件> --quiet`、`git diff --check` 通过；
  `node --test test/notifyRecommendations.test.mjs` 通过。

## 不做的

- 不改 gain/loss 推荐（无实时盈亏数据，不在本 scope）。
- 不改阈值触发语义（超过即提醒）与 worker。
- 不改步进器共享预设阈值的现有行为。
