// cn-data notify Phase 2 routes: port of the notify worker's account-scoped
// endpoints to synchronous node:sqlite (docs/plan-all-routes-to-cn.md Phase 2):
//   GET /api/notify/status (?view=summary|details)
//   GET /api/notify/events
//   GET/POST /api/notify/holdings-rule
//
// Ports:
// - workers/notify/src/accountReadRoutes.js (handleAccountStatus, handleAccountEvents)
// - workers/notify/src/accountRuleRoutes.js (handleFastHoldingsRule)
// - workers/notify/src/accountResourceSettings.js (resource-backed channel merge)
// - workers/notify/src/channels/email.js (normalizeEmailConfig/maskEmailAddress)
// - workers/notify/src/channels/serverChan3.js (maskServerChan3SendKey)
// - workers/notify/src/holdingsNavSupport.js (normalizeHoldingsDigest)
//
// Auth: Bearer session tokens are validated via authSession.resolveUserId,
// the same pattern as /api/account/v1/* routes. Error responses keep the
// notify worker's shape ({ error: message, code }) because the frontend
// (src/app/notifySync.js requestNotify) reads payload.code.
//
// Response bodies are kept byte-identical to the notify worker for the
// account paths because the frontend normalizers
// (normalizeNotifyStatusSummary, normalizeNotifyStatusDetails,
// webNotifyClient, useHoldingsDailyPush) depend on them.
//
// Data sources in cn-data:
// - notify_user_records: replica of the worker's D1 table (migration 003).
//   Holds event / delivery-failure / registration rows plus legacy
//   client / client-channel / client-meta records.
// - account_resource_records: canonical channel settings (resource
//   'notify/client-config'), read first; notify_user_records is the fallback.
// - notify_configs (config_key 'holdings-rule'): holdings-rule storage, the
//   same key the CF->CN migration wrote (scripts/migrate-cf-to-cn/migration.mjs).
//
// Outbox policy: holdings-rule writes upsert notify_configs and enqueue a
// 'notify'/'upsert-config' event inside the same transaction, matching what
// workers/notify/src/internalSyncRules.js consumes ('holdings-rule' is mapped
// back to `holdings-rule:account:<user>` there).
//
// /api/notify/email/* is intentionally NOT handled here (stays on CF).

import { HttpError, resolveUserId } from '../authSession.js';
import { nowIso, withTransaction } from '../db.js';
import { enqueueEvent } from '../outbox.js';

const HOLDINGS_RULE_CONFIG_KEY = 'holdings-rule';
const CLIENT_CONFIG_RESOURCE = 'notify/client-config';

const baseHeaders = {
  'cache-control': 'no-store',
  'access-control-expose-headers': 'etag, x-resource-revision'
};

function ok(body, headers = {}) {
  return { status: 200, body, headers: { ...baseHeaders, ...headers } };
}

function fail(error) {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.message, code: error.code }, headers: baseHeaders };
  console.error('[cn-data notify] 未处理异常', error);
  return { status: 500, body: { error: '服务异常，请稍后重试', code: 'INTERNAL_ERROR' }, headers: baseHeaders };
}

// --- small helpers (ports of worker locals) ---

function text(value = '', max = 240) { return String(value ?? '').trim().slice(0, max); }
function parse(value, fallback = {}) { try { const data = JSON.parse(String(value || '')); return data && typeof data === 'object' ? data : fallback; } catch { return fallback; } }

function normalizeNotifyUserId(value = '') { return String(value || '').trim().replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 96); }
function buildAccountClientId(userId = '') {
  const id = normalizeNotifyUserId(userId);
  return id ? String(`account:${id}`).trim().slice(0, 120) : '';
}

function maskServerChan3SendKey(value = '') {
  const normalized = String(value || '').trim();
  return normalized ? `${normalized.slice(0, 6)}...${normalized.slice(-4)}` : '';
}

function normalizeEmailAddress(value = '') {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function normalizeEmailConfig(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const address = normalizeEmailAddress(input.address || '');
  const verified = Boolean(address && input.verified);
  return {
    address,
    verified,
    verifiedAt: verified ? String(input.verifiedAt || '').trim() : '',
    enabled: Boolean(verified && input.enabled)
  };
}

function maskEmailAddress(value = '') {
  const email = normalizeEmailAddress(value);
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!local || !domain) return '';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.min(Math.max(local.length - visible.length, 2), 6))}@${domain}`;
}

function normalizeHoldingsDigest(digest) {
  const result = { version: 1, generatedAt: '', exchange: [], otc: [] };
  if (!digest || typeof digest !== 'object') return result;
  if (digest.generatedAt) result.generatedAt = String(digest.generatedAt);
  let totalWeight = 0;
  for (const bucket of ['exchange', 'otc']) {
    const list = Array.isArray(digest[bucket]) ? digest[bucket] : [];
    for (const entry of list) {
      const code = String(entry?.code || '').trim();
      const weight = Number(entry?.weight);
      const rawKind = String(entry?.kind || bucket).trim().toLowerCase();
      const kind = rawKind === 'exchange' || rawKind === 'otc' || rawKind === 'qdii' ? rawKind : bucket;
      if (!/^\d{6}$/.test(code)) continue;
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1) continue;
      result[bucket].push({ code, weight, kind });
      totalWeight += weight;
    }
  }
  // 软限制：总权重 ≤ 1.5（两个 bucket 各自合计 ≤ 1，上限考虑取整冗余）
  if (totalWeight > 1.5) return result;
  return result;
}

// --- account resource notify settings (port of accountResourceSettings.js) ---

function resourceText(value = '', max = 5000) { return String(value ?? '').trim().slice(0, max); }

function readAccountResourceNotifySettings(db, userId) {
  const owner = resourceText(userId, 96);
  if (!owner) return null;
  const rows = db.prepare(`SELECT record_id, payload, deleted FROM account_resource_records
    WHERE user_id = ? AND resource = ? ORDER BY position ASC, record_id ASC`).all(owner, CLIENT_CONFIG_RESOURCE);
  if (!rows.length) return null;
  const settings = { barkDeviceKey: '', serverChan3: {}, email: {} };
  let meta = {};
  const channels = new Set();
  for (const row of rows) {
    const id = String(row?.record_id || '');
    if (id.startsWith('channel:')) channels.add(id);
    if (Number(row?.deleted || 0) === 1) continue;
    const value = parse(row?.payload);
    if (id === '__meta__') {
      meta = value;
    } else if (id === 'channel:bark') {
      settings.barkDeviceKey = resourceText(value.barkDeviceKey, 512);
    } else if (id === 'channel:serverchan3') {
      settings.serverChan3 = {
        uid: resourceText(value.serverChan3Uid || value.serverChan3?.uid, 240),
        sendKey: resourceText(value.serverChan3SendKey || value.serverChan3?.sendKey, 512)
      };
    } else if (id === 'channel:email') {
      settings.email = value.email && typeof value.email === 'object' ? value.email : value;
    }
  }
  return { settings, meta, channels, hasResource: true };
}

function mergeAccountResourceNotifySettings(base = {}, resource = null) {
  if (!resource?.hasResource) return base;
  const settings = resource.settings || {};
  const channels = resource.channels instanceof Set ? resource.channels : new Set();
  return {
    ...base,
    ...resource.meta,
    ...(channels.has('channel:bark') ? { barkDeviceKey: resourceText(settings.barkDeviceKey || '', 512) } : {}),
    ...(channels.has('channel:serverchan3') ? { serverChan3: settings.serverChan3 && typeof settings.serverChan3 === 'object' ? settings.serverChan3 : {} } : {}),
    ...(channels.has('channel:email') ? { email: settings.email && typeof settings.email === 'object' ? settings.email : {} } : {})
  };
}

// --- notify_user_records access (replica of the worker's D1 table) ---

function recordRows(db, owner, type, limit = 64) {
  return db.prepare(`SELECT record_id, payload FROM notify_user_records
    WHERE owner_user_id = ? AND record_type = ? ORDER BY updated_at DESC LIMIT ?`).all(owner, type, limit);
}

function parseValue(row) { return parse(row?.payload)?.value; }

// --- auth ---

function resolveAccount(url, body, headers) {
  const { id, username } = resolveUserId(url, body, headers);
  const userId = normalizeNotifyUserId(id);
  const accountUsername = text(username, 48).toLowerCase();
  if (!userId || !accountUsername) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录账户。');
  return { userId, username: accountUsername, clientId: buildAccountClientId(userId) };
}

// --- GET /api/notify/status ---

function handleStatusSummary(db, account) {
  const resourceSettings = readAccountResourceNotifySettings(db, account.userId);
  const ids = [`${account.clientId}::bark`, `${account.clientId}::serverchan3`, `${account.clientId}::email`];
  const records = db.prepare(`SELECT record_type, record_id, payload FROM notify_user_records
    WHERE owner_user_id = ? AND ((record_type = 'client' AND record_id = ?)
    OR (record_type = 'client-channel' AND record_id IN (?, ?, ?))
    OR (record_type = 'client-meta' AND record_id = ?))`)
    .all(account.userId, account.clientId, ...ids, account.clientId);
  const counts = db.prepare(`SELECT SUM(record_type='event') event_count,
    SUM(record_type='delivery-failure') failure_count,
    SUM(record_type='registration') registration_count
    FROM notify_user_records WHERE owner_user_id = ?`).get(account.userId) || {};
  const state = { client: {}, meta: {}, bark: '', server: {}, email: {} };
  for (const row of records) {
    const value = parse(row.payload);
    if (row.record_type === 'client') state.client = value;
    else if (row.record_type === 'client-meta') state.meta = value;
    else if (String(row.record_id).endsWith('::bark')) state.bark = text(value.barkDeviceKey);
    else if (String(row.record_id).endsWith('::serverchan3')) state.server = value.serverChan3 || {};
    else if (String(row.record_id).endsWith('::email')) state.email = value.email || {};
  }
  if (resourceSettings?.hasResource) {
    const merged = mergeAccountResourceNotifySettings({
      ...state.client,
      ...state.meta,
      barkDeviceKey: state.bark,
      serverChan3: state.server,
      email: state.email
    }, resourceSettings);
    state.client = { ...state.client, ...resourceSettings.meta };
    state.bark = text(merged.barkDeviceKey);
    state.server = merged.serverChan3 || {};
    state.email = merged.email || {};
  }
  const email = normalizeEmailConfig(state.email);
  const registrationCount = Number(counts?.registration_count) || 0;
  return ok({
    ok: true,
    schemaVersion: 1,
    data: {
      account: {
        clientId: account.clientId,
        accountClientId: account.clientId,
        username: account.username,
        label: text(state.client.clientLabel) || `账号通知 · ${account.username}`,
        notifyGroupId: account.clientId
      },
      channels: {
        bark: { configured: Boolean(state.bark), deviceKey: state.bark },
        serverChan3: {
          uid: text(state.server.uid),
          sendKeyMasked: maskServerChan3SendKey(state.server.sendKey || ''),
          configured: Boolean(text(state.server.uid) && text(state.server.sendKey))
        },
        email: {
          maskedAddress: maskEmailAddress(email.address),
          verified: Boolean(email.verified),
          verifiedAt: text(email.verifiedAt) || null,
          enabled: Boolean(email.enabled),
          configured: Boolean(email.address && email.verified && email.enabled)
        },
        webWs: { configured: registrationCount > 0 }
      },
      rules: {
        planRuleCount: Number(state.meta?.counts?.planRuleCount) || 0,
        dcaRuleCount: Number(state.meta?.counts?.dcaRuleCount) || 0,
        totalRuleCount: Number(state.meta?.counts?.totalRuleCount) || 0
      },
      timestamps: {
        lastSyncedAt: text(state.meta.lastSyncedAt) || null,
        lastCheckedAt: text(state.meta.lastCheckedAt) || null,
        lastTestedAt: text(state.meta.lastTestedAt) || null
      },
      delivery: {
        eventCount: Number(counts?.event_count) || 0,
        failureCount: Number(counts?.failure_count) || 0
      },
      webSockets: {
        groupId: account.clientId,
        groupMemberCount: registrationCount,
        registrationCount,
        currentClientId: account.clientId,
        currentClientRegistrationCount: registrationCount,
        pairedRegistrationCount: registrationCount,
        unpairedRegistrationCount: 0
      }
    }
  });
}

function handleStatusDetails(db, account) {
  const events = recordRows(db, account.userId, 'event', 30).map(parseValue).filter(Boolean);
  const failures = recordRows(db, account.userId, 'delivery-failure', 30).map(parseValue).filter(Boolean);
  const registrations = recordRows(db, account.userId, 'registration', 64).map((row) => parse(row?.payload)).filter(Boolean);
  const current = registrations.filter((item) => (item.pairedClients || [])
    .some((paired) => paired.groupId === account.clientId || paired.clientId === account.clientId));
  return ok({
    ok: true,
    schemaVersion: 1,
    data: {
      account: { clientId: account.clientId, accountClientId: account.clientId },
      delivery: {
        eventCount: events.length,
        lastEvent: events[0] || null,
        failureCount: failures.length,
        failures
      },
      webSockets: {
        groupMemberClientIds: current.flatMap((item) => (item.pairedClients || []).map((paired) => paired.clientId)).filter(Boolean),
        registrations,
        currentClientRegistrations: current
      }
    }
  });
}

// --- GET /api/notify/events ---

function handleEvents(db, account) {
  const events = recordRows(db, account.userId, 'event', 30).map(parseValue).filter(Boolean);
  return ok({ events });
}

// --- GET/POST /api/notify/holdings-rule ---

function readHoldingsRule(db, userId) {
  const row = db.prepare('SELECT * FROM notify_configs WHERE user_id = ? AND config_key = ?')
    .get(userId, HOLDINGS_RULE_CONFIG_KEY);
  if (!row) return null;
  try {
    const value = JSON.parse(row.payload);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function holdingsRuleResponse(stored) {
  return stored
    ? { enabled: Boolean(stored.enabled), digest: stored.digest || null, updatedAt: stored.updatedAt || '' }
    : { enabled: false, digest: null, updatedAt: '' };
}

function handleHoldingsRuleGet(db, account) {
  return ok(holdingsRuleResponse(readHoldingsRule(db, account.userId)));
}

function handleHoldingsRulePost(db, account, body) {
  const now = nowIso();
  const value = {
    enabled: Boolean(body?.enabled),
    digest: normalizeHoldingsDigest(body?.digest),
    updatedAt: now,
    clientLabel: `账号通知 · ${account.username}`,
    accountUsername: account.username
  };
  const row = withTransaction(db, () => {
    db.prepare(`INSERT INTO notify_configs(user_id, config_key, payload, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, config_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(account.userId, HOLDINGS_RULE_CONFIG_KEY, JSON.stringify(value), now);
    const saved = db.prepare('SELECT * FROM notify_configs WHERE user_id = ? AND config_key = ?')
      .get(account.userId, HOLDINGS_RULE_CONFIG_KEY);
    enqueueEvent(db, 'notify', 'upsert-config', { ...saved, payload: JSON.parse(saved.payload) });
    return saved;
  });
  return ok(holdingsRuleResponse(JSON.parse(row.payload)));
}

// --- router ---

export function handleNotifyRoute(db, method, url, body, headers) {
  const path = url.pathname;
  if (path !== '/api/notify/status' && path !== '/api/notify/events' && path !== '/api/notify/holdings-rule') return null;
  if (path === '/api/notify/holdings-rule') {
    if (method !== 'GET' && method !== 'POST') return { status: 405, body: { message: 'Method not allowed' }, headers: baseHeaders };
  } else if (method !== 'GET') {
    return { status: 405, body: { message: 'Method not allowed' }, headers: baseHeaders };
  }
  try {
    const account = resolveAccount(url, body, headers);
    if (path === '/api/notify/status') {
      return url.searchParams.get('view') === 'details'
        ? handleStatusDetails(db, account)
        : handleStatusSummary(db, account);
    }
    if (path === '/api/notify/events') return handleEvents(db, account);
    return method === 'POST'
      ? handleHoldingsRulePost(db, account, body)
      : handleHoldingsRuleGet(db, account);
  } catch (error) {
    return fail(error);
  }
}
