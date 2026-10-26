# 登录后本地数据合并（login sync diff）

## 背景

`src/app/postAuthSync.js` 的 `runInitialAccountSync` 原逻辑：

- 云端有数据 → `restoreEncryptedCloudBackup`（资源远端优先 + 保留本地独有并回传；交易行按行合并），静默执行；
- 注册且云端空 → `uploadEncryptedCloudBackup({ force: true })`；
- 登录且云端空 → 返回 `no-remote`，本机老数据不会上传。

问题：登录老账号时本机数据不上传；登录有数据的账号时静默合并，同一浏览器切换账号会把 A 的本机数据并入 B。

## 目标

1. 登录云端为空的账号：与注册一致，强制上传本机数据（本机无数据则跳过）。
2. 登录云端有数据的账号：先在本地算 diff（按资源；持仓交易按行 id）。
   - 无差异 → 走原拉取；
   - 有差异 → 弹出合并对话框，逐项选择「保留本地 / 保留云端 / 合并（默认）」，顶部快捷「全部本地覆盖云端 / 全部云端覆盖本地 / 全部合并」；
   - 确认后执行，再启动自动同步；取消则不同步、不启动自动同步，提示「数据未同步」，可从账户菜单再次打开。
3. 注册、演示模式、旧版整包迁移（action-required）保持原逻辑；先迁移后 diff。

## 设计

新增文件（不让已有大文件变长，逻辑都在新文件）：

| 文件 | 职责 |
| --- | --- |
| `src/app/loginSyncGate.js` | 按 userId 持久化的「合并待确认」门禁（localStorage `aiDcaLoginSyncPending`）。门禁期间所有自动同步（资源/交易行的 pull/push、`startCloudAutoSync`）暂停。 |
| `src/app/loginSyncDiff.js` | 纯函数：资源 diff（数组资源按条目 id/key 给出仅本地/仅云端/内容不同；忽略 savedAt/updatedAt 等时间戳）、交易行按 id diff、选择归一化与快捷全选。 |
| `src/app/loginSyncActions.js` | 读取两侧数据（manifest + bundle + 交易行分页）与按选择执行；依赖可注入，便于单测。 |
| `src/app/loginSyncFlow.js` | 编排：注册/演示 → 原逻辑；云端空 → 强制上传；无差异 → 原拉取；有差异 → 保存待确认 diff 并派发 `cloud-sync:login-diff`。`confirmLoginSync` 执行并解除门禁、启动自动同步。 |
| `src/components/login-sync-diff-modal.jsx` | 合并对话框（PC 居中、手机全屏，列表可滚动）。 |
| `src/components/login-sync-pending-entry.jsx` | 账户菜单入口「数据未同步 · 处理数据同步」，门禁存在时显示，点击重新计算 diff 并打开对话框。 |

改动的已有文件（各几行）：

- `postAuthSync.js`：`runInitialAccountSync` 委托给 `loginSyncFlow`；登录时设门禁；`ensureCloudSyncReady` 在门禁存在时重新跑 diff 而不是直接启动自动同步（刷新、迁移完成后重载都会走这里 → 先迁移后 diff）。
- `authClient.js`：登录成功后立即同步设门禁，避免已在运行的自动同步（上一个账号启动的）在对话框出现前静默合并。
- `cloudSync.js`：`startCloudAutoSync` 遇门禁直接返回。
- `resourceSync.js` / `holdingTransactionsSync.js`：自动 pull/push 遇门禁跳过（dirty 保留）。
- `account-menu.jsx`、`entry-screen.jsx`：挂载入口与对话框。

### 选择的执行语义

| 选择 | 普通资源 | 持仓交易行 |
| --- | --- | --- |
| 保留本地 | 本地有 → `pushResource(force)` 覆盖云端；本地无 → `deleteAccountResource` | 清行同步基线 → `pushHoldingTransactions({ force, deletedIds: 云端独有行 })` |
| 保留云端 | 云端有 → 本地整体替换为云端值，再 `pullResources(force)` 登记 revision；云端无 → 删除本地 key | 清基线 → 本地账本替换为云端行（本地独有删除）→ `pullHoldingTransactions(force)` |
| 合并 | 云端有 → `pullResources(force)`（原逻辑：远端优先 + 本地独有回传）；云端无 → 上传本地 | 清基线 → `pullHoldingTransactions(force)`（同 id 云端优先）→ `pushHoldingTransactions()` 回传本地独有 |

清行同步基线：同一浏览器可能残留上一个账号的 revision/knownIds，登录合并前清空，revision 以当前账号云端为准。

任一项失败：门禁保持、自动同步不启动，对话框显示错误并提供「重新检查差异」。

## 测试

`test/loginSyncDiff.test.mjs`（node --test）：资源 diff、按行 diff、三种逐项选择、两种全局覆盖、失败收集、云端空登录强制上传/无数据跳过、注册不弹窗、无差异直接拉取、有差异弹窗 + 确认、切账号门禁隔离、部分失败保持门禁。

## 遗留

- 门禁期间用户手动保存交易时，变更层仍会按行直接推送该行（显式用户操作，不属于静默合并）。
- 交易行「保留本地」会强推全部本地行（与 overwriteCloudWithLocal 一致），行数很多时请求较多。
