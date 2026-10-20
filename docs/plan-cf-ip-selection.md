# CN → Cloudflare Worker IPv4 优选改造计划

本文仅为 cn 分支的实施计划，不修改实现、不执行部署。目标是降低 CN 主机跨境 TLS 首连耗时及漂移，同时保留普通 DNS 回退、现有超时、outbox 和业务失败处理。

## 1. 已核实的调用链与边界

| 调用点 | 当前客户端与 URL 来源 | 拟改动 |
| --- | --- | --- |
| `services/etf-mirror/service.py` | `http.client.HTTPSConnection` 子类 `PinnedHTTPSConnection`；`ETF_MIRROR_UPSTREAM` 默认 `https://api.freebacktrack.tech` | 保持原样，作为行为参考 |
| `services/auth/src/syncWorker.js` | Node 全局 `fetch`，POST；`SYNC_WORKER_URL` 默认 `https://api.freebacktrack.tech/api/sync/internal/sync-auth` | 用本服务 IPv4 优选传输层；保留 15s、eventId、429/5xx 重试及其他 4xx 死信 |
| `services/cn-data/src/syncDaemon.js` | Node 全局 `fetch`，可注入 `fetchImpl`；三个 `SYNC_DAEMON_NOTIFY_URL/ACCOUNT_URL/SYNC_URL` 必填 | 共用本服务传输实例，按 origin 隔离优选缓存；保持注入接口 |
| `services/market-collector/market_collector/xueqiu.py` | `default_fetch_json` 用 `urllib.request.urlopen`；`_fetch_worker_payload` 经可注入 fetcher 请求 `xueqiu-fund-data/:code` | 只替换 Worker 分支，雪球直连保持原客户端 |
| `services/market-collector/market_collector/publish.py` | `ReplicatingPublisher._post` 用可注入 `opener`（默认 `urllib.request.urlopen`）POST；`build_publisher` 读取 `publisher.worker_url`，仅 `backend=file+worker` 启用 | 为默认 opener 接入优选模块，保留注入、先写本地文件、先 flush outbox 后新包、失败 spool |
| **补充遗漏**：`services/market-collector/market_collector/product_http_server.py` | `_market_quotes_request_from_config` 直接 `urlopen` GET Worker `/quotes`，60 标的一批、最多四个请求槽 | 同用 Python 模块，保留批量上限与请求槽 |
| CN nginx `/etc/nginx/conf.d/ai-dca-cf-api-upstream.conf` | 用户提供：`ai_dca_cf_api_v4` 目前 `104.21.38.17` 主、`172.67.217.77 backup` | 最后阶段可选 cron 重排，不在本次执行 |

cn-data 的配置值并非完整端点原样使用：`daemonConfig()` 用 `new URL(path, base)` 生成 `/api/notify/internal/sync-rules`、`/api/account/internal/sync`、`/api/sync/internal/sync-backup`，允许 HTTP 和 HTTPS。必须保留 HTTP 本地测试/开发通路，不能给它套 CF IP。

雪球 URL 优先显式参数，其次 `XUEQIU_WORKER_URL`，默认 `https://api.freebacktrack.tech/api/markets`；`product_http_server.py` 又可从 `xueqiu.worker_url` 显式传入，空字符串表示关闭。quotes 的 URL 优先 `market_api.worker_url`，其次 `xueqiu.worker_url`，最后 `MARKETS_WORKER_URL` 或同一默认地址。空配置必须本地短路，不触发 DNS/探测。

仓库未包含生产 `services/market-collector/config.json`：题述 collector-ingest 地址是生产输入，需部署前只读确认实际 `publisher.backend/worker_url`，不能声称已核实线上值。`config.example.json` 和 `core.py` 的 publisher 默认不自动开启 Worker 上报。nginx 文件也不在仓库，需上线前核实其引用 location、Host/SNI、证书验证与超时。

其它扫描结果：`cn-data/src/notify/marketClient.js` 的 `MARKETS_BASE_URL` 默认本地 `http://127.0.0.1:18080/api/markets`，若生产改成 CF HTTPS，也应在第一阶段接入同一个 Node 包装器；先核验生产配置。Resend/Bark/ServerChan/蛋卷等外部请求不套 CF 池。collector 的 fund_reference 当前已本地化（忽略 worker_url），不恢复网络调用；fundmobapi 及其它源站仍原路请求。仓库外 scripts 的运维调用不属于本次 services 常驻进程范围。

## 2. 参考实现与统一配置

etf-mirror 实际逻辑：`getaddrinfo(AF_INET)` 的实时 A 记录在前，静态池随后去重；最多 8 线程测 TCP+TLS，默认探测 6s；启动、每轮同步（默认 300s）、stale 后台补刷前重选；按线程复用连接，IP 变化关闭旧连接；异常后排除失败 IP 重选再试一次。全部失败取候选首个；exclude 后无候选会恢复原池。现有静态项未严格校验 IPv4，且异常捕获较宽，新模块要收紧，不能把 HTTP/JSON 失败都当连接失败。

新增模块统一采用与 `ETF_MIRROR_UPSTREAM_IPS` / `ETF_MIRROR_PROBE_TIMEOUT` 同风格的命名，超时统一以秒计：

| 环境变量 | 建议默认值 | 含义 |
| --- | --- | --- |
| `CF_UPSTREAM_IP_SELECTION_ENABLED` | `0`（灰度后 CN 显式设 `1`） | 总开关；`0` 不解析候选、不探测、不 pin，直接使用原 fetch/urlopen |
| `CF_UPSTREAM_IPS` | `104.21.38.17,172.67.217.77` | 静态 IPv4 池，实时 A 在前，稳定去重；拒绝非 IPv4/非法值 |
| `CF_UPSTREAM_PROBE_TIMEOUT` | `6` | 单 IP TCP+TLS 探测上限；DNS 和整轮另受总预算限制 |
| `CF_UPSTREAM_RESELECT_INTERVAL` | `300` | 优选结果有效秒数，按 origin 缓存 |
| `CF_UPSTREAM_HOSTS` | `api.freebacktrack.tech` | 精确允许的 hostname，禁止把静态池用于任意自定义域名 |

不重命名、不修改 etf-mirror 的既有变量。新总开关覆盖本次新增 Node/Python 模块；nginx 脚本也遵循它（关闭后恢复预留的 DNS 配置并验证 reload）。**它不能控制未修改的 etf-mirror**，此限制应写入运维说明；本次“一键普通 DNS 回退”指新增改造范围，不能假称已有 mirror 也支持该开关。环境变量改变后需重启相应进程，nginx 则显式运行切换脚本，不等下次 cron。

静态默认池仅适用于该域名。部署时确认其确为此域名真实可用 CF anycast 地址；其它 hostname 单独使用其真实 A 记录，不盲用默认池。非允许域名、HTTP、IP 字面量 URL 直接走原客户端。保留原 URL、path、query、端口、鉴权及 UA；禁止将 Bearer/Cookie 转发到其它 origin。明确拒绝带凭证 URL，跨 origin 重定向不继承 pin 或敏感头。

## 3. Node 小模块设计

选择 Node 内置 `https.request` + keep-alive `https.Agent`，放在 `services/auth/src/cfIpSelection.js` 与 `services/cn-data/src/cfIpSelection.js`。两服务目前无运行依赖、Node >=22.5，cn-data 明确只用 builtins，故不为此引入 undici。原生 fetch 没有标准 pin 参数；undici 自定义 dispatcher/connector 可保留 fetch 响应语义，但要显式添加版本化依赖，不能依赖 Node 内部 undici。若未来统一依赖后再迁移 dispatcher，本轮不采用。

模块导出 `createCfWorkerTransport({ env, dnsLookup, probe, requestImpl, clock })`，返回 `prepare(urls, {signal})`、`fetch(url, init)`、`close()`，DNS 路径直接委托原 fetch，允许测试注入。pin 路径只支持实际需要的 JSON POST/GET 与可重放字符串/字节 body；返回业务用到的 `ok/status/headers.get/text/body.cancel`，并消费/释放未使用响应，避免 auth 成功分支不读 body 导致连接无法复用。适配层必须经契约测试，不把不完整对象冒充通用 Fetch 实现。

请求保持 hostname 为真实域名，通过 Agent 的定制 lookup 返回选中 IPv4，显式正确 `servername`；Host 由真实 URL 生成（非默认端口包含端口）。每个 `(origin, selectedIP)` 独立 Agent，避免旧 socket 绕过新选择；换 IP 时淘汰旧空闲连接，进行中请求自然结束后清理。连接数有界，进程 stop 等待 batch 后 close。用 `dns.resolve4` 获取 A 记录、`tls.connect` 验证 TLS 并计时；DNS 等待必须有截止时间，超时忽略结果，不无限阻塞同步。

auth 引入模块并在有事件的 `processOnce` 批次首次使用前 prepare；cn-data 保留 `fetchImpl` 测试覆盖，默认改为模块包装器，按本批实际 target 的 origin prepare，三个相同 origin 只探测一次。两个 `/opt` 是独立拷贝部署，禁止运行时跨目录 import 或要求根 node_modules。接受两份小模块受控复制：同次变更同步内容，增加一致性检查和两份相同契约测试；不引入第三个必须随目录外部署的共享包。

## 4. Python 小模块设计

新增 `services/market-collector/market_collector/cf_ip_selection.py`；当前只供 collector 包内部引用，不跨服务复制，不改 mirror。导出 `prepare(url)` 与 `open_url(Request, timeout=...)`，后者保持 urlopen 的上下文管理、HTTPError/URLError 约定及可注入调用形式。

复刻 mirror 的 `PinnedHTTPSConnection`：socket 连选中 IPv4、`ssl.create_default_context()` 严格验证证书且 `server_hostname` 为真实域名；保留 URL 端口，Host 用真实 authority。通过自定义 `urllib.request.HTTPSHandler`/局部 opener 接入，禁止全局 `install_opener` 或 monkeypatch socket/DNS。

**urllib 默认链路并不自动保证连接复用**：不能只接一个 HTTPSHandler 就宣称完成。设计专用 handler 管理线程内 `(origin, IP)` 连接，返回兼容 urllib 的响应包装；完整读尽才归还连接，提前 close/cancel、异常或服务端 Connection: close 则丢弃；换 IP 淘汰旧连接。若实现无法可靠保持此生命周期，先以正确 pin、关闭连接上线，并把连接复用列为未完成验收项，不以带病池化换性能。与 Node 一样限制连接数、合并同 origin 的并发探测。

具体接入：

- xueqiu 仅在 `_fetch_worker_payload` 的默认 fetcher 网络路径使用 `open_url`，保留现有 fetch_json 注入；不可把雪球 Cookie 送往 Worker，也不可给雪球域名用 CF IP。保留请求槽、缓存、错误映射和现有 UA。
- publish 在 `build_publisher` 构造时提供共享模块 opener，显式注入的测试 opener 优先；每轮 `publish()` 在实际发送前按 TTL prepare，一次 flush 中不逐包探测。POST 回放仍由原 outbox 管理。
- product_http_server 的 Worker `/quotes` 用 `open_url`，共享同进程选优缓存；不触碰 fundmobapi 请求。不为隐藏列、未选标的或空 worker_url 新增请求，列表仍只用轻量 `/quotes`。

## 5. 探测缓存与失败语义

每进程每 origin 保存候选、选择时间、耗时摘要、正在执行的选优任务；TTL 内直接复用。auth 5s poll、cn-data 默认 30s batch 都不等于探测周期；有工作且 TTL 到期才在批次前选优，空队列不探测。collector publish 轮次用相同策略；交互式 GET 冷启动可用候选首个发起请求并合并后台选优，已有可用连接过期时先用旧连接后台重选，避免把 6s 探测串到每个用户请求。后台必须有锁及最小重选节流，不能每个异常触发一轮。

最多并发探测 8 个，池长度设上限（建议 16，保留 DNS 候选优先），单轮总预算建议不超过 6s，到期取消余下探测；socket/TLS/DNS 全部释放。使用单调时钟计时。超时、NaN、负值等配置校验失败保持默认并告警，非法候选过滤；不因配置异常阻止普通 DNS 请求。

失败行为：

1. DNS 失败仍用静态池；全部 TLS 探测失败仍返回候选首个并标记 degraded，不把探测失败当业务请求失败。候选为空直接走普通 DNS；不写入“已健康”的假状态。
2. pin 建连失败（TCP 拒绝/超时、握手传输中断）关闭连接，排除失败 IP 即时重选，**最多重试一次**；排除后无替代候选时第二次尝试普通 DNS。证书验证错误必须保持拒绝，可选其它候选或普通 DNS 验证，绝不关闭验证。
3. 第二次的路由在“替代候选 pin”与“普通 DNS”中二选一，不再暗加第三次重试。全探测失败并不能证明 HTTP 不通；若候选已无可信可用替代，用 DNS 作为第二次。第二次失败交回原 outbox/兜底，不清空旧数据。
4. GET 可在连接中断后重试一次；POST 只在能确认请求未写出时透明换 IP。写出后断开、读响应超时属于结果未知，不自动重发，交回已有 eventId/outbox 机制；实施前核验 Worker 幂等性，collector ingest 尤其不能未经确认新增重复提交。HTTP 4xx/429/5xx、CF 1034、JSON/schema 错误均不按连接失败重试，沿用业务处理。
5. prepare 与请求重试共享原 15s（Node/publisher）或调用方 timeout 总截止时间；没有剩余预算时跳过探测，使用已有路由/DNS。Abort 必须取消探测和请求；不能把 15s 变为两次 15s 再加两轮 6s。后台重选不阻塞已开始请求。

“不比现状更差”的验收是：一键 DNS、总耗时有界、失败不丢事件/旧数据、不新增不安全 POST 重放；无法保证任意时刻 pin 的网络质量必然优于系统 DNS，需以 CN 灰度指标验证。

## 6. nginx：最后再决定是否启用

建议先完成应用层并观察至少 24h。若 nginx 剩余 CF 转发量或握手 p95 仍明显受影响，再做 cron；收益低则保留当前静态主备。TLS 握手最快不等于请求 TTFB 最快，频繁 reload 的运维成本可能高于收益。

拟新增仓库脚本 `services/cf-ip-selection/select_nginx_upstream.py`（自带标准库探测，不依赖 collector 安装），CN 安装到 `/usr/local/sbin/ai-dca-cf-ip-selection`，每 5 分钟 cron 执行，flock 防重入。采用同变量约定与 IPv4 候选逻辑；成功候选按耗时排序，最快唯一主节点，其余 backup，未探测成功的保留为最后备用。**仅重排一组普通 server 并不会优先最快，而会继续轮询，必须明确主/backup。** 无成功探测则不改旧配置。

至少两轮胜出且优于当前约 20% 才换主，最短 reload 间隔 15 分钟。候选配置先写同文件系统临时文件，校验 IPv4、模板和权限；备份旧文件、原子替换，在独占锁内运行 `nginx -t`，成功才 `systemctl reload nginx`。测试失败立刻恢复旧文件；reload 非零也恢复并验证旧配置/恢复 reload，告警保留证据。不能只改临时 snippet 后对旧磁盘配置运行 -t 冒充验证；记录文件 hash 防并发手工改动被覆盖。

上线前核对引用 upstream 的 location：`proxy_ssl_server_name on`、`proxy_ssl_name api.freebacktrack.tech`、`proxy_set_header Host api.freebacktrack.tech`，并明确 `proxy_ssl_verify on` 与受信 CA 路径。仅 TCP/TLS 成功不能排除 CF 1034，上线前对无鉴权健康端点做 Host/SNI 完整的 HTTP 冒烟。不得扩大 POST 的 `proxy_next_upstream` 重试范围。

保留两份人工审核基线：原静态主备和普通 DNS 配置。关闭总开关时脚本恢复 DNS 基线、`nginx -t` 后 reload；核实当前 nginx 版本对 upstream 域名解析/重解析的支持，DNS 基线至少在 reload 时解析，不承诺未配置 resolver 的运行时刷新。cron 关闭本身不会撤销当前 pin 配置。

## 7. 测试与验收

沿用服务现有约定：auth/cn-data 为 `node --test` 的 `.test.mjs`；collector 已有测试是 `unittest.TestCase`/mock，不强制迁移 pytest（可由 pytest 收集）。mirror 未发现测试目录，本次不改它。

- 两份 Node 新增 `test/cf-ip-selection.test.mjs`：A+静态顺序去重、过滤 IPv6/非法值、DNS 失败、全失败首项、空池 DNS、失败排除换 IP、只有一 IP 时 DNS、HTTP 不换 IP、关闭开关完全不探测、TTL 命中/过期、并发只探一次、origin 隔离、超时/abort 和清理、SNI/Host/证书校验、连接复用及换 IP 淘汰。
- auth 扩展 outbox 测试：优选不改变 eventId；429 Retry-After、5xx、死信及终止行为保持；成功响应释放；写出后断连不透明重发。
- cn-data 扩展 `test/service.test.mjs`：三个 endpoint 构造保持、同 origin 共享选择、不同 origin 隔离、`fetchImpl` 可注入、HTTP 不探测、不改失败调度；若配置启用远程 marketClient，再覆盖该 GET 包装器。
- Python 新增 `tests/test_cf_ip_selection.py`：候选合并去重、全失败/空池、失败换 IP、TTL/锁、关闭开关零探测、SSL hostname 验证、HTTPError 保持、超时预算、线程池/响应清理、连接复用/换 IP；测试用 fake socket/probe/clock，不依赖跨境实网。
- 扩展 `test_xueqiu.py`：仅 Worker 路径 pin、缓存命中/禁用 fallback 不探测、雪球直连不 pin、Cookie 不泄漏、HTTP/schema 错误不重试。扩展 `test_publish.py`：本地文件及 spool 保留、失败换 IP、POST 未写出才重试、结果未知只 spool、重放顺序不变、自定义 opener 仍有效。扩展 `test_http_server.py`：Worker quotes 走模块、空 URL 零探测、每批上限/并发保持、fundmobapi 不 pin、不新增详情请求。
- nginx 脚本测试：全失败保持文件；主/backup 渲染、滞回、锁竞争、无变化不 reload；`nginx -t` 失败、reload 失败恢复；开关恢复 DNS 基线。真实 nginx 语法在 CN 安装版本验证，不在单测调用生产 reload。

实施提交前运行：各服务目录 `node --test`；collector 目录 `python -m unittest discover -s tests`（若环境已有 pytest 可用 `python -m pytest tests`）；根目录 `npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`。本次文档提交至少运行既有相关 Node 测试与根检查，不将未来新增测试写成已完成。

CN 验收记录开启/关闭对照：握手耗时、请求 p50/p95、失败率、探测数、选中 IP、outbox 积压/死信与 collector 新鲜度。日志只记 origin/IP/耗时/错误分类，不记 token、Cookie、同步 payload。检查证书失配仍失败；进程重启仍能继续未完成 outbox。

## 8. 分阶段部署与回滚

1. **准备**：保存版本/环境变量/服务定义和 nginx 原配置；只读确认有效 URL、A 记录、静态 IP 与真实 hostname 的 HTTP 可达性。核验 `/opt` 实际副本与仓库差异，不能直接覆盖生产独有修改。仓库未提供 cn-data systemd unit、mirror supervisor program 定义，部署前用 `systemctl cat`/`supervisorctl status` 确认真实名称和环境来源，禁止猜名称执行。
2. **Node 首批 auth，随后 cn-data**：测试通过，默认开关 0 发布模块和调用方，再单服务开启；`services/auth` 按现有独立拷贝方式同步到 `/opt/ai-dca-auth`，包含模块，不动 DB/secret。部署脚本已确认同步单元 `ai-dca-auth-sync.service`，执行 `systemctl daemon-reload`（仅 unit 有变化时）和 `systemctl restart ai-dca-auth-sync.service`；HTTP auth 无需因仅 sync 改动重启。`services/cn-data` 同步到 `/opt/ai-dca-cn-data`，用核实后的 sync daemon 单元 `systemctl restart <实际同步单元>`，仅 marketClient 也改动时重启其宿主服务。观察一个阶段后再推进。
3. **Python**：在 `/root/ai-dca/services/market-collector` 发布包文件，保留生产 config、.venv、data/outbox。仓库 supervisor 配置使用专用 socket，按线上实际实例执行 `supervisorctl -c /root/ai-dca/services/market-collector/deploy/supervisor.conf restart market-collector market-collector-api`；改 supervisor environment 时先 reread/update 再确认并重启目标。不要直接整目录覆盖 supervisor 环境。`paper-trading` 未直接调用本次模块不需重启。`/root/ai-dca/services/etf-mirror` 同属 supervisor 管理但本次不更新、不重启，保留原优选逻辑和数据。
4. **nginx 可选最后**：满足收益门槛后安装脚本，先 dry-run 人工审核，再 `nginx -t` + reload，最后启用 cron；监控 24h，异常即停用并恢复基线。

回滚：新增应用模块统一设 `CF_UPSTREAM_IP_SELECTION_ENABLED=0`，重启上述实际进程，即恢复原 fetch/urlopen DNS 行为；如有其它回归恢复备份的服务文件版本并重启。无 DB migration，不删 SQLite/outbox/快照。nginx 先停 cron，恢复审核过的 DNS 基线或原静态主备备份，`nginx -t` 成功再 reload；测试失败不 reload，修复/恢复配置文件并告警。mirror 的现有 pin 不受新开关影响，不借本次回滚改它。

## 9. 风险与进入下一阶段的条件

- 证书验证始终开启，SNI/Host 必须对应真实域名；禁止 URL 改成 IP 后用 Host 头“补救”、禁止 verify=False/rejectUnauthorized=false。
- CF **1034 Edge IP Restricted** 历史教训：任意 Cloudflare IP 并非都能服务该域名。候选必须是该域名真实 CF anycast 地址，域名迁移后静态池可能过期；握手成功也需 HTTP 冒烟确认。1034 不当网络错误循环重试。
- 每次探测会消耗 socket/TLS/跨境连接；小池、限并发、TTL、singleflight、无工作不探测，防多进程同步形成尖峰。可给 batch 调度加小幅抖动，不改变业务刷新 SLA。
- POST 结果未知重复提交、urllib 连接生命周期、fetch 适配响应差异、DNS 查询不可取消、代理环境均需测试。检测 HTTPS_PROXY/显式代理部署，未验证 CONNECT 与 pin 语义前退回原客户端，不能静默绕过既有代理。
- 缓存按 origin 隔离，两个独立 Node 副本存在漂移风险；同次复制及一致性检查为上线要求。日志中不能泄露内部凭证。
- nginx reload 影响所有引用该 upstream 的流量；旧 worker/长连接会暂时继续用旧 IP，不能承诺立刻全切换。滞回降低频繁重载，不改全局路由和重试策略。
- 下一阶段要求：无新增证书/鉴权/死信错误，outbox 不持续积压，总请求预算保持，CN p95 或失败率有实测改善；否则先关开关回到 DNS，保留观测结果再调整。
