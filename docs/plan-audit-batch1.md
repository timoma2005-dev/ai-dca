# 前端审计 batch1 修复计划（CN 站）

范围：审计第一批 #1 #2 #3 #4 #6 #7 #8 #14。只改前端源码，不加后端接口鉴权。超限文件（Holdings/Notify/NewPlan）不动，新逻辑放新文件。

## #1 退出后仍渲染缓存用户名
- 根因：`/api/sync/auth/menus` 由 auth 服务按 httpOnly cookie 识别用户；退出后 cookie 若未清掉，游客刷新菜单仍拿到上一个账号的 `username` 与会员菜单，被写进 `aiDcaRbacMenus_v1` 的 guest 缓存。
- 修法（`src/app/rbac/rbacStore.js`）：游客 / token 失效后的 `/menus` 请求改为 `credentials: 'omit'`；`normalizeRbacPayload` 在未登录时清空 `username`；本地是游客但载荷声称已登录时直接丢弃；读取时丢弃带用户名的 guest 旧缓存。打赏二维码弹窗的「备注账号」改读 `accountUsername`（需要 accessToken）。
- 测试：`test/rbacGuestIdentity.test.mjs`。

## #2 未登录 ?tab=markets 渲染完整行情
- 根因：同 #1，污染的 guest 菜单把 markets 标为可用，路由守卫（WorkspacePage.renderActivePanel）判定通过后挂载了 MarketsExperience 并请求行情。守卫本身对所有受 RBAC 管理的 tab 统一生效。
- 修法：从数据源头保证游客只拿到游客菜单（见 #1），守卫在 `status !== 'ok'` 且非演示时不挂载任何受限页组件。
- 测试：`test/rbacGuestIdentity.test.mjs`（污染缓存 / 残留 cookie 载荷下 markets 仍为 `login`）。

## #3 情绪条与研报口径矛盾 / #8 QQQ、VOO 在「暂无」与数值间跳
- 根因：`useMarketSentimentWeather` 在没拿到行情时用写死的兜底（14 只 ETF 全为正涨幅、F&G 29、VIX 14.81）算出 +23.4°C、14晴0雨，冒充实时数据；每个使用方各自轮询一份；一次拉取里某个标的缺字段就整条覆盖，QQQ/VOO 退回「暂无」。
- 修法：新增 `src/pages/markets/marketSentimentSnapshot.js`：模块级单例快照（情绪条、研报、页面背景共用一份），逐标的只在有效数值时覆盖并记录时间；无数据显示 `—` / 加载中 `…`，过期标「延迟」；研报标注数据时间并声明与情绪条同一快照，未就绪时不生成。
- 测试：`test/marketSentimentSnapshot.test.mjs`。

## #4 行情冻结仍显示「实时行情连接正常」
- 根因：`marketsApi.getJson` 无超时，请求挂起后 `fetchQuotes` 的 inflight 表与 `useMarketsWatchRefresh` 的 inflightKey 去重会一直命中同一个挂起请求，手动刷新也被吞掉；连接状态只看「有行或有时间戳」。
- 修法：GET 默认 25s 超时；`refreshWatch({ force: true })` 跳过去重（刷新按钮、延迟自动重连都用它）；新增 `src/pages/markets/marketFeedHealth.js`，按最后成功更新时间（接口成功或 WS 推送）判断：交易时段超过 2 分钟（或服务端数据时间超过 5 分钟）显示「数据延迟」并每 30s 强制重拉；非交易时段（含午休）显示「休市中」。
- 测试：`test/marketFeedHealth.test.mjs`、`test/marketsWatchRefreshForce.test.mjs`。

## #6 行情「还可体验 2 次」与竞价看板「3 次」
- 根因：`featureDemo` 的次数按功能（tab）分别计数（每功能每天 3 次），文案未说明。
- 修法：保留按功能计数，文案统一为「本功能今日还可体验 N 次（每个功能每天 3 次）」（`src/app/demo/demoQuotaText.js`）。
- 测试：`test/demoQuotaText.test.mjs`。

## #7 换基方案名称留空可保存、产生重复卡片
- 修法：名称必填（trim 后为空阻止保存），新建时自动填充「159632→513100 切换方案 10-26 15:30」，同名方案提示并阻止；保存按钮防重复提交（`src/pages/switch/switchRuleName.js`）。
- 测试：`test/switchRuleName.test.mjs`。

## #14 删除确认与「登录数据同步」弹窗叠加
- 根因：删除本身不触发同步；是启动 30s 后的 `ensureCloudSyncReady` 在有待确认差异时后台补跑并派发差异事件，同步弹窗随时冒出，与全局确认弹窗各自独立，取消确认后同步弹窗残留。
- 修法：启动补跑的差异事件标 `silent`，同步弹窗只在登录流程 / 用户从账户菜单主动打开时自动弹出，静默时只提示 toast；新增 `src/app/modalArbiter.js`，全局确认弹窗打开期间同步弹窗延后，不叠加。
- 测试：`test/modalArbiter.test.mjs`、`test/loginSyncDiff.test.mjs` 新增用例。

## 验证
- 相关 `node --test` 与基线对比；改动文件 `eslint --quiet`、`git diff --check`、`npm run build:app`。
- 发布：push 后 `bash scripts/cn-frontend/release.sh`，记录 release 与回滚号。
