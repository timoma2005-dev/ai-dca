# 修复计划：account-menu.jsx previewKeyCount 永远显示 0

## 背景
- 5b4fbb61 重构后服务端成为唯一真相源，`collectBackupPayload` 被删除
- `previewKeyCount` state（src/components/account-menu.jsx:89）的 setter `setPreviewKeyCount` 从未被调用
- UI 在 525、634、637 行显示 "{previewKeyCount} 项"，永远是 0

## 计划（Codex 制定，2026-10-08）

### 1. 确认 `fetchAccountEnvelopeExport` 的返回结构与"项"定义
- 检查服务端 envelope export 响应，确定实际承载备份键值的字段，以及是否已有 `keyCount` 等服务端统计字段
- 若 API 已返回计数，直接使用服务端计数；否则根据 envelope 中实际导出的顶层数据项计算，避免重新引入已删除的 `collectBackupPayload` 或从浏览器本地状态推断
- 计数必须与最终导出、预览所使用的同一份 envelope 数据一致，服务端仍是唯一真相源

### 2. 在统一刷新流程中更新 `previewKeyCount`
- 在 `refreshLocalState` 或其调用的 envelope 加载函数中调用 `fetchAccountEnvelopeExport`
- 请求成功后同时更新预览数据和 `setPreviewKeyCount(count)`，确保 525、634、637 行的三个展示位置使用同一计数
- 账户切换、登录状态变化、导入或清除数据后，继续通过该统一刷新入口重新获取计数
- 无账户、登出或服务端明确返回空 envelope 时，将计数设置为 `0`
- 请求失败时不要把旧的有效计数误报为最新结果；应按现有错误状态约定清空为 `0` 或隐藏计数，并防止较早请求覆盖较新账户的结果
- 避免为了计数额外重复请求：一次 envelope export 响应应同时服务预览内容与计数更新

### 3. 需要修改的文件
- `src/components/account-menu.jsx`
  - 补齐 `setPreviewKeyCount` 的更新逻辑
  - 必要时抽取一个只负责解析 envelope 项数的小函数，统一处理空值和异常数据形态
- account menu 对应的现有测试文件
  - 若当前没有组件测试，则按项目测试约定新增测试
- 仅当现有 API 类型或返回值声明没有表达 envelope/count 字段时，修改 `fetchAccountEnvelopeExport` 所在的 API 模块及其测试；不改变服务端协议则无需修改服务端

### 4. 测试要求
- envelope 包含 N 个可导出项时，界面三个计数位置均显示 `N 项`
- 空 envelope 显示 `0 项`
- 验证计数来自 `fetchAccountEnvelopeExport` 的响应，而不是 localStorage、组件旧状态或已删除的 `collectBackupPayload`
- `refreshLocalState` 被触发后会重新获取并更新计数
- 导入、清除数据或账户切换后，计数能随最新服务端 envelope 更新
- API 失败、响应缺字段或数据形态无效时不会抛出未处理异常，也不会保留误导性的旧计数
- 若存在并发刷新，验证旧请求结果不会覆盖新账户或新请求的计数
- 验证一次刷新不会仅为计算 count 重复调用 envelope export API
- 运行相关组件/API 测试，并执行 `npm run check:refactor`、`npm run lint -- --quiet` 和 `git diff --check`

## 进度
- [x] Codex 制定计划
- [x] Codely 实现
- [x] 测试验证（test/accountMenuPreviewKeyCount.test.mjs 7 项通过；check:refactor 通过；account-menu.jsx eslint 0 错误）
- [ ] 推送到 yukerui/ai-dca
