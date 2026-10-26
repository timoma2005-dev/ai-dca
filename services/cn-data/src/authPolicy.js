// 认证兜底策略开关。
//
// 背景：当共享的认证 SQLite（AUTH_DB_PATH）无法打开、或 RBAC 表尚未迁移时，
// 旧实现会 fail-open：resolveUserId 改为信任请求体/query 里的 user_id，
// rbacGuard 直接放行。这在生产环境等价于鉴权整体失效，可被用于横向越权。
//
// 安全默认值为 fail-closed：认证依赖不可用时拒绝请求，绝不信任客户端自报身份。
// 仅本地开发/测试（无认证库）时，显式设置 CN_DATA_AUTH_FAIL_OPEN=1 才保留旧兜底。
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function isAuthFailOpenEnabled(env = process.env) {
  return TRUTHY.has(String(env.CN_DATA_AUTH_FAIL_OPEN || '').trim().toLowerCase());
}
