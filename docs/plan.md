# 份额申赎详情计划

1. 基线：128 tests / 127 pass / 1 skip / 0 fail，完成。
2. 深市提取最近 P 日、兼容标签变体；沪市解析可选前日字段；补缓存形态校验并兼容旧对象，完成。
3. 单只手风琴详情按快照日期懒加载 GET，内存缓存、inflight 去重、收起取消与手动重试，完成。
4. 解析、缓存防御、请求与浏览器交互测试，完成；在指定分支本地提交。

决策：深市基金份额净值保留原始精度（1.5499）；现金及单位净值沿用两位金额解析。缺失字段不推算；上限 null 按要求展示“无”或“不设上限”，旧对象字段缺失展示 —。

验证：PCF 138 tests / 137 pass / 1 skip / 0 fail；另有浏览器交互测试 1 pass，覆盖键盘、手风琴、取消、重试、空缓存及手机/桌面宽度。check:refactor、修改前端文件 lint、git diff --check 通过。
全仓 npm run lint -- --quiet 已执行，有 12 个既有错误，涉及 networkTrace、account-data-migration-modal、CnHomeExperience、DataRepairExperience、NewPlanSelectionCards、NotifyEventDetailDialog，均未修改。
