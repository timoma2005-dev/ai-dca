# ETF PCF 份额新增实现与验证

实现 worktree：`/tmp/etf-shares-tab`，分支 `feat/etf-pcf-shares-tab`，基线 `61c4f8f9`。已核对 HEAD 包含 PCF / 事件 / 份额模块和 09:00 cron。本次任务指令记录 dudu 已确认 demo；按 plan 第 4、7 节重建单文件离线 demo，移动端选择卡片布局。

## 实现边界

- cron 复用原下载和解析后的内存数据，先完成永久辅助状态和事件日志，再运行独立投影旁路。下载条件、两次上限、顺序并发、原事件算法与 PCF TTL 不变。
- 投影和 latest 指针采用 30 天固定期限；按写入时间向下取整 TTL，小于 60 秒不写。同 isolate 串行、同 key 至少 1 秒间隔、内容不变跳写、记住已确认写入以应对 KV 暂时不可见。KV 没有 CAS，跨 isolate 最终一致性仍可能造成短暂 miss；读者严格拒绝身份不一致，不修复或回源。
- 日期/行/整数/差分/限额/时间/原因的 schema 位于 `shared/etfPcfSharesSchema.js`，由写者、API 和客户端共用；不将 Node XLSX parser 引入浏览器 bundle。
- 2026 年交易日校验复用已有 `src/app/holidaysCN.js`，逐段核对 [深交所年度休市公告](https://investor.szse.cn/disclosure/notice/general/t20251222_618087.html) 与 [上交所公告](https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml)。只接纳完整窗口；漏掉中间交易日或未验证年份不产生差分。此次核查公告仅用于开发时确认静态证据，运行代码与测试不请求公告。
- 原件 SHA-256 为 `541505aba7ecdb106679e02b6c7b90341edec97bfa76f5b96c3a3d42cf1c7d23`，缺少报表日期。parser 在带日期证据模式中同样拒绝 `missing_report_date`；上市日、下载日、文件名均不兜底。
- v1 金额和所有净值字段为 null，原因 `missing_dated_nav`。份额日期缺失时不发布成功对象，因此真实源未改变前可能只显示缓存 miss；不为满足 UI 制造日期或增量。
- 公开只读 GET 使用确定的 `https://api.freebacktrack.tech/api/etf-pcf-shares`，与仓库 ocr-proxy 的 `api.freebacktrack.tech/api/*` route 匹配；不扩大 cn/fallback 白名单。未部署、未验证线上可访问性。管理员门控仅控制前端挂载，不是服务端鉴权。
- 客户端仅 active/admin 加载，memory/inflight → localStorage → 单 GET。5 分钟 receivedAt TTL（不超对象期限，保持打开也会标记待确认）、30 秒 404 负缓存、延迟取消消费者、8 秒超时、上海跨日重新检查。无后台轮询、详情请求或 force 参数。
- 所有新增 fetch 使用 manual redirect，并拒绝 3xx/opaqueredirect；重试仍是同一个只读 GET。

## 验证

执行以下既有工具，没有新增依赖；worktree 缺依赖时通过 npm 缓存离线执行 `npm ci --offline --ignore-scripts --no-audit --no-fund`，锁文件未改。

```sh
node --test test/etfPcf*.test.mjs test/ssePcf*.test.mjs
npx playwright test test/e2e/admin-radar-shares.spec.js --project=chromium --workers=1
npm run build:app
npm run check:refactor
npm run lint -- --quiet
npx eslint src/app/etfPcfSharesClient.js src/pages/EtfPcfSharesPanel.jsx src/pages/AdminRadarExperience.jsx src/components/experience-ui.jsx --quiet
git diff --check
```

- Node 最终回归：126 项，125 通过、1 项既有跳过、0 失败。覆盖投影算式/真实缺日期 fixture/严格千分位/相邻交易日/TTL/单调指针/预算与故障隔离；API 200、partial、404、400、405、OPTIONS、503，断言 fetch/put/list/R2 均为 0；client 缓存、去重、abort、跨日、过期与 source/key 防御。
- 浏览器最终回归：10 项全过。覆盖管理员默认不请求份额、非管理员不请求份额或雷达、切 tab 命中无额外 GET、active 份额无新雷达或 compute 请求、loading/error/empty/partial/缺日期/stale、左右键与 ARIA、1440/390/320 无页面横向溢出。
- Chromium 使用环境已有 `/opt/meta-chromium/chrome`；关闭测试录像避免缺 ffmpeg，通过 Playwright 提供本地构建字节避免环境 loopback 限制。demo 直接从 `file://` 打开。截图位于 `test-results/shares-{ui,demo}-{1440,390,320}.png`。
- build、refactor guard、修改前端文件的定向 lint 与 diff 检查通过。全量 src lint 仍有 12 个基线错误（networkTrace、account-data-migration-modal、CnHomeExperience、DataRepairExperience、NewPlanSelectionCards、NotifyEventDetailDialog）；此次不修改其它任务的文件。

所有数值场景为 synthetic；真实 fixture 仅用于拒绝缺少日期的输入，不宣称真实份额增量可用。不 push、不合并、不部署。
