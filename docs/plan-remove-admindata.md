# 移除 adminData 数据看板（前端 Tab + 组件 + 后端接口）

## 背景

用户要求移除「数据」看板 Tab 及其后端接口。埋点采集管线（trackFeatureEvent/trackAnalyticsEvent、
`/api/sync/analytics/track`、analytics_events 表）保留。

## 删除范围

### 前端

1. 删除文件 `src/pages/AdminAnalyticsExperience.jsx`（整个数据看板组件）。
2. `src/app/screens.js`：
   - `ADMIN_TAB_ORDER` 去掉 `'adminData'`
   - 删除 `adminData: { label: '数据', hrefKey: 'adminData', adminOnly: true }` 的 screen 定义
   - 删除 `adminData` 的 href 映射
3. `src/pages/WorkspacePage.jsx`：
   - 删除 `adminData: '数据看板'` 的 label 映射（约 L75）
   - 删除 `adminData: BarChart3` 的 icon 映射（约 L89），若 BarChart3 无其他使用则一并去掉 import
   - 删除 `case 'adminData':` 分支（约 L613-614）
4. `src/app/scenarios.js`：`visibleTabs` 去掉 `'adminData'`。
5. `src/app/analytics.js`：删除仅被 AdminAnalyticsExperience 使用的三个函数
   `fetchRemoteAnalyticsSummary`、`buildAnalyticsSummary`、`clearAnalyticsEvents`。
   保留 `isAnalyticsAdmin`（AdminQuant/AdminRadar/WorkspacePage 在用）、
   `trackAnalyticsEvent`、`trackFeatureEvent` 及其他所有埋点采集逻辑。
   若删除后有 import 变成未使用（如 fetchWithFallback、apiUrlDirect 等），一并清理，
   但必须确认该 import 确实无其他使用者。

### 后端

1. `services/cn-data/src/sync/routes.js`：
   - 删除路由表中的 `'/api/sync/admin/analytics': { GET: handleAdminAnalytics }`
   - 删除 `handleAdminAnalytics` 函数及其仅被它使用的辅助函数/常量。
   - 保留 `'/api/sync/analytics/track'` 和 `handleTrackAnalytics`（埋点上报仍在用）。
2. `workers/sync/src/index.js`：
   - 删除 `if (request.method === 'GET' && url.pathname === '/api/sync/admin/analytics')` 路由行
   - 删除 `handleAdminAnalytics` 函数及其仅被它使用的辅助函数。
   - 保留 track 相关。
3. `workers/sync/src/optimizedEntry.js`：该文件是 sync worker 的入口（wrangler.toml main），
   内容全部是 `/api/sync/admin/analytics` 与 `/api/sync/admin/analytics/diagnostics`
   的并行加载优化。删除整个文件，并把 `workers/sync/wrangler.toml` 的 `main` 改回 `src/index.js`。
   删除前确认该文件没有其他路由逻辑（经查只有 analytics 相关）。

## 不做的

- 不删除埋点采集：`trackFeatureEvent`/`trackAnalyticsEvent` 的 25 处调用、
  `/api/sync/analytics/track`、PostHog 同步、localStorage 事件存储全部保留。
- 不删除 `isAnalyticsAdmin`（其他 admin Tab 在用）。
- 不删除 analytics_events 等 DB 表（track 仍在写入）。
- 不删除 adminQuant / adminRadar Tab。

## 验收标准

- `grep -ri "admindata" src/ services/cn-data/src/ workers/sync/src/` 无结果
  （允许 docs/ 下的计划文档残留）。
- `grep -rn "fetchRemoteAnalyticsSummary\|buildAnalyticsSummary\|clearAnalyticsEvents" src/ services/ workers/` 无结果。
- `grep -rn "admin/analytics" services/cn-data/src/ workers/sync/src/` 无结果。
- 前端 `npm run check:refactor` 通过；改动文件 `npx eslint --quiet` 通过；`git diff --check` 通过。
- 前端能正常构建（`npm run build:app` 可选，若时间允许）。
- 后端：`node --check` 语法检查改动的 routes.js / index.js；若有 worker 相关测试则运行。
