# radar-cache

纳指雷达快照本机缓存：把 CF Worker 的 `/api/notify/nasdaq-radar`（及 `/features`）每 5 分钟同步到本机 SQLite，
nginx 把雷达 GET / 手动计算 POST 指到本服务（RBAC 仍由 nginx `auth_request` 负责）。只用 Node 内置模块（`node:sqlite`）。

- 监听：`127.0.0.1:8084`（`RADAR_CACHE_PORT`）
- 数据库：`/var/lib/ai-dca-radar-cache/radar.sqlite`（`RADAR_CACHE_DB`）
  - `radar_snapshot`：`latest` / `features` 各一行（原样保存上游 JSON）
  - `radar_history`：按快照日期留档
  - `radar_sync_log`：最近 500 次同步结果
- 上游密钥：`/etc/ai-dca/radar-proxy-key`（`X-Radar-Key`），CF IPv4：`RADAR_CACHE_CF_IPS`
- 健康检查：`curl -s 127.0.0.1:8084/healthz`

## supervisord（/etc/market-collector-supervisord.conf）

```ini
[program:ai-dca-radar-cache]
directory=/root/ai-dca/services/radar-cache
command=/usr/bin/env node server.mjs
environment=RADAR_CACHE_DB="/var/lib/ai-dca-radar-cache/radar.sqlite",RADAR_CACHE_PORT="8084",TZ="Asia/Shanghai"
user=root
autostart=true
autorestart=true
startsecs=5
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/ai-dca-radar-cache.log
stderr_logfile=/var/log/ai-dca-radar-cache.log
```

## nginx

```nginx
location = /api/notify/nasdaq-radar {
    auth_request /_rbac/nasdaq-radar;
    proxy_pass http://127.0.0.1:8084/api/notify/nasdaq-radar;
    proxy_read_timeout 60s;
}
location = /api/notify/nasdaq-radar/compute {
    auth_request /_rbac/nasdaq-radar-compute;
    proxy_pass http://127.0.0.1:8084/api/notify/nasdaq-radar/compute;
    proxy_read_timeout 160s;
}
```
