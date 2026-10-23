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

## 执行约束

- 只动：src/app/postAuthSync.js、test/cloudSyncContract.test.mjs（新）、services/auth/src/、
  services/auth/test/、src/app/rbac/rbacAdminApi.js、src/pages/rbac/、相关前端 test/、本计划文件。
- 不动：services/cn-data、deploy/ nginx、workers/。
- 每项一个提交，显式路径 git add，不 push（发布由协调方执行）。
- 已知基线（勿修、勿新增）：前端全量测试 32 个既有失败 + 3 个文件加载失败
  （accountResourceSync/resourceSync/syncRegistry，均为 10-04 重构遗留）。

## 进度

- [x] 任务 1 实现 + 测试
- [ ] 任务 2 实现 + 测试
- [ ] 任务 3 定位结论与修复
- [ ] build 通过，相关测试通过

## 验证记录

- 任务 1：契约测试在修复前两条均失败，准确指出已删除 API；修复后契约、authClient、
  accountMigrationGate、cloudSyncConflict、cloudSyncMerge 共 32 个测试通过。
- 原始 HEAD 6a5b6c58 的 refactor guard 已失败：NotifyExperience.jsx 为 938 行，
  超过 880 行限制；当前全仓 lint 有 12 个错误，后续与原始 HEAD 对比。
  保持本计划限定范围，不修无关基线。
