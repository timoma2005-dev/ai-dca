// 授予 VIP / SVIP 后，通知 cn-data 写站内信并按已配置渠道推送（见 services/cn-data/src/notify/roleNotice.js）。
// 不阻塞授予本身：失败只记日志。测试环境（node --test）与 AUTH_ROLE_NOTICE=0 时不发。
const NOTICE_ROLES = new Set(['vip', 'svip']);

export function roleNoticeUrl(env = process.env) {
  return `${String(env.CN_DATA_URL || 'http://127.0.0.1:8081').replace(/\/+$/, '')}/internal/role-notice`;
}

export function shouldSendRoleNotice(role, env = process.env) {
  if (String(env.AUTH_ROLE_NOTICE ?? '1') === '0' || env.NODE_TEST_CONTEXT) return false;
  return NOTICE_ROLES.has(String(role || '').toLowerCase());
}

export function notifyRoleGranted(db, granted = {}, { env = process.env, fetchImpl = fetch } = {}) {
  if (!granted?.userId || !shouldSendRoleNotice(granted.role, env)) return null;
  let username = '';
  try { username = db.prepare('SELECT username FROM users WHERE id = ?').get(granted.userId)?.username || ''; } catch { username = ''; }
  const payload = { userId: granted.userId, username, role: granted.role, expiresAt: granted.expiresAt || null };
  return fetchImpl(roleNoticeUrl(env), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then((r) => r.json().catch(() => ({})))
    .then((res) => { console.log('[role-notice]', JSON.stringify({ userId: granted.userId, role: granted.role, status: res?.status || res?.skipped || res?.message || '' })); return res; })
    .catch((err) => { console.error('[role-notice] failed', err?.message || err); return null; });
}
