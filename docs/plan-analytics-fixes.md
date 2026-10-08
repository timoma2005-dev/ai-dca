# 修复计划：analytics 三问题（2026-09-25）

用户指令：修复第 1、2、4 项，跳过第 3 项（Server酱 key 失效提醒）。

## 问题 1：每日 rollup 停更（analytics_daily_stats / users 停在 2026-07-20）

**根因**：聚合代码只存在于 commit e49ee62a（2026-07-13），该提交只在 agent/backup 分支上，
从未合入 main/cn。生产 sync worker 由 main 部署，不含聚合逻辑 → 7-20 之后无更新。

**修复**：
- workers/sync/src/index.js（main）：从 e49ee62a 移植 `analyticsEventIdentity` +
  `updateDailyAnalyticsAggregate` + ensureSchema 建表；handleTrackAnalytics 只对新插入行做增量聚合，
  保持现有 400 响应契约不变。
- 不移植 backfillDailyAnalytics（admin 触发的全量回填副作用大）；缺口用一次性脚本回填。
- 回填缺口 2026-07-21 → 2026-09-24（replace 语义，日期已完整无竞态）；
  2026-09-25 用 additive（部署后增量已在跑，ms 级窗口误差可忽略）。
- analytics_daily_users 回填天然幂等（flags 是 MAX 重算）。

**风险**：push main 即触发 sync worker 生产部署。增量聚合每 batch 最多 50 事件，
D1 batch 语句数有限，无性能风险。

## 问题 2：session_start 缺 referrer/utm

**现状**：前端 trackAnalyticsEvent 已在顶层带 `referrer`，但 worker 建表/insert 根本不存该字段，
直接丢弃；utm 参数只散落在 path 的 query string 里。

**修复**（src/app/analytics.js，main + cherry-pick cn）：
- 新增 `getAttributionContext()`：取 `document.referrer` + `utm_source/medium/campaign/term/content`，
  并入 meta.context（session_start 经 trackAnalyticsEvent 自动带上）。
- 不改 worker schema：meta JSON 已存，D1 可用 `json_extract(meta,'$.context.referrer')` 查询。
- key 命名避开 SENSITIVE_META_KEYS（如 content→utm_content），depth ≤ 3 可通过 normalizeMetaValue。

## 问题 4：markets 场景匿名新访客引导

**现状**：conversion prompt 系统工作正常且有归因（conversion_register_success）。
markets_symbol_select（minCount 2）14 天 38 views / 1 click / 15 dismiss；
纯浏览用户没有任何承接。

**修复**（前端，main + cherry-pick cn）：
- PROMPT_CONFIGS 新增 `markets_new_visitor_guide`（minCount 1）：文案强调使用价值
  （自选同步、异动推送）。
- marketsConversionPrompts.js 新增 `promptMarketsNewVisitorGuide()`。
- 新建 src/pages/markets/useMarketsNewVisitorGuide.js（hook，保持 MarketsExperience 轻量，
  过 refactor guard）：匿名访客在 markets tab 停留 60s 后触发一次；
  仅当从未见过任何 conversion prompt（新访客定向）。
- 沿用现有冷却/频控（每日一次、dismiss 后 7 天冷却、全局 10 分钟冷却）。

## 分支策略（用户要求完全隔离）

- main 上实现全部三个修复 → 测试 → commit → push（触发 sync worker + 全球前端部署）。
- cherry-pick 同批 commit 到 cn → push（触发 notify worker + 国内前端部署）。
- 不做 cn→main merge，不覆盖。

## 验证

- workers/sync/test/analytics.test.mjs：补充增量聚合单测（node:test）。
- 前端 analytics.js：检查现有单测覆盖 attribution。
- 部署后：查 D1 确认 analytics_daily_stats 当天有行、回填脚本核对缺口日期行数。
- 观察 conversion_prompt_view（trigger=markets_new_visitor_guide）事件量。

## 进度

- [x] 根因定位（三项）
- [x] fix1 代码 + 单测（workers/sync 8/8，conversion 6/6，privacy 相关 12/12）
- [x] fix2 代码（src/app/analytics.js，getAttributionContext 并入 meta.context）
- [x] fix4 代码（markets_new_visitor_guide + useMarketsNewVisitorGuide hook，MarketsExperience 保持轻量）
- [x] push main（commit 8022990b，经 Git Data API 推送）：Deploy sync worker、Deploy Global Frontend 均 success
- [x] cherry-pick → push cn（commit 9bb7285a，隔离分支 fix/analytics-rollup-referrer-nudge-cn）：Deploy sync worker、Deploy CN Frontend 均 success
  - 注意：deploy-worker-sync.yml 监听 main+cn 双分支，cn 推送也会部署 sync worker；两个分支聚合代码已一致。cn 入口是 optimizedEntry.js，track 走 legacy index.js，聚合同样生效。
- [x] 回填缺口 2026-07-21→2026-09-24（66 天，replace 语义）+ 9-25 当天（additive）；脚本 ~/workspace/tools/backfill_daily_analytics.py
  - 抽查 9-21：rollup pv 710 = 原始 pv 710；9-21→9-24 用户数 119/75/63/70 与前期 DAU 分析一致
- [x] 生产实测增量聚合：9-25 当天 switch_runs 60→66 在 2 分钟内累加，pv 与原始事件一致

后续观察：
- conversion_prompt_view（trigger=markets_new_visitor_guide）的 view/click/dismiss 及 conversion_register_success 归因
- session_start 的 meta.context.referrer / utm_* 在 D1 可用 json_extract 查询流量来源
