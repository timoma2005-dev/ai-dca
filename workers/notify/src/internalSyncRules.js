import { receiveSync, required, dataOf, invalid, collectWrites } from '../../shared/internalSync.js';
import { ensureNotifyRowSchema, writeDurableUserJson } from './notifyRowStorage.js';

import { ensureNotifyFeatureSchema } from './notifyItemStorage.js';

const features = { 'holding-alert': 'holding-alerts', 'market-alert': 'market-alerts', preset: 'plans', plans: 'plans', dca: 'dca', 'dca-list': 'dca-list', 'holding-alerts': 'holding-alerts', 'market-alerts': 'market-alerts' };
export async function handleInternalSyncRules(request, env, origin = '*') {
  return receiveSync(request, env, 'SYNC_DB', ['upsert-rule', 'delete-rule', 'upsert-config'], async ({ eventType, payload: p }) => {
    const user = required(p.user_id, 'user_id');
    if (eventType === 'upsert-config') {
      const rawKey = required(p.config_key, 'config_key');
      const client = p.client_id || `account:${user}`;
      const key = rawKey === 'switch-config' ? `switch:config:${client}` : rawKey === 'holdings-rule' ? `holdings-rule:${client}` : rawKey;
      const data = dataOf(p, 'config_data');
      if (!env.NOTIFY_STATE) throw new Error('Missing NOTIFY_STATE');
      await ensureNotifyRowSchema(env);
      const collected = collectWrites(env.SYNC_DB);
      // Mirror durable keys to the D1 rows consumed by current readJson.
      await writeDurableUserJson({ ...env, SYNC_DB: collected.db, NOTIFY_STATE: undefined }, key, data);
      return { statements: collected.statements, beforeCommit: () => env.NOTIFY_STATE.put(key, JSON.stringify(data)) };
    }
    if (typeof p.client_id !== 'string') invalid('Invalid client_id');
    const client = p.client_id;
    const id = required(p.rule_id, 'rule_id');
    await ensureNotifyFeatureSchema(env);
    const db = env.SYNC_DB;
    if (eventType === 'delete-rule') return { statements: [db.prepare('DELETE FROM notify_user_feature_items WHERE owner_user_id = ? AND client_id = ? AND item_id = ?').bind(user, client, id)] };
    const feature = features[required(p.rule_type, 'rule_type')];
    if (!feature) invalid('Unknown rule_type');
    const data = dataOf(p, 'rule_data');
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('Invalid rule_data');
    if (p.enabled !== undefined && ![0, 1, true, false].includes(p.enabled)) invalid('Invalid enabled');
    const now = p.updated_at || new Date().toISOString();
    return { statements: [
      db.prepare('DELETE FROM notify_user_feature_items WHERE owner_user_id = ? AND client_id = ? AND item_id = ? AND feature != ?').bind(user, client, id, feature),
      db.prepare(`INSERT INTO notify_user_feature_items
      (owner_user_id, client_id, feature, item_id, kind, position, payload, revision, deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 1, 0, ?, ?)
      ON CONFLICT(owner_user_id, client_id, feature, item_id) DO UPDATE SET
      payload = excluded.payload, revision = notify_user_feature_items.revision + 1, deleted = 0, updated_at = excluded.updated_at`)
      .bind(user, client, feature, id, feature === 'dca' ? 'active' : 'item', JSON.stringify({ ...data, id, enabled: p.enabled === undefined ? true : Boolean(p.enabled) }), now, now)] };
  }, origin);
}
