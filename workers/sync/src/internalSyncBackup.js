import { receiveSync, required, dataOf, invalid, sha256Hex } from '../../shared/internalSync.js';

export async function handleInternalSyncBackup(request, env, origin = '*', initialize = async () => {}) {
  return receiveSync(request, env, 'DB', ['upsert-backup'], async ({ payload: p }) => {
    await initialize();
    const user = required(p.user_id, 'user_id');
    if (!Number.isSafeInteger(p.version) || p.version < 1) invalid('Invalid version');
    const data = dataOf(p, 'backup_data');
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('Invalid backup_data');
    const envelope = data.encryptedEnvelope || data;
    const encoded = JSON.stringify(envelope);
    const current = await env.DB.prepare('SELECT kv_key FROM backups WHERE user_id = ?').bind(user).first();
    const key = current?.kv_key || `backup:${user}`;
    return { statements: [env.DB.prepare(`INSERT INTO backups
      (user_id, version, kv_key, updated_at, key_count, bytes, content_hash, envelope, cipher_sha256, last_end_id, last_end_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at,
      key_count = excluded.key_count, bytes = excluded.bytes, content_hash = excluded.content_hash,
      envelope = excluded.envelope, cipher_sha256 = excluded.cipher_sha256,
      last_end_id = excluded.last_end_id, last_end_type = excluded.last_end_type`)
      .bind(user, p.version, key, p.updated_at || new Date().toISOString(), Number(envelope.meta?.keyCount) || 0, encoded.length, String(envelope.meta?.contentHash || ''), encoded, await sha256Hex(encoded), String(data.end?.id || ''), String(data.end?.type || ''))],
    beforeCommit: env.SYNC_BACKUPS ? () => env.SYNC_BACKUPS.put(key, encoded) : undefined };
  }, origin);
}
