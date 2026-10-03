# 登录与持仓新增修复调查及计划

## 范围与结论

调查基线：`/tmp/ai-dca-auth-fix`，分支 `fix/auth-holdings`，HEAD `ed5416a3`（基于用户指定 cn 基线）。行号均指该版本；本次只编写此文档，不修改实现，不提交、不 push、不部署、不执行生产登录或写入交易。

生产部署日期及现象按用户提供的 2026-10-04 背景记录。已有 `docs/plan-auth-local-sqlite.md` 声明"用户和 session 都同步"，实际实现遗漏 session。已确认的缺陷是：认证错误不在未登录对话框内展示、登录请求无超时、UI 仍等待云同步、CN session 未同步到 D1、持仓远端 hydrate 无条件覆盖运行时且缺少时序保护。**尚不能将这些缺陷全部等同于两次生产现象的已复现根因**，特别是"8 秒后用户名不出现"和"新交易消失"的准确触发点，需要生产 Network/日志证据。

尝试只读访问生产首页，网页工具返回不可访问；未取得生产浏览器 HAR、nginx 配置、SQLite 或 D1 数据。下列验收为后续必须执行的计划，不是已通过的结果。

## Bug 1：手动登录无效果、无错误

### 前端证据链

1. `home.html:79` 加载 `/src/entry-screen.jsx`；实际认证 UI 是 `src/components/account-menu.jsx`，通过 `src/components/brand-preview-bar.jsx:9,79-80` 懒加载。不是 home.html 内联实现登录。
2. `account-menu.jsx:756-764` 登录按钮调用 `handleAuth(authMode)`；`handleAuth` 在 `212-217` 分别调用 `registerCloudAccount(form)` / `loginCloudAccount(form)`。`474-480` 根据 busy、用户名、密码禁用按钮。
3. `src/app/authClient.js:203-208` 手动登录 POST `/api/sync/auth/login`，JSON 为 `{ username, passwordHash }`。用户名 trim + lowercase，`passwordHash = SHA256(规范化用户名 + ":" + 原始密码)`（`118-120`），不是发送明文密码。正常 CN 构建相对路径，实际地址需核对 `__AI_DCA_SYNC_BASE__`、`VITE_API_ORIGIN`（`authClient.js:32-36`，`src/app/apiBase.js:1-14`）；`.github/workflows/deploy-cn-frontend.yml:92` 设置空 API origin。
4. `requestSync`（`authClient.js:128-145`）await fetch、读取响应文本，检查 `response.ok`，所有非 2xx 都抛 Error，优先使用 message/error；网络异常也会向上抛出。**不存在只识别 200 而吞掉 4xx/5xx 的代码**。但 fetch 没有 AbortController/超时，200 HTML 或不完整 JSON 也缺少 session 结构验证。
5. 成功后 `authClient.js:209` 调用 `saveCloudSession`。`src/app/authSession.js:35-53` 保存 `aiDcaCloudSyncSession`（userId、username、accessToken、refreshToken、isAdmin、savedAt），切换账号清空 runtime/同步元数据，派发 `cloud-sync:session-changed`。没有设置 cookie；后续账号请求使用 Bearer token（`src/app/accountApi.js:34-41`）。`rememberDevice` 未传入认证接口，当前 session 始终写 localStorage。
6. `account-menu.jsx:97-126` 监听 session 事件更新 React session；`218` 再次 setSession；`481,607-615` 依据 accessToken 显示用户名。随后 `222` 仍 await `runInitialSync`，后者 `179-209` 查询迁移/manifest、恢复或上传；只有结束才 toast/关闭（`226-231`）。云端阻塞可让流程保持 busy，但**按现有代码，已保存有效 session 后用户名本应先出现**；不能仅用此等待解释生产用户名缺失。
7. `handleAuth` catch（`232-255`）设置 lastError 并 showToast，finally 清 busy。`renderSyncError` 定义于 `461-471`，使用位置 `559,684`；未登录 portal（`694-771`）没有渲染该错误区域。因此 401/500 的长期错误提示缺失，用户只能依赖短暂 toast（是否被对话框遮挡待确认）。请求一直 pending 时 catch 根本不会执行，也没有超时提示。

### 注册自动登录与手动登录差异

`authClient.js:174-200` 注册 POST `/auth/register`，增加用户名至少 3 位、密码至少 8 位校验，返回值已含 session，直接保存并登录，**不额外调用 login**。登录 `203-220` 走 `/auth/login`，校验已有凭据。两者都会保存 session、尝试动态加载并启动 cloudSync、后台 scheduleMigrationAfterAuth；注册多 conversion/register analytics。UI 共用 handleAuth，但 runInitialSync 在"注册"时强制进入无远端数据的上传分支（`account-menu.jsx:202-207`）。

`ed5416a3` 只改了 `authClient.js` 的同步启动和部署脚本，没有移除 UI 的首次同步等待；"立即启动"也不代表立即可读云持仓：`src/app/cloudSync.js:196-213` 仍先后台检查迁移，成功才安装同步器。

### 本地服务与鉴权缺口

- `services/auth/src/server.js:89-101` 接收 login，并把 body.passwordHash 映射为 clientPasswordHash；`50-56` 成功 200，失败 `{message}`。`auth.js:127-150` 查 SQLite users，比较 SHA256(salt:clientHash)，不存在或不匹配返回 401；参数非法 400（`65-69`），事务异常经 server 返回 500。nginx/上游还可能返回 404/502/504，需现场分辨。
- `auth.js:72-87` 创建随机 access/refresh token，只存 access token 的 SHA256，30 天到期；`153-163` verifySession 查询未过期 session。server 目前仅注册、登录和 health，不提供持仓接口。
- **明确缺陷**：注册事务 `auth.js:106-116` 的 user.register payload 和登录事务 `142-148` 的 user.login payload 都没有 session。`services/auth/src/syncWorker.js:28-44` 原样发送 outbox payload，不会补 session；`workers/sync/src/internalAuthSync.js:250-256` 仅当 payload.session 存在才写 D1 sessions，注释也承认本地不发送。
- `workers/account/src/index.js:85-95` 和入口 `workers/account/src/entry.js:44-78` 从 D1 sessions 验 Bearer，找不到返回 401。account/sync 的 wrangler 配置绑定相同 `ai-dca-sync-db`。因此按仓库实现，本地新 token 即使用户事件全部同步成功，仍无法被云账号接口识别。这会破坏首次云同步/持仓同步，**不会直接导致 SQLite 登录密码比较失败**。

### 根因判定与待确认

已确认"无持久错误提示"的 UI 缺陷和本地/云 session 断链。手动登录无用户名的直接原因待确认：在 fast 站记录 POST login 是否发出、完整 URL、耗时、状态码、响应是否含有效 userId/username/accessToken；不记录明文密码/token。若未发出查按钮禁用状态和 Console；pending 查 nginx upstream timing、Node 日志/SQLite 写锁；401 查本地 users 是否存在、服务 AUTH_DB_PATH 与注册时是否相同，并离线比较计算后的凭据（不要输出哈希或密码）；200 查 session 事件及存储写入异常、线上 bundle 是否对应 HEAD、是否随后退出/切换 session。同时记录 /migrations/legacy 的 401，与 D1 是否缺该 token_hash 对照。

## Bug 2：新增交易后持仓为空

### 保存流程及数据结构

- `src/pages/holdings/TransactionDraftPanel.jsx:352-360` 保存按钮执行 onSubmit，对应 `src/pages/HoldingsExperience.jsx:615-688` 的 submitDraft。先 prepare、getTransactionErrors、normalizeTransaction，构造 nextState 和 upsertIds（`616-644`），再调用 persistHoldingTransactionMutation（`647-652`）。
- `src/app/holdingTransactionMutations.js:6-21` 新增为旧 transactions 数组追加 normalized；`69-109` 先 setLedger(nextState)、persistLedgerState、标 dirty，然后登录态尝试逐行上传，15 秒 abort；失败转换为 failed 列表并安排重试，不回滚本地。`HoldingsExperience.jsx:663-673` 即使 failed 非空仍提示警告并关闭浮窗，**关闭不代表云端保存成功**。
- `src/app/holdingsLedger.js:122-139` 写 `aiDcaFundHoldingsLedger`，envelope 为 `{source:"react-fund-holdings-ledger",version:3,transactions,migratedFromLegacy,legacyMigrationAt,switchChains,transactionCodeCount}`，不存 NAV snapshots。交易字段见 `src/app/holdingsLedgerBasics.js:271-299`：id、code、name、kind、type、date、price、shares、amount、costPrice、switchPairId、note、tags。例如 code=159659、kind=exchange、type=BUY、date=2026-09-30、shares=100。未填 price 会归一为 0；校验 `332-352` 不要求成交价，不能把缺成交价直接认定为此次丢交易原因。
- 没有此保存路径的 IndexedDB 写入。匿名时真实 localStorage 持久化；登录时 `src/app/authSession.js:3` 安装的 guard 将业务 key 的 getItem/setItem 重定向到 Map（`src/app/accountRuntimeStore.js:106-130`），因此登录态主要是**React state + runtime Map + D1 交易行**。DevTools Application 中原生持久存储为空可能只是匿名账本；应用执行 getItem 读到空则表示当时 runtime 为空，两者要区别。
- `src/app/holdingTransactionsSync.js:198-246` push 先读 runtime localMap，PUT 变化 id；`src/app/holdingTransactionsApi.js:26-35` 目标 `/api/account/v1/holdings/ledger/items/:id`，body `{data,baseRevision,force:false,end}`，Bearer 与 If-Match。请求先检查 legacy migration；session 缺 D1 时可能在迁移检查就 401，根本没有 PUT。

### 读取与覆盖证据

1. `src/pages/holdings/useHoldingsStorageSync.js:57-94` 挂载/登录后并行 GET 交易行、allocation、trades；交易行分页 `17-28`。拿到远端结果后 `41-44,83-89` **直接替换 runtime 和 React transactions**，无 pending 行合并、请求代次、abort、session 身份复核。
2. `96-159` 挂载、session changed、backup applied、auto-restored 都能触发 refresh；`110-133` 本地 ledger 事件虽会及时接受新行，仍不能阻止此前已发出的 hydrate 随后覆盖它。
3. 可触发的时序：GET 取得空快照但其他并行请求尚未完成 → 用户新增并写 runtime → hydrate 完成 → 空 transactions 替换新行。若覆盖发生在 `pushHoldingTransactionRows` 读取 localMap 前，`holdingTransactionsSync.js:214-216` 对缺失 id 静默 continue，返回无 failed；`describeHoldingTransactionSync`（mutations `123-127`）可能错误提示已同步。此为代码可推导竞态，生产是否命中待确认。
4. 普通自动 pull 并非简单空覆盖：`holdingTransactionsSync.js:150-195` 网络结束后读当前本地，按 id 合并，远端没有的本地行保留；force 会影响同 id 脏数据选择但不会直接丢本地独有行。不能泛称所有云 pull 都覆盖为空。
5. `HoldingsExperience.jsx:241-245` 远端未 ready 禁止 effect 持久化；ready 后持久化 ledger。`cloudSync.js:126-134` 恢复会发起 pull，UI 的 auto-restored 事件又引发直接 hydrate，增加重叠路径。`holdingTransactionsSync.js:458-473` runPull 没有像 runPush 那样检查用户操作 busy；各直调路径也不共享它的 inFlight。
6. 自动同步起点：`cloudSync.js:196-213`；交易 watcher/初次 1.5 秒 pull、60 秒 interval、focus 刷新见 `holdingTransactionsSync.js:476-507`。ed5416a3 更早启动会增加交错机会，但既不能解决缺失 session，也没有修复 hydrate 覆盖。

### 服务端职责与 key 索引

CN auth SQLite 的 users/sessions/sync_outbox/sync_state 不存持仓；syncWorker 只处理认证事件，不上传账本。持仓实际由 `workers/account/src/index.js:373-441,632` 处理，`workers/account/src/transactions.js:12-54,288-355` 写 D1 `account_holdings_transactions`（user_id + transaction_id 主键）、meta/history 表。`workers/sync` 负责认证复制及旧备份，不是新交易行存储入口。

主要读写位置：`holdingsLedger.js:99-139`；`holdingsLedgerStorage.js:22-65,113-115` 另一读取辅助实现；`holdingTransactionsSync.js:52-82` 同步读写；`useHoldingsStorageSync.js:41-44,118` runtime 写入；`accountRuntimeStore.js:106-130` 拦截；`src/pages/DataRepairExperience.jsx:42,143,295` 修复工具；`src/app/accountResources.js:8` 将该 key 注册为 rowSync 资源。须保留匿名与账号存储隔离。

### 待确认与确认方法

在 fast 站复现时记录保存前、写入后、hydrate 完成后的交易 id/count 与来源时间线；同时观察 /migrations/legacy、GET items、PUT items/:id、allocation/trades 请求。确认是否 GET=200 rows=[] 后覆盖，或 PUT 未发出/401/409/5xx/超时，及保存 toast 内容。检查 D1 transactions 是否存在该 user_id/id，SQLite sessions 与 D1 sessions 是否一致，outbox pending/dead 的 last_error。查看清空是否由 stale hydrate、账号切换或 sanitizer 引起，不以空数组单独定案。测试日志只记录 id/count/状态/耗时，不输出密码、Bearer 或完整账本。

## 修复步骤（后续实施，按顺序）

1. **先确认部署与请求链**：按上述待确认步骤取得 fast HAR、nginx `nginx -T` 中认证和账号 location、服务 DB 路径、systemd syncWorker 状态、前端 bundle 版本；核对 auth/register 与 auth/login 都进入同一 SQLite。先备份 SQLite（含一致性处理 WAL）和 D1，保留用户 id 与到期时间。
2. **补齐认证 session outbox**：在 `services/auth/src/auth.js` 的 createSessionRow/registerUser/loginUser 中，将本次 session 的 `{token_hash,user_id,created_at,expires_at}` 纳入同事务事件 payload.session；复用建 session 时的时间，禁止重算 30 天、禁止传原始 token。复用 internalAuthSync 的 applySession，确保用户/session/event 原子落 D1。现有未过期 session 及已消费的历史用户事件需另做一次可审查的幂等补同步，不能仅上线代码等待旧事件自愈；保持旧 event_id/payload 不变，为补偿创建新事件。核对同 token 冲突、失败重试和 dead letter。
3. **分离认证结果与同步结果**：`authClient.js` requestSync 增加有限超时和成功 session 形态验证；`account-menu.jsx` handleAuth 在有效 session 保存后立即完成登录 UI/解除认证 busy，后台单一协调入口处理 migration 与初次同步。不要让同步失败显示成登录失败；不要移除旧数据迁移门禁。保留异步认证架构，并为 D1 session 尚未到达提供有界重试与"云同步准备中"状态，不能把这类 401 自动当密码错误或无限重试。普通启动、UI 初始同步、后台 migration 只由一个协调器调度，避免重复 hydrate。
4. **在登录对话框展示认证错误**：`account-menu.jsx` 增加独立 authError，与同步 lastError 分开；在 `694-771` portal 中显示并提供 role=alert。401、500、网络失败、超时、异常 2xx 均有明确提示；重新提交清理旧认证错误。核对 toast 层级但不依赖 toast 作为唯一反馈。
5. **统一持仓 hydrate/merge**：将 `useHoldingsStorageSync.js` 的交易读入改为共享同步协调流程，单次远端结果按 id/revision 与当前 runtime 合并，保留 pending 新增/编辑和删除 tombstone；给请求加代次、session userId/token 身份保护、取消卸载/切换账号请求。generation 防乱序之外还要 mutation epoch 或 pending overlay，避免保存前已发出的请求覆盖保存后状态。`holdingTransactionsSync.js` 的自动 pull、手动恢复和页面 hydrate 共享串行/去重保护；不要仅给 runPull 加 busy 检查，因为旧在途请求仍可能返回。分配/trades 的请求也做账号/乱序保护。
6. **修正保存确认与失败保留**：`holdingTransactionMutations.js` / `holdingTransactionsSync.js` 显式登记变化 id、pending 状态，上传使用受保护的变化行快照；缺失 upsert id 应报告未完成，不得 continue 后声称已同步。按 pushed id 验证云确认；已保存但待同步在卡片及详情可见，失败不清账本。对当前 runtime-only 的失败重试无法跨刷新这一限制，在实施前明确策略：采用按 userId 隔离的最小持久 pending journal（含删除操作），或在刷新/退出前明确未持久化状态并阻止误称"已保存"。推荐 journal，须独立 key、独立恢复机制，不能取消 guard 或让不同用户共享匿名账本；同步成功后清理 pending。
7. **增加行为回归再部署**：扩充 `test/authClient.test.mjs`（当前 Node 无 window 且断言含 `|| true`，不足以证明浏览器 UI）、`services/auth/test/auth.test.mjs`、`workers/sync/test/auth-sync.test.mjs`，测试 register/login 事件真实携带 session、D1 验证、失败事务、固定到期、幂等/冲突。扩充 `test/holdingsRemoteSource.test.mjs`、`test/accountRemoteReadGuard.test.mjs` 与浏览器交互测试；使用可控延迟真实复现"空 GET 晚到、保存并行、账号切换、分页乱序"，不能只匹配源码字符串。覆盖 PUT 前迁移 401、PUT 失败/15 秒超时、missing id 不误报、pending 刷新恢复、删除不复活、旧账号迁移仍阻止业务读写。
8. 实施阶段运行相关 `node --test`（authClient、remote guard、remote source、ledger、交易事件等及三个服务目录测试），以及 `npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`。部署 Worker session 接收兼容部分 → CN auth/补偿同步 → 前端；排空队列核对后再验收。本次仅文档调查不运行实现验收、不提交。

## 风险与回滚

- 认证与同步分离可能让已登录用户暂时不能读取云数据，需独立状态提示；不能破坏 legacy gate 或反复自动退出。session 异步延迟需测试 CF 离线、恢复和超出重试窗口。
- 交易 merge 可能造成删除复活、重复交易、旧修改覆盖、跨账号泄漏；使用稳定 id、revision、删除 tombstone、账号隔离及行为测试。pending journal 含敏感交易，必须限定字段/账号并明确保留与清理策略，不能写 token。
- 回滚前端到事先保留的完整 bundle；可分别回滚 UI/协调器，但会重新暴露已知覆盖风险，必须保留/导出 pending 数据，不能清空用户存储"修复"。新 journal 采用版本化兼容读取，旧版本不应误上传。
- auth 回滚保留数据库、用户 id、会话和 outbox；不要删除已同步 D1 sessions，不要恢复过期时间。若回滚整个 CN 本地认证架构，先暂停新注册入口、排空/补齐队列、核对 SQLite/D1 users 和有效 sessions 后再切 nginx，避免本地新账号丢失。单纯回退 ed5416a3 不能修复 session 缺失，也不能证明持仓安全。

## 生产验收（必须在 https://fast.freebacktrack.tech/）

测试账户密码使用任务中提供值，不在计划/截图/HAR重复记录；以下必须留操作时间、请求状态和脱敏截图。

- 使用 `videodemo623` 和任务提供密码手动登录，POST login 成功，右上角显示用户名；认证完成不等待 CF 首次同步。刷新后会话有效。密码错误、用户不存在、服务 500、断网/超时均在登录对话框内显示错误并能重试。
- 登录后新增单笔：159659 → 添加 → BUY → 场内 → 日期 2026-09-30 → 100 份 → 保存。原样不填成交价也验证；概览显示该持仓卡片及正确份额。点击卡片显示详情及该交易，不显示"暂无当前持仓"。云同步成功需 PUT 的 id 与 D1 行、后续 GET 对应。
- 保存后等待首次 hydrate/至少一个自动 pull 周期、切标签/重新打开持仓页、页面刷新、退出再登录，卡片与详情均保留，无重复行。模拟空 GET 晚到时新增仍保留；上传失败时明确待同步，刷新后按确定的 pending 策略恢复，网络恢复不丢失且不重复。
- 注册新测试账号仍自动登录；user/session 最终同步 D1 且固定 30 天，CF 暂不可用不阻塞本地认证。相同用户名重复注册显示 409，不覆盖原凭据。
- 匿名用户新增/编辑/删除依旧真实本地持久化；登录不会串入另一账号或误上传匿名数据，退出后匿名账本保持原样。A→B 切换时 A 的在途请求不能写 B 的 UI/runtime/pending。
- 编辑、删除、卖出、旧账号迁移、跨设备同步与 revision 冲突均回归；持仓详情行情仍按需请求，列表不引入 K 线/NAV 历史等重接口。移动端底部浮窗保持导航隐藏/恢复行为，保存按钮可操作。

完成标准：上述 fast 验收和实现检查全部通过，并将仍未确定的生产触发点补为证据；目前所有生产验收均待执行。
