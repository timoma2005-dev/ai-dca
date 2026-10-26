// 持仓交易行 API：一条交易对应一个 REST 资源，不再 PUT 整个持仓快照。
// 每次交易行请求前都实时检查 migrations/legacy，避免任何调用方绕过迁移门禁。
// 统一复用 accountApi 的转发层出口（sendAccountApiRequest）：底层走 apiTransport 的 fetchWithGetRetry，
// 并自动登记 accountLoadingState 的统一加载态，因此本文件不再自行拼 base / fetch / 错误解析。
import { demoAccessToken } from './demo/demoMode.js';
import { loadCloudSession } from './authSession.js';
import { assertLegacyMigrationSettled, sendAccountApiRequest } from './accountApi.js';
import { assertLoginSyncWriteAllowed } from './loginSyncGate.js';

async function request(path, { method = 'GET', session = loadCloudSession(), body = null, headers = {}, signal, bypassLoginSyncGate = false } = {}) {
  const token = demoAccessToken(session?.accessToken || '');
  if (!token) throw new Error('请先登录账户');
  // 登录合并待确认：交易行写入在此统一拦截（不发请求）。
  if (method !== 'GET') assertLoginSyncWriteAllowed({ session, bypassLoginSyncGate });
  await assertLegacyMigrationSettled(session, { signal });
  return sendAccountApiRequest(path, { method, token, body, headers, signal });
}

export async function fetchHoldingTransactionRows({ cursor = '', limit = 500, signal } = {}, session = loadCloudSession()) {
  const params = new URLSearchParams();
  if (cursor !== '' && cursor !== null && cursor !== undefined) params.set('cursor', String(cursor));
  params.set('limit', String(Math.min(Math.max(Number(limit) || 500, 1), 1000)));
  return request(`/holdings/ledger/items?${params.toString()}`, { session, signal });
}

export async function fetchHoldingTransaction(transactionId, { signal = null } = {}, session = loadCloudSession()) {
  const id = encodeURIComponent(String(transactionId || '').trim());
  return request(`/holdings/ledger/items/${id}`, { session, signal });
}
export async function putHoldingTransaction(transactionId, data, { baseRevision = null, force = false, end = null, signal = null, bypassLoginSyncGate = false } = {}, session = loadCloudSession()) {
  const id = encodeURIComponent(String(transactionId || '').trim());
  const headers = {};
  if (!force && Number.isFinite(Number(baseRevision))) headers['if-match'] = `"${Number(baseRevision)}"`;
  return request(`/holdings/ledger/items/${id}`, {
    method: 'PUT',
    session,
    headers,
    body: { data, baseRevision: force ? null : baseRevision, force, end },
    signal,
    bypassLoginSyncGate
  });
}

export async function deleteHoldingTransaction(transactionId, { baseRevision = null, force = false, end = null, signal = null, bypassLoginSyncGate = false } = {}, session = loadCloudSession()) {
  const id = encodeURIComponent(String(transactionId || '').trim());
  const headers = {};
  if (!force && Number.isFinite(Number(baseRevision))) headers['if-match'] = `"${Number(baseRevision)}"`;
  return request(`/holdings/ledger/items/${id}`, {
    method: 'DELETE',
    session,
    headers,
    body: { baseRevision: force ? null : baseRevision, force, end },
    signal,
    bypassLoginSyncGate
  });
}
