// 浏览器直连「用户本机」的 MCP 服务（Streamable HTTP）。
// 券商/投资账本登录只留在用户电脑上，本站服务器不经手任何凭据与持仓原始数据。
// 只实现导入持仓所需的最小子集：initialize → notifications/initialized → tools/call。

const PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_TIMEOUT_MS = 30000;

export const LOCAL_MCP_DEFAULT_URL = 'http://127.0.0.1:8765/mcp';

export function normalizeLocalMcpUrl(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return '';
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!url.pathname || url.pathname === '/') url.pathname = '/mcp';
  return url.toString().replace(/\/$/, '');
}

function parseSsePayload(text, id) {
  // SSE：取 data 行里 id 匹配的 JSON-RPC 响应。
  const events = String(text || '').split(/\r?\n\r?\n/);
  let last = null;
  for (const block of events) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg && (msg.id === id || id === undefined)) return msg;
      last = msg;
    } catch {
      /* 非 JSON 事件忽略 */
    }
  }
  return last;
}

export async function parseRpcResponse(response, id) {
  const type = String(response.headers.get('content-type') || '');
  const text = await response.text();
  if (!text) return null;
  if (type.includes('text/event-stream')) return parseSsePayload(text, id);
  try {
    const msg = JSON.parse(text);
    if (Array.isArray(msg)) return msg.find((item) => item && item.id === id) || msg[0] || null;
    return msg;
  } catch {
    throw new Error(`本地 MCP 返回了无法解析的内容（HTTP ${response.status}）`);
  }
}

// MCP 工具结果：优先 structuredContent，其次 content[].text 中的 JSON。
export function extractToolPayload(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.isError) {
    const msg = Array.isArray(result.content)
      ? result.content.map((item) => item?.text || '').filter(Boolean).join(' ')
      : '';
    throw new Error(msg || '本地 MCP 工具返回错误');
  }
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object') {
    // FastMCP 对非 dict 返回值会包一层 { result: ... }
    if (Object.keys(structured).length === 1 && 'result' in structured) return structured.result;
    return structured;
  }
  const texts = Array.isArray(result.content) ? result.content.filter((item) => item?.type === 'text') : [];
  for (const item of texts) {
    try {
      return JSON.parse(item.text);
    } catch {
      /* 继续尝试下一段 */
    }
  }
  return texts.length ? texts.map((item) => item.text).join('\n') : null;
}

function describeFetchError(error, url) {
  if (error?.name === 'AbortError') return new Error('本地 MCP 响应超时，请确认服务在运行、投资账本已登录。');
  return new Error(`连不上 ${url}。请确认本机桥接服务已启动，且浏览器已允许本站访问本地网络。`);
}

export function createLocalMcpClient(rawUrl, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = normalizeLocalMcpUrl(rawUrl);
  if (!url) throw new Error('本地 MCP 地址格式不正确，例如 http://127.0.0.1:8765/mcp');
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  let sessionId = '';
  let nextId = 1;
  let initialized = false;

  async function post(body, { expectResponse = true } = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    let response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller?.signal,
        // Chrome 本地网络访问（LNA）：显式声明目标为本机。
        targetAddressSpace: 'loopback'
      });
    } catch (error) {
      throw describeFetchError(error, url);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const sid = response.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (!response.ok && response.status !== 202) {
      throw new Error(`本地 MCP 请求失败（HTTP ${response.status}）`);
    }
    if (!expectResponse) return null;
    const msg = await parseRpcResponse(response, body.id);
    if (!msg) throw new Error('本地 MCP 没有返回结果');
    if (msg.error) throw new Error(msg.error.message || '本地 MCP 返回错误');
    return msg.result;
  }

  async function initialize() {
    if (initialized) return;
    await post({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-dca-holdings-import', version: '1.0.0' }
      }
    });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectResponse: false });
    initialized = true;
  }

  async function callTool(name, args = {}) {
    await initialize();
    const result = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    return extractToolPayload(result);
  }

  async function listTools() {
    await initialize();
    const result = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  return { url, callTool, listTools };
}

// 本地 MCP 依赖电脑上运行的桥接服务，仅电脑端（非手机/平板、精确指针）开放。
export function isLocalMcpSupportedDevice(env = typeof window === 'undefined' ? null : window) {
  if (!env) return false;
  const nav = env.navigator || {};
  const ua = String(nav.userAgent || '');
  if (/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|MicroMessenger/i.test(ua)) return false;
  if (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1) return false; // iPadOS 桌面 UA
  try {
    if (typeof env.matchMedia === 'function' && !env.matchMedia('(pointer: fine)').matches) return false;
  } catch { /* 忽略 */ }
  return true;
}
