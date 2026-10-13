# 前端 API 直连计划：用户相关请求绕过 cn 主机

## 背景

2026-10-12 实测：cn 主机 → `api.freebacktrack.tech`（Cloudflare Worker）的 TTFB 高达 16-18 秒，GET `/api/mc/health` 平均 18s，偶发 30s 超时。TCP 建连仅 2-3ms，慢在 Cloudflare 边缘回首字节，是国内出口到 CF 边缘的路径问题。

当前链路（用户相关请求）：
```
浏览器 → fast.freebacktrack.tech (CF) → cn 主机 (tunnel) → api.freebacktrack.tech (CF, 慢)
```

目标链路（用户相关请求）：
```
浏览器 → api.freebacktrack.tech (CF, 直接)
```

用户原话："别让cn主机直接调用cf worker了，改为前端根据 是否 是用户相关 来判断是否走 api直接调用"

## 用户相关 vs 非用户相关定义

**用户相关**（需要 Bearer token，用户私有数据，走 CF Worker）：
| 路径前缀 | Worker | 说明 |
|---|---|---|
| `/api/account/*` | account | 账户、交易、持仓账本 |
| `/api/sync/*` | sync | 登录、会话同步、分析事件同步 |
| `/api/notify/*` | notify | 通知规则、事件、开关、快照 |
| `/api/notify/ws/*` | notify | WebSocket 注册（经 wsApiUrl） |
| `/api/holdings/ocr` | ocr-proxy | 持仓截图 OCR |
| `/api/holdings/nav-history` | ocr-proxy | 持仓净值历史 |
| `/api/ocr` | ocr-proxy | 基金切换 OCR |

**非用户相关**（公开数据，cn 主机本地有，保持现状）：
| 路径前缀 | 当前去向 |
|---|---|
| `/api/markets/*` | cn 主机 127.0.0.1:18080 |
| `/api/market-collector/*` | cn 主机 127.0.0.1:18080 |
| `/api/fund-fee` | cn 主机 127.0.0.1:18080 |
| `/api/fund-limit` | cn 主机 127.0.0.1:18080 |
| `/api/geo` | 公共 Geo 查询（credentials: omit），保持经 `/api/` 代理 |

## 设计方案

### 1. `src/app/apiBase.js` 新增

```js
const DIRECT_API_ORIGIN = 'https://api.freebacktrack.tech';

// 用户相关路径前缀，走直连
const DIRECT_API_PREFIXES = [
  '/api/account/',
  '/api/sync/',
  '/api/notify/',
  '/api/holdings/',
  '/api/ocr',  // 精确匹配 /api/ocr（注意不是前缀，避免误伤）
];

export function isDirectApiPath(path = '') {
  const p = String(path || '');
  return DIRECT_API_PREFIXES.some(prefix =>
    prefix === '/api/ocr' ? (p === '/api/ocr' || p.startsWith('/api/ocr?')) : p.startsWith(prefix)
  );
}

// 直连版 apiUrl：user-related 请求用这个
export function apiUrlDirect(path = '', query = {}) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
  const url = new URL(normalizedPath, DIRECT_API_ORIGIN);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();  // 始终返回绝对 URL
}
```

注意：
- `apiUrl()` 保持不变（返回相对路径或同源绝对 URL），供非用户相关调用。
- `wsApiUrl()` 需要同步改造：如果是 direct 路径，返回 `wss://api.freebacktrack.tech/...`。

### 2. 调用点改造清单

| 文件 | 当前调用 | 改为 | 说明 |
|---|---|---|---|
| `src/app/accountApi.js` | `apiUrl('/api/account/v1')` | `apiUrlDirect('/api/account/v1')` | 用户账户数据 |
| `src/app/authClient.js` | `apiUrl('/api/sync')` | `apiUrlDirect('/api/sync')` | 登录/会话 |
| `src/app/analytics.js` | `apiUrl('/api/sync')` | `apiUrlDirect('/api/sync')` | 事件同步 |
| `src/app/notifySync.js` | `apiUrl(NOTIFY_ENDPOINT + path)` | `apiUrlDirect(...)` | 通知同步 |
| `src/app/switchStrategySync.js` | `apiUrl(NOTIFY_ENDPOINT + path)` | `apiUrlDirect(...)` | 策略同步 |
| `src/app/notifyWsClient.js` | `apiUrl(WS_CONNECT_URL)` 等 | `apiUrlDirect(...)` | WS 注册/注销 |
| `src/app/holdings.js` | `apiUrl('/api/holdings/ocr')` | `apiUrlDirect(...)` | 持仓 OCR |
| `src/app/navHistoryClient.js` | `apiUrl('/api/holdings/nav-history')` | `apiUrlDirect(...)` | 净值历史 |
| `src/app/fundSwitchOcr.js` | `apiUrl('/api/ocr')` | `apiUrlDirect(...)` | 切换 OCR |
| `src/app/switchStrategyTestSync.js` | `apiUrl('/api/notify/switch/test')` | `apiUrlDirect(...)` | 策略测试 |
| `src/pages/AdminRadarExperience.jsx` | `fetch('/api/notify/...')` | `fetch(apiUrlDirect('/api/notify/...'))` | 管理员雷达 |

**不改的**（非用户相关）：
- `src/app/marketsApi.js` → `/api/markets`, `/api/market-collector`, `/api/fund-fee`（cn 本地）
- `src/pages/markets/fundLimitListService.js` → `/api/fund-limit`（cn 本地）
- `src/app/regionEnvironment.js` → `/api/geo`（公共，保持代理）

### 3. CORS（已验证，无需改动）

三个 Worker 均已配置 CORS origin 反射：
- `workers/account/src/index.js:53-61`：`access-control-allow-origin: <request origin>`，允许 `authorization` 头
- `workers/sync/src/index.js:55`：同上
- `workers/notify/src/notifyHttp.js:16`：同上

前端用 `Authorization: Bearer` 头（非 cookie），无需 `credentials: include`，跨域直接可用。

### 4. cn 主机 nginx 变更

**保留** `/api/` catch-all 代理（不要删除）：
- 老版本前端（缓存的 HTML）仍会走 cn 代理
- `/api/geo` 等公共路径仍走代理
- 作为降级通道

可选优化（后续）：给 `/api/` 代理加更短的超时，避免慢请求拖住 nginx worker。但不删除。

### 5. 错误处理与降级

- 直连失败（网络错误/超时）时，**不自动回退到 cn 代理**（避免双重慢路径的复杂性）。直接向用户展示错误。
- 保持现有的 `AUTH_TIMEOUT`、`网络连接失败` 等错误文案不变。
- `apiUrlDirect` 始终返回绝对 URL，调用方无需改动 fetch 逻辑。

## 测试要求（按 AGENTS.md）

1. 新增 `test/apiBase.test.mjs`（或扩展现有）：
   - `isDirectApiPath('/api/account/v1/trades')` → true
   - `isDirectApiPath('/api/markets/quotes')` → false
   - `isDirectApiPath('/api/ocr')` → true
   - `isDirectApiPath('/api/ocr/extra')` → false（精确匹配）
   - `apiUrlDirect('/api/notify/status')` → `https://api.freebacktrack.tech/api/notify/status`
2. 回归：`marketsApi` 的调用仍走相对路径（不会调用直连）。
3. 运行：`node --test test/apiBase.test.mjs`、`npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`。

## 实施步骤

1. Codex 出详细 plan（本文件为纲要，Codex 补充边界 case）
2. Codely 实现：改 `apiBase.js` + 上表调用点
3. 测试、lint、refactor guard、`git diff --check`
4. 推送前 `git fetch` 确认远端 SHA
5. `scripts/deploy-unified.sh --target cn` 部署前端
6. fast 站验收：
   - 登录 → 通知设置页（走 `/api/notify/*` 直连，应秒开）
   - 持仓页（走 `/api/account/*` 直连）
   - 行情页（走 cn 本地，不受影响）
   - 浏览器 Network 面板确认 user-related 请求的 Host 为 `api.freebacktrack.tech`

## 风险

1. **用户浏览器到 CF 的速度**：用户也在国内，浏览器直连 CF 未必比 cn 主机快。但至少省掉一跳（tunnel + nginx 代理），且避免了 cn 主机特定的 16s TTFB。需验收时对比。
2. **OPTIONS 预检**：跨域 POST/PUT 会先发 OPTIONS，Worker 已处理（204）。首跳多一次 RTT，可接受。
3. **老前端缓存**：用户浏览器缓存的旧 HTML 仍走 cn 代理，逐渐过期后自然切换。无兼容问题。
4. **`VITE_API_ORIGIN` 非空时**：`apiUrl()` 返回绝对 URL 逻辑不变；`apiUrlDirect()` 始终用直连域名，不受影响。

## 不做的事

- 不删除 cn 主机 nginx 的 `/api/` 代理（保留降级）
- 不改 Worker 侧代码（CORS 已就绪）
- 不改认证方式（仍用 Bearer 头）
