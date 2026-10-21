import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/accountEntry.js';
import { hashToken } from '../src/accountSettingsRoute.js';
import { ensureNotifyRowSchema, readSettingsFromRows, writeSettingsToRows } from '../src/notifyRowStorage.js';
import { isBarkRoute } from '../src/bark.js';
import { readBark, readServerChan3 } from '../../../services/cn-data/src/notify/channelToggle.js';

async function harness(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../../../services/cn-data/migrations/002-account-v1.sql', import.meta.url), 'utf8'));
  sqlite.exec(`CREATE TABLE users (id TEXT, username TEXT); CREATE TABLE sessions (user_id TEXT, token_hash TEXT, expires_at TEXT);`);
  const token = crypto.randomUUID();
  sqlite.prepare('INSERT INTO users VALUES (?, ?)').run('toggle-user', 'toggle');
  sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('toggle-user', await hashToken(token), '2999-01-01');
  const db = {
    prepare(sql) {
      const bind = (...args) => ({
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { return { meta: sqlite.prepare(sql).run(...args) }; }
      });
      return { bind, ...bind() };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const reads = { kv: 0 };
  const env = { SYNC_DB: db, NOTIFY_STATE: { async get() { reads.kv += 1; return null; }, async put() {} } };
  await ensureNotifyRowSchema(env);
  sqlite.exec(`CREATE TABLE notify_channel_bindings (channel_type TEXT, token_hash TEXT, owner_user_id TEXT, client_id TEXT, channel_identity TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(channel_type, token_hash));`);
  const call = (path, method = 'POST', body, authenticated = true) => worker.fetch(new Request(`https://notify.test/api/notify/${path}`, {
    method, headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'x-notify-verified-user-id': 'forged', 'x-notify-verified-username': 'forged' },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env);
  return { sqlite, env, call, reads };
}

for (const channel of ['bark', 'serverchan3']) {
  for (const action of ['enable', 'disable']) test(`${channel}/${action} requires bearer authentication`, async (t) => {
    const { call } = await harness(t);
    const response = await call(`channels/${channel}/${action}`, 'POST', null, false);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'AUTH_REQUIRED');
    assert.equal(isBarkRoute(new URL(`https://notify.test/api/notify/channels/${channel}/${action}`)), false);
  });
  test(`${channel} unconfigured enable matches CN error; disable succeeds`, async (t) => {
    const { call } = await harness(t);
    const response = await call(`channels/${channel}/enable`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), channel === 'bark'
      ? { error: '请先配置 Bark Device Key。', code: 'BARK_NOT_CONFIGURED' }
      : { error: '请先配置 Server酱 UID 和 SendKey。', code: 'SERVERCHAN3_NOT_CONFIGURED' });
    const disabled = await call(`channels/${channel}/disable`);
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json())[channel === 'bark' ? 'bark' : 'serverChan3'].enabled, false);
  });
  for (const source of ['legacy', 'resource']) test(`${channel} ${source}: disable/enable round-trip status and CN payload`, async (t) => {
    const { call, sqlite, env, reads } = await harness(t);
    const bark = channel === 'bark';
    const key = bark ? 'bark' : 'serverChan3';
    const saved = await call('settings', 'POST', bark ? { barkDeviceKey: 'bark-key' } : { serverChan3: { uid: '123', sendKey: 'send-key-123' } });
    assert.equal(saved.status, 200);
    if (source === 'legacy') sqlite.exec('DELETE FROM account_resource_records');
    else sqlite.exec("DELETE FROM notify_user_records WHERE record_type = 'client-channel'");
    sqlite.exec(`UPDATE notify_user_records SET payload=json_remove(payload, '$.enabled') WHERE record_type='client-channel'; UPDATE account_resource_records SET payload=json_remove(payload, '$.enabled');`);
    const status = async () => (await (await call('status', 'GET')).json()).data.channels[key];
    assert.equal((await status()).enabled, true);
    // Unknown fields must survive toggles in both storage representations.
    sqlite.exec(`UPDATE notify_user_records SET payload=json_set(payload, '$.custom', '保留') WHERE record_type='client-channel'; UPDATE account_resource_records SET payload=json_set(payload, '$.custom', '保留');`);
    for (const action of ['disable', 'enable']) {
      const enabled = action === 'enable';
      const response = await call(`channels/${channel}/${action}`);
      assert.equal(response.status, 200);
      const value = (await response.json())[key];
      assert.deepEqual(value, bark ? { deviceKey: 'bark-key', enabled, configured: true }
        : { uid: '123', sendKeyMasked: 'send-k...-123', configured: true, enabled });
      assert.equal((await status()).enabled, enabled);
      const row = sqlite.prepare("SELECT payload FROM notify_user_records WHERE record_id=?").get(`account:toggle-user::${channel}`);
      assert.equal(JSON.parse(row.payload).enabled, enabled);
      const resource = sqlite.prepare('SELECT payload FROM account_resource_records WHERE record_id=?').get(`channel:${channel}`);
      assert.equal(JSON.parse(resource.payload).enabled, enabled);
      assert.equal(JSON.parse((source === 'legacy' ? row : resource).payload).custom, '保留');
      const account = { userId: 'toggle-user', clientId: 'account:toggle-user' };
      assert.equal((bark ? readBark(sqlite, account) : readServerChan3(sqlite, account)).enabled, enabled);
      // Aggregate load/normalize/write must retain the flag in the replicated row.
      assert.equal(reads.kv, 0, 'channels and status must not enter Bark aggregate settings reads');
      const settings = await readSettingsFromRows(env);
      await writeSettingsToRows(env, settings);
      const rewritten = JSON.parse(sqlite.prepare("SELECT payload FROM notify_user_records WHERE record_id=?").get(`account:toggle-user::${channel}`).payload);
      assert.equal(rewritten.enabled, enabled);
      if (source === 'legacy') assert.equal(rewritten.custom, '保留');
    }
    const resaved = await call('settings', 'POST', bark ? { barkDeviceKey: 'bark-key' } : { serverChan3: { uid: '123', sendKey: 'send-key-123' } });
    assert.equal(resaved.status, 200);
    assert.equal((await status()).enabled, true);
    await call(`channels/${channel}/disable`);
    await call('settings', 'POST', bark ? { barkDeviceKey: 'bark-key' } : { serverChan3: { uid: '123', sendKey: 'send-key-123' } });
    assert.equal((await status()).enabled, false);
  });
}

test('Bark push URL still dispatches through handleBark without account auth', async (t) => {
  const { call } = await harness(t);
  for (const method of ['GET', 'POST']) {
    assert.equal(isBarkRoute(new URL('https://notify.test/api/notify/bark/test-key/body')), true);
    const response = await call('bark/test-key/body', method, null, false);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).message, 'unknown or unpaired key');
  }
});
