import { readVerifiedNotifyAccount } from './notifyAccountAuth.js';
import { buildAccountClientId } from './clientSettings.js';
import { mergeAccountResourceNotifySettings, readAccountResourceNotifySettings } from './accountResourceSettings.js';
import { maskServerChan3SendKey } from './channels/serverChan3.js';
import { jsonResponse, readOrigin } from './notifyHttp.js';
import { AccountSettingsError } from './accountSettingsRoute.js';

function parse(payload) {
  try { const value = JSON.parse(payload || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

export async function handleAccountChannelToggle(request, env) {
  const account = readVerifiedNotifyAccount(request);
  const [, channel, action] = new URL(request.url).pathname.match(/^\/api\/notify\/channels\/(bark|serverchan3)\/(enable|disable)$/) || [];
  if (!channel) throw new AccountSettingsError('未找到通知接口', 404, 'NOT_FOUND');
  const db = env?.SYNC_DB;
  if (!db?.prepare || !db?.batch) throw new AccountSettingsError('通知账户存储暂不可用。', 503, 'AUTH_UNAVAILABLE');
  const clientId = buildAccountClientId(account.userId);
  const recordId = `${clientId}::${channel}`;
  const [row, resource] = await Promise.all([
    db.prepare(`SELECT payload FROM notify_user_records WHERE owner_user_id = ? AND record_type = 'client-channel' AND record_id = ?`)
      .bind(account.userId, recordId).first(),
    readAccountResourceNotifySettings(env, account.userId)
  ]);
  const previous = parse(row?.payload);
  const current = mergeAccountResourceNotifySettings(previous, resource);
  const bark = channel === 'bark';
  const deviceKey = String(current.barkDeviceKey || '').trim();
  const uid = String(current.serverChan3?.uid || '').trim();
  const sendKey = String(current.serverChan3?.sendKey || '').trim();
  const configured = bark ? Boolean(deviceKey) : Boolean(uid && sendKey);
  if (action === 'enable' && !configured) {
    throw new AccountSettingsError(bark ? '请先配置 Bark Device Key。' : '请先配置 Server酱 UID 和 SendKey。', 400,
      bark ? 'BARK_NOT_CONFIGURED' : 'SERVERCHAN3_NOT_CONFIGURED');
  }
  const enabled = configured && action === 'enable';
  const value = { ...previous, clientId, ...(bark ? { barkDeviceKey: deviceKey } : { serverChan3: { ...previous.serverChan3, uid, sendKey } }), enabled };
  const resourceValue = bark ? { barkDeviceKey: deviceKey, enabled } : { serverChan3Uid: uid, serverChan3SendKey: sendKey, enabled };
  const now = new Date().toISOString();
  // Both copies commit together: status prefers resources; CN reads enabled from
  // the replicated client-channel payload alongside the existing credentials.
  await db.batch([
    db.prepare(`INSERT INTO notify_user_records
      (owner_user_id, record_type, record_id, payload, revision, created_at, updated_at)
      VALUES (?, 'client-channel', ?, ?, 1, ?, ?)
      ON CONFLICT(owner_user_id, record_type, record_id) DO UPDATE SET
        payload = excluded.payload, revision = notify_user_records.revision + 1, updated_at = excluded.updated_at`)
      .bind(account.userId, recordId, JSON.stringify(value), now, now),
    db.prepare(`INSERT INTO account_resource_records
      (user_id, resource, record_id, parent_id, record_kind, position, revision, content_hash, bytes, payload, deleted, created_at, updated_at, updated_by_end_id, updated_by_end_type)
      VALUES (?, 'notify/client-config', ?, '', 'channel', 1, 1, '', ?, ?, 0, ?, ?, '', 'notify-compat')
      ON CONFLICT(user_id, resource, record_id) DO UPDATE SET
        payload = json_patch(account_resource_records.payload, excluded.payload),
        bytes = length(CAST(json_patch(account_resource_records.payload, excluded.payload) AS BLOB)),
        content_hash = '', revision = account_resource_records.revision + 1, deleted = 0,
        updated_at = excluded.updated_at, updated_by_end_id = '', updated_by_end_type = excluded.updated_by_end_type`)
      .bind(account.userId, `channel:${channel}`, new TextEncoder().encode(JSON.stringify(resourceValue)).length, JSON.stringify(resourceValue), now, now)
  ]);
  return jsonResponse({ ok: true, [bark ? 'bark' : 'serverChan3']: bark
    ? { deviceKey, enabled, configured }
    : { uid, sendKeyMasked: maskServerChan3SendKey(sendKey), configured, enabled }
  }, { origin: readOrigin(request) });
}
