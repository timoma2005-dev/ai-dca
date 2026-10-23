# 2026-10-23 三项修复计划

背景：RBAC（6a5b6c58，release 20261023160548）上线验收后，用户提出三项后续工作。

## 任务 1：登录后同步悬空调用（根因已确认）

- 现象：有云端备份的用户在新设备/新浏览器登录后，账户面板出现原始报错
  `e.prepareCloudSyncConflict is not a function`，预定的云端拉取被中断。
- 根因：5b4fbb61（2026-10-04 同步重构）删除了 cloudSync.js 的
  `prepareCloudSyncConflict`（理由：服务端是唯一真相源，不再需要客户端冲突检测），
  但 postAuthSync.js `runInitialAccountSync` 第 85 行仍在调用它，全仓库仅剩这一处调用、无定义。
- 决策（用户 2026-10-23 拍板）：最小修法。删除冲突预检分支，云端有备份时直接
  `restoreEncryptedCloudBackup()`；同步更新函数头注释；保留 coordinatePostAuthSync 中
  isCloudSyncConflict 的 catch 分支（无害防御，不动）。
- 防回归：新增 test/cloudSyncContract.test.mjs，静态断言 postAuthSync.js 中所有
  `cloudSync.<name>(` 调用在 cloudSync.js 中都有真实 export，且 src/ 内不再出现
  prepareCloudSyncConflict。

## 任务 2：权限管理列出全部注册用户与游客 + 最后活跃时间

- 现状：rbacAdmin.searchUsers 空查询只返回「有 user_roles 行」的用户（EXISTS 子查询），
  权限管理页默认看不到全部注册用户；无最后活跃信息；游客不在 auth 库内。
- 数据源（已核实）：
  - 注册用户最后活跃 = max(sessions.created_at 最近会话, cn-data 分析库
    analytics_daily_users 中 identity=users.id 的 MAX(event_date))。
  - 游客 = cn-data 分析库（/var/lib/ai-dca-cn-data/cn-data.db）analytics_daily_users
    中 is_visitor_only=1 的 identity（即 visitorId），聚合 MIN/MAX(event_date) 与活跃天数。
    identity 未哈希（analyticsEventIdentity 返回原始 userId/visitorId）。
  - auth 服务以只读方式打开 cn-data 库（路径 env AI_DCA_CN_DATA_DB 可覆盖，
    默认 /var/lib/ai-dca-cn-data/cn-data.db）；文件缺失时优雅降级（available:false），
    不影响用户列表主功能。
- 后端：searchUsers 去掉 EXISTS 限制，空查询返回全部用户（limit 上限提到 500；
  空查询按 lastActiveAt 倒序、空值最后，再按用户名）；每行加 lastActiveAt。
  新增 GET /api/sync/auth/admin/guests（同 api:rbac-admin 门禁）返回游客聚合。
- 前端：RbacUsersPanel 挂载即加载全量列表，每行显示「最后活跃」（无记录显示「从未」）；
  新增 RbacGuestsPanel 挂到 AdminRbacExperience（用户面板下方），列访客标识（截断+title 全量）、
  首次访问、最近活跃、活跃天数；数据不可用时显示弱提示。
- 测试：services/auth/test/rbac.test.mjs 扩展或新增文件，用临时 auth 库 + 临时 cn-data 库播种断言。

## 任务 3：右上角头像点击无反应（管理员账号，待复现定位）

- 已验证事实（2026-10-23 真实浏览器，当前生产版本）：访客与普通用户（musetest1021c）
  点击顶栏「账户」按钮均可正常打开面板；站长 lovexl（superadmin，长效会话）反馈点击无反应。
- 打开链路：BrandPreviewBar 按钮 dispatch window 事件 ai-dca:account-auth-open →
  WorkspacePage 监听 setAccountMenuOpen(true) → 受控 AccountMenu（hideTrigger，lazy 加载）打开。
- 嫌疑顺序：① AccountMenu 打开时渲染高角色数据（RoleList 遍历 /me 返回的完整继承角色链、
  RoleBadge）抛错；② lazy chunk 加载失败且全仓无 ErrorBoundary，叠加 asset-cache
  service worker（public/asset-cache-sw.js，cache-first /react-assets*/）；③ RBAC 前老会话的 rbacStore 状态。
- 要求：用 jsdom 渲染测试以 superadmin 形态的 rbac 数据复现点击流；定位根因并修复；
  若代码层无法复现，必须在本文件写明结论，并落地 chunk 加载韧性（lazy 失败重试一次 +
  一次性整页重载，sessionStorage 防循环）作为缓解。补回归测试。
- 定位结论（2026-10-23）：**代码层未复现，疑似客户端 chunk/缓存**。沿用并完善
  `test/helpers/accountMenuClickHarness.mjs`，以真实 BrandPreviewBar / AccountMenu 组件和
  WorkspacePage 源码中的事件监听执行 jsdom 点击流。RBAC 数据为
  superadmin → admin → svip → vip → user → guest 完整继承链，加 auction_viewer，
  topRole=superadmin；分别验证完整 RBAC 缓存和无 RBAC 缓存的旧长效会话。
  两种情况下均完成按钮点击 → `ai-dca:account-auth-open` → `setAccountMenuOpen(true)` →
  受控 AccountMenu（hideTrigger）面板渲染，7 个角色及超级管理员盾牌显示正常，
  关闭/重开正常；RoleList、RoleBadge、useRbac 路径未捕获 React 渲染异常。
  jsdom 结果不能确认生产客户端的 chunk / service worker 缓存状态，故不将该嫌疑当作已证实根因。
- 韧性修复：检索现有 lazy 用法后未找到同类 helper。新增仅用于 AccountMenu 的
  `src/app/loadAccountMenu.js`，接入 WorkspacePage 的 lazy 导入；导入失败重试一次，
  再失败则先写 sessionStorage `aiDcaAccountMenuReload_v1` 再整页 reload。
  标记在同一标签页 session 内保留（成功导入也不清除），避免循环重载；存储不可用时不自动重载。
  reload 和存储访问均可注入，最终保留导入错误。
- 回归：新增 `test/accountMenuClick.test.mjs` 与 `test/loadAccountMenu.test.mjs`；
  点击脚手架纳入版本管理，清理 React act 的 MessageChannel 端口，避免测试进程挂起。
  添加 jsdom 26.1 为开发依赖，使点击测试可直接由 `node --test` 执行。

## 执行约束

- 只动：src/app/postAuthSync.js、test/cloudSyncContract.test.mjs（新）、services/auth/src/、
  services/auth/test/、src/app/rbac/rbacAdminApi.js、src/pages/rbac/、
  src/pages/AdminRbacExperience.jsx（实际所在路径）、相关前端 test/、本计划文件。
- 不动：services/cn-data、deploy/ nginx、workers/。
- 任务 3 按本轮明确授权补充范围：`src/pages/WorkspacePage.jsx`、
  `src/app/loadAccountMenu.js`、上述相关前端测试/脚手架，以及测试所需的
  `package.json` / `package-lock.json` 开发依赖；任务 1、2 的代码不再修改。
- 每项一个提交，显式路径 git add，不 push（发布由协调方执行）。
- 已知基线（勿修、勿新增）：前端全量测试 32 个既有失败 + 3 个文件加载失败
  （accountResourceSync/resourceSync/syncRegistry，均为 10-04 重构遗留）。

## 进度

- [x] 任务 1 实现 + 测试
- [x] 任务 2 实现 + 测试
- [x] 任务 3 定位结论与修复
- [x] 任务 3 新增回归 10 项通过，Vite 构建通过
- [ ] build 通过，相关测试通过（现有 guard / 测试基线阻断，详见下方）

## 验证记录

- 任务 1：契约测试在修复前两条均失败，准确指出已删除 API；修复后契约、authClient、
  accountMigrationGate、cloudSyncConflict、cloudSyncMerge 共 32 个测试通过。
- 任务 2：auth 全套 92 个测试通过；前端 RBAC 相关 22 个测试通过。覆盖全部用户、
  会话/分析日期取较晚值、排序后限量、游客聚合、500 上限、只读与缺失/损坏/缺表降级、
  guests 路由门禁。仓库无原 rbacAdminPage.test.mjs，新建同名源码契约测试，覆盖挂载加载、
  当前查询刷新、最后活跃与游客各状态。
- 原始 HEAD 6a5b6c58 的 refactor guard 已失败：NotifyExperience.jsx 为 938 行，
  超过 880 行限制；原始 HEAD 与当前全仓 lint 均为相同的 12 个错误，修改文件定向 lint 通过。
  保持本计划限定范围，不修无关基线。
- 任务 3：`node --test test/accountMenuClick.test.mjs test/loadAccountMenu.test.mjs`
  新增 10 项全部通过；覆盖完整高角色渲染、旧会话、导入首次成功/失败后重试成功、
  连续失败只 reload 一次（重新导入 helper 模拟整页重载后仍受 session 标记保护）、
  成功导入不清除标记、存储缺失/访问/读写异常及 reload 异常。
- 任务 3 相关测试：运行 rbacUiRender、rbacStore、rbacMenuModel、accountMenuPreviewKeyCount、
  accountMenuClick、loadAccountMenu、workspaceMobileBottomNavMount 共 37 项，36 通过、1 个既有失败。
  失败为 `accountMenuPreviewKeyCount.test.mjs:28` 的旧源码正则仍匹配 `!open`，
  而组件现已使用 `!effectiveOpen`；在本次源码修改前已复核同样失败，保留基线、不修改该测试或组件。
- 任务 3 构建/检查：`npm run build` 已执行，因原有 NotifyExperience.jsx 938 > 880 行
  的 refactor guard 失败而未进入 Vite；另行运行 `npm run build:app`，Vite 构建成功。
  `npm run check:refactor` 保持同一既有失败；`npm run lint -- --quiet` 保持原有 12 个错误；
  `npx --no-install eslint src/app/loadAccountMenu.js src/pages/WorkspacePage.jsx --quiet`
  与 `git diff --check` 通过。未运行或修复前端全量测试基线。

## 任务 4：CF 侧游客聚合（2026-10-23 晚 dudu 拍板）

- 背景：任务 2 的游客面板读 CN cn-data 分析库，但生产分析事件全走 CF sync worker 进 D1，
  CN 三表恒空（探针实测：公网 track 被 CF 接走，直连 8081 才落 CN 库）。
- 方案：workers/sync 新增 GET /api/sync/analytics/guests，聚合 D1 analytics_daily_users
  中 is_visitor_only=1 的 identity（与 CN 侧相同 SQL），返回形状与 CN /admin/guests 一致。
  鉴权沿用 worker 现有模式：Bearer token → D1 sessions 查 user → users 查 username →
  isAdminUsername（ADMIN_USERNAMES 硬编码名单，RBAC 化不在本任务范围）。
- 前端：rbacAdminApi.listGuests 改调该 CF 接口（apiUrl('/api/sync/analytics/guests')），
  游客面板组件不变；CN /admin/guests 后端保留（前端不再调用）。
- 部署：wrangler deploy（一次性 CF token 走环境变量，用完丢弃）；前端照常 release。
- 验证：worker 测试覆盖 admin/非 admin/无 token 三种情况；上线后无 token 401、
  非管理员 403，并用同一 token 对 D1 跑相同 SQL 核对聚合数值。

- [x] 任务 4 源码实现与本地验证完成：CF guests 端点复用 `requireUser`（Bearer SHA-256、
  未过期 sessions 联查 users）和 `isAdminUsername`，沿用 `json`/CORS；limit 默认 200、
  范围 1–500，非法值回退默认。前端 `listGuests` 独立请求 CF，保留 CN `/admin/guests`。
- 测试：`node --test workers/sync/test/*.test.mjs` 全部 56 项通过（当前 Node 24 不支持
  直接传测试目录，显式 glob 覆盖该目录全部三个测试文件）；游客用例覆盖聚合字段、排序、
  活跃天数、排除用户、401/403、过期/无主会话、limit 和 CORS。
  `node --test test/rbacAdminPage.test.mjs` 4/4 通过，`npm run build:app` 通过；
  另行运行客户端检查，验证 CF URL、Bearer token、返回形状及 HTTP 错误的 status/message。
- 检查：前端修改文件的 ESLint 与 `git diff --check` 通过；`npm run check:refactor`
  仍因原有 NotifyExperience.jsx 938 > 880 行失败，`npm run lint -- --quiet`
  仍报原有 12 个错误，涉及文件均未修改。本任务只提交一次，不 push、不部署；线上验证待发布后执行。

## 任务 5：权限管理用户列表重设计（2026-10-23 晚 dudu 拍板，设计稿已确认）

- 问题：每个用户一张大卡片且人人摊着授予表单，一屏不到 3 人；游客面板被压在列表底部够不着。
- 设计（dudu 已确认可交互设计稿）：紧凑表格一行一人（用户名+ID、角色标签、注册、最后活跃、操作）；
  授予表单收进行内展开编辑器（点「授予角色」才展开，确认/取消收起）；撤销仍走标签 ×（带 confirm）；
  顶部搜索 + 角色筛选 chips；分页每页 8 条；注册用户/游客用分段切换同屏切换，游客同样表格+搜索+分页。
- 数据与权限行为不变：用户列表仍走 rbacAdminApi.searchUsers（服务端搜索 + 空查询全量按最后活跃倒序），
  角色筛选与分页在客户端对返回集处理；授予的可选角色、NON_GRANTABLE、canGrantAdmin 门禁、
  授予/撤销后刷新与 toast 全部沿用现有逻辑；游客数据仍走 CF 接口 listGuests（前 200 条客户端分页）。
- 分段计数用已加载条数（达到上限时显示 N+），页脚文案如实描述（如「按最近活跃排序，取前 200」仅在满 200 时出现）。
