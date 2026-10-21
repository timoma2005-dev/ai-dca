# Plan：worker 侧补齐 Bark/Server酱³ 开关接口

日期：2026-10-21。前置：docs/plan-bark-route-fix.md（前端改走 /api/notify/channels/* + Bark 值校验，已上线）。

## 根因（E2E 验收查实）
- 发布构建写死 API 域名：`scripts/cn-frontend/release.sh:23` 默认 `VITE_API_ORIGIN=https://api.freebacktrack.tech`，线上包 `apiBase` chunk 实测含该域名。UI 的全部 /api/notify/* 请求实际走 CF notify worker，不走同源 CN。
- 开关接口只在 CN 实现（services/cn-data channelToggle.js），worker 从来没有：旧路径 `/api/notify/bark/disable` 在 worker 上被 bark.js 当作推送 URL 报 `invalid bark path`；改名后的 `/api/notify/channels/bark/disable` 在 worker accountEntry 里无鉴权登记、无分发，落到 index.js 兜底 404「未找到通知接口」。E2E 实测开关 4 次点击全失败，保存/校验/移除正常。
- 即：2026-10-20 新发布机制上线后开关即断，CN 的实现 UI 够不到。

## 设计（在 worker 内补齐，与既有账号设置同一份存储）
先读 `workers/notify/ACCOUNT_NOTIFICATION_MODEL.md`、`src/accountEntry.js`、`src/notifyAccountAuth.js`、`src/accountReadRoutes.js`（status 组装）、`src/accountSettingsRoute.js` 与 `src/notifyRowStorage.js`（client-channel 记录 `::bark`/`::serverchan3` 的写/读路径），确认 enabled 应落的位置后再写，原则：开关写的值必须就是 status 读回的 channels.bark.enabled / serverChan3.enabled，且随既有同步链路（barkDeviceKey 今天怎么进 CN 的）一起带 enabled 到 CN 的 readBark/readServerChan3。

1. `src/notifyAccountAuth.js`：PROTECTED_NOTIFY_ROUTES 增加 4 条 POST：
   `/api/notify/channels/bark/enable|disable`、`/api/notify/channels/serverchan3/enable|disable`。
2. `src/accountEntry.js`：在落到 notifyWorker.fetch 兜底之前分发这 4 条到新 handler（如 `src/accountChannelToggleRoute.js`），鉴权与其他账号路由一致（走 authenticateNotifyAccountRequest 后的 verified account）。
3. Handler 语义对齐 CN channelToggle.js：未配置就 enable → 400，code 与文案一致（BARK_NOT_CONFIGURED「请先配置 Bark Device Key。」/ SERVERCHAN3_NOT_CONFIGURED「请先配置 Server酱 UID 和 SendKey。」）；成功返回 `{ ok: true, bark|serverChan3: <public 形状> }`，public 形状对齐 CN publicBark/publicServerChan3 并含 enabled。
4. `src/accountReadRoutes.js`：channels.bark 与 channels.serverChan3 补 `enabled` 字段（记录缺失该字段时默认 true，与前端 `?? true` 回退一致）。
5. `src/notifyRowStorage.js` 及相关读写：bark/serverchan3 的 client-channel 记录载荷带上 enabled（写时保留既有字段，读/组装时透传），保证 CN 同步后 readBark 的 enabled 与 worker 一致。
6. 不加旧路径别名（worker 上 /api/notify/bark/* 必须继续留给 bark.js 推送端点）；不动 CN；不动前端（已用新路径）。

## 测试
- 在 workers/notify/test 与仓库根 test/ 里找账号路由/status 的现有 harness，新增用例：未登录 401；未配置 enable 返回 400 与 code；保存后 disable→status 显示 enabled=false，enable→true；serverchan3 同理至少一条；回归：`/api/notify/bark/<key>/<body>` 仍进 handleBark、`/api/notify/channels/*` 不进 handleBark。
- 跑 workers/notify 的测试脚本与根目录 notify 相关测试，零新增失败；eslint 改动文件零 error。

## 部署（待 dudu 给一次性 CF token 后执行）
- 按 worker_deploy_kv_safety：部署前快照该 worker 全部 KV namespace 的键，wrangler deploy 后立即核验键数与关键键。
- 部署后用测试账号 musetest1021 复测开关开/关与 status 读回。
