/**
 * 纳指雷达单一 client（plan §5.2）：
 * - GET 保留 apiUrlWithFallback / fetchWithFallback 读取降级、redirect manual 并拒绝重定向，不带 credentials。
 * - memory / inflight 按解析后的 API 地址隔离；短 TTL 60 秒；错误与空结果不冒充成功数据。
 * - POST 仅由管理员确认事件触发：保持 apiUrl 单次 POST，无自动 fallback / 自动重试；
 *   成功要求 HTTP 正常、ok:true 且 data 可消费，直接用返回值写 memory，并使提交前的 GET 代次失效。
 */
import { apiUrl, apiUrlWithFallback, fetchWithFallback } from './apiBase.js';
import { validateRadarSnapshot } from './radarModel.js';

export const RADAR_TTL_MS = 60000;
export const RADAR_GET_URLS = apiUrlWithFallback('/api/notify/nasdaq-radar');
export const RADAR_COMPUTE_URL = apiUrl('/api/notify/nasdaq-radar/compute');

function isRedirectResponse(response) {
  return response?.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

async function rejectRedirect(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* redirect remains rejected */
  }
  throw Error('redirect_rejected');
}

export function createRadarClient({
  getUrls = RADAR_GET_URLS,
  computeUrl = RADAR_COMPUTE_URL,
  fetchImpl = (...args) => fetch(...args),
  fallbackFetchImpl = fetchWithFallback,
  now = () => Date.now(),
  ttlMs = RADAR_TTL_MS
} = {}) {
  // 缓存 key 只由解析后的请求地址决定；响应内容（code/source 等）不得改变 key。
  const cacheKey = String(getUrls?.primary || computeUrl || 'nasdaq-radar');
  const memory = new Map();
  const inflight = new Map();
  // 写入代次：POST 成功 +1，提交前启动的 GET 结果按 superseded 丢弃，不写回 memory / 组件状态。
  let generation = 0;
  let postInflight = null;

  function cachedResult() {
    const entry = memory.get(cacheKey);
    if (!entry || now() - entry.receivedAt >= ttlMs) return null;
    if (entry.data == null) return { state: 'empty', receivedAt: entry.receivedAt };
    return { state: 'ready', data: entry.data, receivedAt: entry.receivedAt };
  }

  /**
   * 订阅读取：memory 命中零 fetch；同 key 共享 inflight；零消费者时才 abort，
   * 单个订阅卸载不影响其它订阅的共享请求；StrictMode effect 重建复用 pending GET。
   * refresh 仅限明确刷新入口（重试 / 重新读取核实）：跳过 memory 直读网络，但普通渲染不得使用。
   */
  function subscribe({ enabled = true, refresh = false } = {}) {
    if (!enabled) {
      return { promise: Promise.resolve({ state: 'idle' }), release() {} };
    }
    const hit = refresh ? null : cachedResult();
    if (hit) {
      return { promise: Promise.resolve(hit), release() {} };
    }
    let task = inflight.get(cacheKey);
    if (task?.controller.signal.aborted) task = null;
    if (!task) {
      const controller = new AbortController();
      const taskGeneration = generation;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15000);
      task = { controller, consumers: 0 };
      task.promise = (async () => {
        try {
          const response = await fallbackFetchImpl(getUrls, { signal: controller.signal, redirect: 'manual' });
          if (isRedirectResponse(response)) await rejectRedirect(response);
          if (!response.ok) throw Error('http_error');
          const json = await response.json().catch(() => {
            throw Error('invalid_json');
          });
          if (!json || typeof json !== 'object' || Array.isArray(json)) throw Error('invalid_json');
          // 兼容历史 GET 缺 ok 但有有效 data 的返回；显式 ok:false 必须视为失败。
          if (json.ok === false) throw Error('business_error');
          const data = json.data == null ? null : json.data;
          if (data == null) {
            if (taskGeneration === generation) memory.set(cacheKey, { receivedAt: now(), data: null });
            return { state: 'empty', receivedAt: now() };
          }
          if (!validateRadarSnapshot(data)) throw Error('invalid_snapshot');
          if (taskGeneration !== generation) return { state: 'superseded' };
          const receivedAt = now();
          memory.set(cacheKey, { receivedAt, data });
          return { state: 'ready', data, receivedAt };
        } catch (error) {
          if (controller.signal.aborted && !timedOut) return { state: 'aborted' };
          if (controller.signal.aborted) return { state: 'error', reason: 'timeout' };
          return { state: 'error', reason: error?.message || 'network' };
        } finally {
          clearTimeout(timer);
          if (inflight.get(cacheKey) === task) inflight.delete(cacheKey);
        }
      })();
      inflight.set(cacheKey, task);
    }
    task.consumers += 1;
    let released = false;
    return {
      promise: task.promise,
      release() {
        if (released) return;
        released = true;
        task.consumers -= 1;
        setTimeout(() => {
          if (!task.consumers && inflight.get(cacheKey) === task) task.controller.abort();
        }, 0);
      }
    };
  }

  /**
   * 手动计算（单次 POST）：不自动重试、不走 fallback 副本；超时/失败只代表
   * “结果未确认”。成功原子替换数据并写 memory，不做额外 GET。
   */
  function compute() {
    if (postInflight) return postInflight;
    postInflight = (async () => {
      const UNCONFIRMED = '结果未确认，请重新读取核实';
      try {
        const response = await fetchImpl(computeUrl, { method: 'POST', redirect: 'manual' });
        if (isRedirectResponse(response)) {
          await rejectRedirect(response).catch(() => {});
          return { state: 'failure', message: UNCONFIRMED, reason: 'redirect_rejected' };
        }
        if (!response.ok) return { state: 'failure', message: UNCONFIRMED, reason: 'http_error' };
        const json = await response.json().catch(() => null);
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          return { state: 'failure', message: UNCONFIRMED, reason: 'invalid_json' };
        }
        // POST 成功严格要求 ok:true；ok:true/data:null 显示“无有效结果”，不报成功。
        if (json.ok !== true) {
          return { state: 'failure', message: UNCONFIRMED, reason: json.error || 'business_error' };
        }
        const data = json.data == null ? null : json.data;
        if (data == null) {
          return { state: 'no-result', message: '计算已执行但未返回有效结果，请重新读取核实' };
        }
        if (!validateRadarSnapshot(data)) {
          return { state: 'failure', message: UNCONFIRMED, reason: 'invalid_snapshot' };
        }
        generation += 1;
        const receivedAt = now();
        memory.set(cacheKey, { receivedAt, data });
        return { state: 'success', data, receivedAt, message: '已强制计算并写入正式快照' };
      } catch (error) {
        return { state: 'failure', message: UNCONFIRMED, reason: error?.name === 'AbortError' ? 'aborted' : error?.message || 'network' };
      } finally {
        postInflight = null;
      }
    })();
    return postInflight;
  }

  return {
    subscribe,
    compute,
    /** 供测试观察：当前缓存 key 与内容。 */
    inspect() {
      return { cacheKey, generation, memory: memory.get(cacheKey) ?? null };
    }
  };
}

export const radarClient = createRadarClient();
