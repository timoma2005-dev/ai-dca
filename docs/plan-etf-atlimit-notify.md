# 顶格事件推送 + 份额页标记（2026-10-24 dudu 批准 Idea 卡）

## 需求
- 每日跑批写出「净申购顶格」事件（net_creation_near_total_limit, basis=total, ratio≥0.9）后，
  用 dudu 现有通知通道推一次；同一事件只推一次。
- 份额页（雷达页份额 tab）在对应 ETF 行打「顶格」标记；不改份额数值与列口径。

## 现状（已查实）
- 事件在 workers/etf-shares 每日 cron（09:00 + 09:30 补跑）计算，日志存 FUND_LIMIT_KV
  `etf-pcf-events:<yyyymmdd>`（永久），只读接口 GET /api/etf-pcf-events?date=YYYY-MM-DD。
- 放开事件（limit_relaxation）已有推送：etf-shares pcfSignalNotify.js → POST
  notify worker /api/notify/internal/pcf-signal → pcfSignalHandler 用全局 settings +
  deliverNotification 走 Bark/Server酱³/邮件/WS。顶格事件没有推送，本次补齐。
- detectedEvents 每次跑批按当日数据重算，09:30 补跑会重复检出同一事件 → 发送侧必须自带去重。
- 最近真实顶格事件：2026-10-19 与 2026-10-14，均为 159513/159632/159659，ratio=1。
- 份额页数据 join 键：页面已推导「限额基准日」（顶层 data.limitDate 或各行 limitDate 最大值），
  事件日志日期即该限额日（PCF 快照日），按此日期取事件做标记。

## 实现
1. [x] etf-shares：pcfSignalNotify.js 新增 sendPcfAtLimitNotifications(env, events)
   - 过滤 net_creation_near_total_limit + basis=total；
   - KV 去重：FUND_LIMIT_KV 键 `etf-pcf-atlimit-notified:<yyyymmdd>` 存已发送事件 id 数组
     （id = date:code:signal_type:basis），仅 response.ok && result.ok 后记入；
   - POST /api/notify/internal/pcf-at-limit，body {code,date,netCreation,totalLimitShares,ratio}，
     token 行为与现有 pcf-signal 发送一致；
   - index.js 在放开推送旁调用，独立 try/catch，结果计入返回值 pcfAtLimit。
2. [x] notify：新增 pcfAtLimitHandler.js（镜像 pcfSignalHandler）
   - 服务端按 netCreation/totalLimitShares 重算 ratio 并校验 ≥0.9，不信任入参 ratio；
   - notification eventId `pcf-at-limit:<code>:<date>`、eventType pcf_at_limit，
     readSettings + deliverNotification 同放开路径；
   - index.js 在 pcf-signal 旁注册 POST /api/notify/internal/pcf-at-limit（同样的内部路由位置）。
3. [x] 前端：SharesExperience 按限额基准日拉 /api/etf-pcf-events，得到顶格 code 集合，
   行渲染时在名称旁加「顶格」标记（title 说明口径）；拉取失败静默降级；不动任何数值与列。

## 验证
- 单测：etf-shares 发送过滤/去重/失败隔离；notify handler 校验与投递形状；前端标记渲染。
- 端到端（部署后）：用 2026-10-19 的真实事件（159632）调一次新接口，
  查投递结果与 D1 notify_delivery_stats 中 event_id=pcf-at-limit:159632:2026-10-19 的记录；
  份额页用真实数据目检标记（当日无限额日事件时标记为空属正确）。
- 部署：两个 worker 需一次性 CF token（Workers Scripts Edit）；前端走 CN release。

## 完成记录（2026-10-24，分支 cn）

- [x] 发送端仅消费 `net_creation_near_total_limit` + `basis=total`，使用事件自身的日期与
  `date:code:signal_type:basis` 去重；成功 POST 且 JSON `ok` 为真才记入，同日成功记录合并为一次 KV 写入。
  `results[].dedupe` 区分 `hit`、`stored`、`miss`、`unavailable`、`read_failed`、`write_failed`、
  `invalid_cache`、`invalid_event`；读失败或缓存损坏时仍发送，但不覆盖未知的已发送记录。
  每日刷新在原放开推送之后独立调用，返回 `pcfAtLimit`，两个推送块异常隔离。
- [x] notify 新增内部 POST 路由，与放开路由相邻且位于账号鉴权判断之前；校验代码、日期与安全整数，
  忽略请求 ratio，按份额重算，低于 90% 返回 `400 / ratio_below_0.9`。
  名称映射、通知字段及 `readSettings + deliverNotification` 调用沿用现有放开路径；说明文案使用本计划要求的中性表述。
- [x] 当前 `SharesExperience` 默认实际渲染 `SharesBoard`，旧表格保留为 `LegacySharesPanel`。
  两个视图共用 `usePcfAtLimitCodes`，按各自已有的限额基准日订阅；当前看板的卡片、表格、手机条目和旧表格
  均在名称旁复用现有标签样式显示「顶格」，title 为 `当日净申购达总限额（≥90%）`。
  事件客户端只读小事件日志，带日期隔离、5 分钟内存缓存、inflight 复用、8 秒超时及卸载取消；
  校验 source、日期与 events 数组，失败或空事件不加标记。未改事件计算、份额口径、列顺序或详情展开行为。
- [x] 测试使用真实页面的 events fetch 拦截与 shares 替身，直接验证标记渲染，无需退回筛选函数测试。
  补齐既有 harness 引用但未声明的 `esbuild` 开发依赖；为从当前 WorkspacePage 提取的路由函数补上
  `activeAccess` 测试上下文，并将旧的无权限回退预期对齐为当前 RBAC 拦截行为。

### 本地验证

- [x] 定向测试 66/66 通过（发送端 18、notify handler 29、事件客户端 5、页面渲染套件 14，含父测试）。

  ```sh
  node --test --test-reporter=tap workers/etf-shares/test/pcfAtLimitNotify.test.js workers/notify/test/pcfAtLimitHandler.test.mjs test/etfPcfEventsClient.test.mjs test/etfSharesDetailUi.test.mjs
  ```

- [x] 根目录 ETF/份额相关测试与 etf-shares Worker 套件：221 项，217 通过、3 个既有失败、1 个环境跳过。
  与原始提交副本对比，无新增失败；3 个失败为 `etfPcfEvents.test.mjs` 的 projection sidecar 用例，
  以及 `etfPcfSharesDates.test.mjs` 的 dated same-day / T-1 historical PCF 两例。
  原始页面 harness 的路由上下文错误已随本次测试修复；本地 workerd 验证因无缓存 wrangler 而按原测试规则跳过。

  ```sh
  node --test --test-concurrency=4 --test-reporter=tap test/etf*.test.mjs test/sharesWorkspaceRedirect.test.mjs workers/etf-shares/test/*.test.js
  ```

- [x] notify Worker 与根目录 notify 相关套件已对比原始提交：当前 202 项，184 通过、18 失败；
  原始提交 173 项，155 通过、同样 18 个失败，失败名称完全一致，无新增失败。
  既有 accountDeliveryIsolation 测试需要 `--experimental-vm-modules`。

  ```sh
  node --test --experimental-vm-modules --test-reporter=tap test/notify*.test.mjs workers/notify/test/*.test.mjs
  ```

- [x] `npm run build:app` 通过；改动的前端源码单独 eslint 通过；`git diff --check` 通过。
- [x] 已运行仓库要求的 `npm run check:refactor` 与 `npm run lint -- --quiet`：
  原始源码已有 `NotifyExperience.jsx` 938 行超出 880 行预算，lint 已有 12 个错误；本次没有增加这些失败。
- [ ] 部署后端到端验收：历史 159632 通知投递与 D1 记录、线上份额页目检。
  本次按要求仅本地实现与三个逻辑提交，不 push、不部署、不发送真实通知。
