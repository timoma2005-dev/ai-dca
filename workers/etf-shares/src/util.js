// etf-shares Worker 自带的小工具（原先从 ocr-proxy 的 fundLimit.js / ocrHttp.js 引用，
// 拆分后独立出来，避免把场外基金限额等无关逻辑打进 etf-shares 包）。

export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

export function emptyResponse(status = 204, extraHeaders = {}) {
  return new Response(null, {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

// 并发受限的 map：单项抛错记为 { __error }，不拖垮其它项。
export async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  const n = Math.max(1, Math.min(limit | 0 || 1, list.length));
  let cursor = 0;
  async function runner() {
    while (true) {
      const idx = cursor++;
      if (idx >= list.length) return;
      try {
        out[idx] = await worker(list[idx], idx);
      } catch (err) {
        out[idx] = { __error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  const runners = [];
  for (let i = 0; i < n; i += 1) runners.push(runner());
  await Promise.all(runners);
  return out;
}
