import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readJson,
  readSettings,
  writeJson,
  writeSettings
} from '../workers/notify/src/notifyStorage.js';

function createMemoryKv(seed = {}) {
  const memory = new Map(Object.entries(seed));
  return {
    async get(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    async put(key, value) {
      memory.set(key, String(value));
    },
    async list({ prefix = '' } = {}) {
      return {
        keys: Array.from(memory.keys())
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true
      };
    }
  };
}

function createMemoryD1() {
  const rows = new Map();
  const rowKey = (owner, type, id) => `${owner}\u0000${type}\u0000${id}`;
  const getTimestamp = (payload = {}) => [
    payload.updatedAt,
    payload.syncedAt,
    payload.computedAt,
    payload.generatedAt,
    payload.createdAt,
    payload.lastFailedAt,
    payload.lastAckAt
  ].find((value) => String(value || '').trim()) || '';

  function parsePayload(value) {
    try {
      return JSON.parse(String(value || '{}'));
    } catch (_) {
      return {};
    }
  }

  function execute(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
      return { changes: 0 };
    }
    if (normalized.startsWith('DELETE FROM notify_user_records')) {
      const recordType = normalized.includes("record_type = 'registration'") ? 'registration' : '';
      const recordId = params[0];
      for (const [key, row] of rows) {
        if ((!recordType || row.record_type === recordType) && row.record_id === recordId) rows.delete(key);
      }
      return { changes: 1 };
    }
    if (normalized.startsWith("INSERT INTO notify_user_records") && normalized.includes("VALUES ('global', 'migration', ?, ?, 1, ?, ?)")) {
      const [id, payloadText, createdAt, updatedAt] = params;
      const key = rowKey('global', 'migration', id);
      const existing = rows.get(key);
      rows.set(key, {
        owner_user_id: 'global',
        record_type: 'migration',
        record_id: id,
        payload: String(payloadText || '{}'),
        revision: existing ? Number(existing.revision || 1) + 1 : 1,
        created_at: existing?.created_at || createdAt,
        updated_at: updatedAt
      });
      return { changes: 1 };
    }
    if (normalized.startsWith('INSERT')) {
      const [owner, type, id, payloadText, createdAt, updatedAt] = params;
      const key = rowKey(owner, type, id);
      const existing = rows.get(key);
      if (existing && normalized.includes('OR IGNORE')) return { changes: 0 };
      const payload = parsePayload(payloadText);
      if (existing && normalized.includes('json_extract')) {
        const incomingTimestamp = getTimestamp(payload);
        const existingTimestamp = getTimestamp(parsePayload(existing.payload));
        if (incomingTimestamp && existingTimestamp && incomingTimestamp < existingTimestamp) {
          return { changes: 0 };
        }
      }
      rows.set(key, {
        owner_user_id: owner,
        record_type: type,
        record_id: id,
        payload: JSON.stringify(payload),
        revision: existing ? Number(existing.revision || 1) + 1 : 1,
        created_at: existing?.created_at || createdAt,
        updated_at: updatedAt
      });
      return { changes: 1 };
    }
    throw new Error(`Unsupported fake D1 SQL: ${normalized}`);
  }

  function select(sql, params = {}) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.includes("WHERE owner_user_id = 'global' AND record_type = 'migration' AND record_id = ?")) {
      const row = rows.get(rowKey('global', 'migration', params[0]));
      return row ? { payload: row.payload } : null;
    }
    if (normalized.startsWith('SELECT * FROM notify_user_feature_items')) return [];
    if (normalized.startsWith('SELECT * FROM notify_registration_links')) return [];
    // 写路径只取键列（不含 payload）的裁剪查询，与上面的全列查询同样按空表处理。
    if (normalized.startsWith('SELECT owner_user_id, client_id, feature, item_id')) return [];
    if (normalized.startsWith('SELECT owner_user_id, registration_id, client_id')) return [];
    if (normalized.includes('WHERE owner_user_id = ? AND record_type = ? AND record_id = ?')) {
      const row = rows.get(rowKey(params[0], params[1], params[2]));
      return row ? { ...row } : null;
    }
    if (normalized.includes("WHERE owner_user_id = ? AND record_type = 'user-kv' AND record_id = ?")) {
      const row = rows.get(rowKey(params[0], 'user-kv', params[1]));
      return row ? { payload: row.payload } : null;
    }
    if (normalized.includes("WHERE record_type = 'user-kv' AND record_id LIKE ?")) {
      const prefix = String(params[0] || '').replace(/%$/, '');
      return Array.from(rows.values())
        .filter((row) => row.record_type === 'user-kv' && row.record_id.startsWith(prefix))
        .map((row) => ({ record_id: row.record_id }));
    }
    if (normalized.startsWith('SELECT owner_user_id')) return Array.from(rows.values()).map((row) => ({ ...row }));
    throw new Error(`Unsupported fake D1 SELECT: ${normalized}`);
  }

  return {
    prepare(sql) {
      const executeBound = (params) => ({
        async run() { return execute(sql, params); },
        async first() { return select(sql, params); },
        async all() { return { results: select(sql, params) || [] }; }
      });
      return {
        bind(...params) { return executeBound(params); },
        async run() { return execute(sql, []); },
        async first() { return select(sql, []); },
        async all() { return { results: select(sql, []) || [] }; }
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
    },
    dumpRows() {
      return Array.from(rows.values()).map((row) => ({ ...row }));
    }
  };
}

function createEnv(settings = {}) {
  return {
    NOTIFY_STATE: createMemoryKv({
      'notify:settings': JSON.stringify(settings)
    }),
    SYNC_DB: createMemoryD1()
  };
}

function makeClient(overrides = {}) {
  return {
    clientId: 'web:row-test',
    clientLabel: 'Row test',
    ownerUserId: 'usr-row-test',
    accountClientId: 'account:usr-row-test',
    notifyGroupId: 'account:usr-row-test',
    clientSecretHash: 'hash',
    barkDeviceKey: '',
    serverChan3: {},
    email: {},
    payload: {
      plans: [],
      dca: null,
      dcaList: [],
      marketAlerts: [],
      holdingAlerts: [],
      syncedAt: '2026-09-10T06:00:00.000Z'
    },
    state: {
      ruleStates: {},
      deliveryFailures: {},
      recentEvents: [],
      deliveryAcks: {},
      lastRunAt: ''
    },
    meta: { counts: {}, lastSyncedAt: '', lastCheckedAt: '', lastTestedAt: '' },
    ...overrides
  };
}

test('legacy notify settings migrate into independently addressable rows', async () => {
  const legacy = {
    clients: {
      'web:row-test': makeClient({
        barkDeviceKey: 'bark-device',
        email: { address: 'row@example.com', verified: true, enabled: true },
        state: {
          ruleStates: { 'rule-1': { lastTriggeredAt: '2026-09-10T06:00:00.000Z' } },
          deliveryFailures: {},
          recentEvents: [{ id: 'event-1', createdAt: new Date(Date.now() - 60 * 1000).toISOString() }],
          deliveryAcks: {},
          lastRunAt: ''
        }
      })
    },
    gcmRegistrations: []
  };
  const env = createEnv(legacy);

  const loaded = await readSettings(env);
  const rows = env.SYNC_DB.dumpRows();
  const types = new Set(rows.map((row) => row.record_type));

  assert.equal(loaded.clients['web:row-test'].email.address, 'row@example.com');
  assert.equal(loaded.clients['web:row-test'].barkDeviceKey, 'bark-device');
  assert.ok(types.has('client'));
  assert.ok(types.has('client-channel'));
  assert.ok(types.has('client-feature'));
  assert.ok(types.has('rule-state'));
  assert.ok(types.has('event'));
  assert.ok(rows.some((row) => row.record_type === 'migration' && row.record_id === 'notify-settings-v1'));

  const rowCountAfterFirstRead = rows.length;
  await readSettings(env);
  assert.equal(env.SYNC_DB.dumpRows().length, rowCountAfterFirstRead);
});

test('durable CRUD uses D1 rows while KV keeps only a tiny discovery marker', async () => {
  const env = createEnv({ clients: {}, gcmRegistrations: [] });
  const key = 'notify:market-alerts:account:usr-row-test:exchange';
  const latest = { updatedAt: '2026-09-10T07:00:00.000Z', alerts: ['latest'] };
  const stale = { updatedAt: '2026-09-10T06:00:00.000Z', alerts: ['stale'] };

  await writeJson(env, key, latest);
  await writeJson(env, key, stale);

  assert.deepEqual(await readJson(env, key, null), latest);
  const marker = JSON.parse(await env.NOTIFY_STATE.get(key));
  assert.deepEqual(Object.keys(marker).sort(), ['__notifyRowStorage', 'updatedAt'].sort());
  assert.equal(marker.__notifyRowStorage, 'd1');
  assert.equal(env.SYNC_DB.dumpRows().filter((row) => row.record_type === 'user-kv').length, 1);

  await writeJson(env, 'nav:cache:latest', { value: 1 });
  assert.deepEqual(JSON.parse(await env.NOTIFY_STATE.get('nav:cache:latest')), { value: 1 });
});

test('stale device snapshots do not erase independently updated channels', async () => {
  const env = createEnv({ clients: {}, gcmRegistrations: [] });
  const base = { clients: { 'web:row-test': makeClient() }, gcmRegistrations: [] };
  await writeSettings(env, base);

  const snapshotA = structuredClone(base);
  snapshotA.clients['web:row-test'].barkDeviceKey = 'bark-from-device-a';
  const snapshotB = structuredClone(base);
  snapshotB.clients['web:row-test'].email = {
    address: 'email-from-device-b@example.com',
    verified: true,
    enabled: true
  };

  await Promise.all([writeSettings(env, snapshotA), writeSettings(env, snapshotB)]);
  const loaded = await readSettings(env);
  const client = loaded.clients['web:row-test'];

  assert.equal(client.barkDeviceKey, 'bark-from-device-a');
  assert.equal(client.email.address, 'email-from-device-b@example.com');
});


test('explicit channel clears are not resurrected by stale-channel preservation', async () => {
  const env = createEnv({ clients: {}, gcmRegistrations: [] });
  const client = makeClient({
    serverChan3: { uid: '18912', sendKey: 'same-send-key' },
    barkDeviceKey: 'bark-device'
  });
  const base = { clients: { 'web:row-test': client }, gcmRegistrations: [] };
  await writeSettings(env, base);

  const incoming = await readSettings(env);
  incoming.clients['web:row-test'].serverChan3 = {};
  await writeSettings(env, incoming, {
    channelClears: [{ clientId: 'web:row-test', channel: 'serverchan3' }]
  });

  const loaded = await readSettings(env);
  assert.equal(loaded.clients['web:row-test'].serverChan3.uid, '');
  assert.equal(loaded.clients['web:row-test'].serverChan3.sendKey, '');
  assert.equal(loaded.clients['web:row-test'].barkDeviceKey, 'bark-device');
  assert.equal(
    env.SYNC_DB.dumpRows().some((row) => (
      row.record_type === 'client-channel'
      && row.record_id === 'web:row-test::serverchan3'
    )),
    false
  );
});

test('merged holding alert events round-trip with snapshots and channel metadata', async () => {
  const nowIso = new Date().toISOString();
  const legacyEvent = {
    id: `holding-alert:006479:${nowIso}`,
    eventType: 'holding-alert',
    ruleId: 'holding-alert:preset:gain:006479',
    title: '006479 持仓预警',
    body: '触发值: 5.64%',
    body_md: '',
    summary: '006479 持仓预警',
    symbol: '006479',
    status: 'delivered',
    channels: [{ channel: 'pc', status: 'queued', detail: '已写入事件，等待 PC 浏览器拉取' }],
    createdAt: nowIso,
    reason: 'scheduled'
  };
  const mergedEvent = {
    id: `holding-alert:merged:gain:1760000000000:0a1b2c3d4e5f`,
    eventType: 'holding-alert',
    ruleId: 'holding-alert:merged:gain',
    title: '持仓涨幅预警（2只）',
    body: '006479 +5.64%, 008971 +4.21% → 点此查看持仓。',
    body_md: '**持仓涨幅预警（2只）**',
    summary: '持仓涨幅预警（2只）',
    symbol: '',
    merged: true,
    alertType: 'gain',
    holdingCount: 2,
    alertCount: 2,
    ruleIds: ['holding-alert:preset:gain:006479', 'holding-alert:preset:gain:008971'],
    symbols: ['006479', '008971'],
    alerts: [
      {
        ruleId: 'holding-alert:preset:gain:006479',
        symbol: '006479',
        name: '广发纳斯达克100ETF联接人民币(QDII)C',
        fundKind: 'qdii',
        alertType: 'gain',
        threshold: 2,
        actualValue: 5.64,
        currentPrice: 1.0564,
        holdingCost: 1,
        cooldownHours: 24
      },
      {
        ruleId: 'holding-alert:preset:gain:008971',
        symbol: '008971',
        name: '示例持仓',
        fundKind: 'qdii',
        alertType: 'gain',
        threshold: 3,
        actualValue: 4.21,
        currentPrice: 1.0421,
        holdingCost: 1,
        cooldownHours: 24
      }
    ],
    strategyName: '',
    triggerCondition: '',
    purchaseAmount: '',
    detailUrl: 'https://freebacktrack.tech/index.html?tab=holdings&source=notification&trigger=holding-alert&alertType=gain',
    url: 'https://freebacktrack.tech/index.html?tab=holdings&source=notification&trigger=holding-alert&alertType=gain',
    links: {
      web: 'https://freebacktrack.tech/index.html?tab=holdings&source=notification&trigger=holding-alert&alertType=gain',
      app: '',
      miniProgram: ''
    },
    target: 'holdings',
    params: { trigger: 'holding-alert', alertType: 'gain' },
    status: 'delivered',
    channels: [{
      channel: 'queue',
      status: 'delivered',
      detail: '通知任务已进入发送队列',
      configKey: 'queue:web:row-test',
      configType: 'queue',
      configId: 'notify-deliver:holding-alert:merged:gain:1760000000000:0a1b2c3d4e5f',
      configLabel: '通知发送队列'
    }],
    createdAt: nowIso,
    reason: 'scheduled'
  };

  const env = createEnv({ clients: {}, gcmRegistrations: [] });
  const base = {
    clients: {
      'web:row-test': makeClient({
        state: {
          ruleStates: {},
          deliveryFailures: {},
          recentEvents: [mergedEvent, legacyEvent],
          deliveryAcks: {},
          lastRunAt: ''
        }
      })
    },
    gcmRegistrations: []
  };
  await writeSettings(env, base);
  const loaded = await readSettings(env);
  const events = loaded.clients['web:row-test'].state.recentEvents;

  assert.deepEqual(events.find((event) => event.id === mergedEvent.id), mergedEvent);
  assert.deepEqual(events.find((event) => event.id === legacyEvent.id), legacyEvent);
});
