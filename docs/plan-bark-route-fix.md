# Plan：Bark 渠道管理接口与 worker 推送端点路径撞车修复 + Bark 值校验

日期：2026-10-21。需求：dudu 在通知设置里管理 Bark 时收到报错
`invalid bark path; expected /api/notify/bark/:key/:body, /:key/:title/:body, or /:key/:title/:subtitle/:body`，指示修复，并指出 Bark 值没有输入校验。

## 根因（已查实）
- 该报错只存在于 CF notify worker `workers/notify/src/bark.js:121`：旧版 URL 触发推送端点（LEGACY_PATH_PREFIX `/api/notify/bark/`）在路径段数不是 2-4 时返回此 404。实测 POST `https://api.freebacktrack.tech/api/notify/bark/disable` 原样复现。
- 前端渠道管理接口与该前缀撞车：`src/app/notifySync.js` 的 `GET /api/notify/bark/status`（后端路由）、`POST /api/notify/bark/enable`、`/disable`（serverchan3 同构）。实现只在 CN `services/cn-data/src/notify/routes.js:531` 的 channelMatch。请求一旦落到 worker（而非 CN）就报此错。
- Bark 值校验缺口：保存路径用 `src/app/notifyParsers.js` 的 `parseBarkInput` 提取（支持粘贴 api.day.app 链接取第一段），但提取后不校验字符集，任意含 `/`、空格、点的字符串都会被当作 device key 保存。

## 改动
1. `src/app/notifySync.js`：四个开关函数改走新前缀
   - `/bark/enable` → `/channels/bark/enable`，`/bark/disable` → `/channels/bark/disable`
   - `/serverchan3/enable` → `/channels/serverchan3/enable`，`/serverchan3/disable` → `/channels/serverchan3/disable`
2. `services/cn-data/src/notify/routes.js`：channelMatch 同时接受新旧两种路径
   - 新：`^/api/notify/channels/(bark|serverchan3)/(status|enable|disable)$`
   - 旧：`^/api/notify/(bark|serverchan3)/(status|enable|disable)$`（保留兼容已缓存的旧前端；捕获组顺序保持 channel、action 不变）
3. `src/app/notifyParsers.js`：新增 `normalizeBarkDeviceKey(input)`
   - 先走 parseBarkInput 提取，再校验：非空且匹配 `/^[A-Za-z0-9_-]{8,128}$/` 才返回该 key，否则返回 `''`。
4. `src/pages/NotifyExperience.jsx`：`handleSaveNotifyConfig` 与 `handleTestBarkNotify` 改用 normalizeBarkDeviceKey
   - 输入为空：保持原报错文案（请粘贴/请先填写）。
   - 输入非空但校验不过：报错 `Bark 链接或 Device Key 格式不正确，请粘贴 Bark 应用里的完整链接或 Device Key`，不保存、不发送。
5. `src/app/notifySync.js` 的 `saveNotifySettings`：纵深防御。当 payload 显式带 barkDeviceKey 且非空时，用 normalizeBarkDeviceKey 校验，校验不过抛 Error（文案同上）；为空字符串保持现有删除语义不变。
   - 注意其他调用方（保存其它渠道时不应被 Bark 校验误伤）：仅当 payload 自身带有 barkDeviceKey 属性时才校验。
6. 不动 worker（旧推送端点保持原样）；不动 CN 的 handleChannelToggle 等业务逻辑。

## 测试
- `test/notifyManagementUi.test.mjs` 增加断言：notifySync 源码含四个新路径且不再含旧路径调用；NotifyExperience 使用 normalizeBarkDeviceKey；notifyParsers 含校验正则。注意该文件既有基线 3 失败，只许零新增。
- `services/cn-data` 测试：在 services/cn-data/test/ 下找渠道开关相关测试（notify-channel-enabled.test.mjs 等），如其 harness 能覆盖路由，给新旧两种路径各加一条断言；跑该目录全部测试，零新增失败。
- 前端 `node --test test/notifyManagementUi.test.mjs`、`npx eslint`（改动文件零 error）、`npm run build:app`、`git diff --check`。

## 部署与验收
- 前端：合入 cn → CN 机 bundle 代推 fork → autorelease 发布 → 核查 RELEASE.json。
- cn-data：仓库 services/cn-data/src/notify/routes.js 与 CN 线上 /opt/ai-dca-cn-data/src/notify/routes.js 改前 md5 一致（e5c2e28a）；部署 = 覆盖该文件 + supervisor 重启 ai-dca-cn-data + 健康检查。
- 端到端：在 fast 注册一次性测试账号，走 UI 保存 Bark（分别测纯 key 与完整链接各一次）→ 关闭/开启开关 → 移除，全程不应再出现 invalid bark path；同时实测新路径经 fast 与 api 两域的响应差异（新路径在 worker 上应为普通 404「未找到通知接口」，不再是 bark 报错）。
