// 演示模式的轻量开关（无依赖，供各 API 客户端判断）。完整演示框架见 ./featureDemo.js。
export const DEMO_ACTIVE_FLAG = '__AI_DCA_FEATURE_DEMO__';
// 游客演示时 API 客户端用的占位令牌：带着它的请求只会命中 mock 路由，演示框架不会把它发到真实服务器。
export const DEMO_ACCESS_TOKEN = 'feature-demo-token';

export function isFeatureDemoActive(win = globalThis.window) {
  return Boolean(win && win[DEMO_ACTIVE_FLAG]);
}

/** 有真实令牌用真实令牌；没有且处于演示中时返回占位令牌，让客户端照常发请求（被演示 fetch 接住）。 */
export function demoAccessToken(token = '') {
  const value = String(token || '').trim();
  if (value) return value;
  return isFeatureDemoActive() ? DEMO_ACCESS_TOKEN : '';
}
