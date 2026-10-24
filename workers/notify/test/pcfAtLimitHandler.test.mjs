import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePcfAtLimit } from '../src/pcfAtLimitHandler.js';
import worker from '../src/index.js';

const payload = (overrides = {}) => ({
  code: '159632', date: '2026-10-19', netCreation: 10000000, totalLimitShares: 10000000,
  ratio: 1, ...overrides
});
const request = (body = payload(), path = 'pcf-at-limit') => new Request(`https://notify.test/api/notify/internal/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
function harness(t) {
  // 使用 deliveryEngine 现有队列 env 替身，截获完整通知，不改生产投递入口。
  const messages = [], reads = [];
  const env = {
    __notifyCurrentClientId: 'account:pcf-test',
    __notifySettings: { ownerUserId: 'fallback-owner' },
    NOTIFY_STATE: { async get(key) { reads.push(key); return null; } },
    NOTIFY_JOBS: { async send(message) { messages.push(message); } }
  };
  t.mock.method(globalThis, 'fetch', () => assert.fail('tests must not send external notifications'));
  return { env, messages, reads };
}

for (const [name, patch, reason] of [
  ['missing code', { code: undefined }, 'invalid_code'],
  ['numeric code', { code: 159632 }, 'invalid_code'],
  ['short code', { code: '15963' }, 'invalid_code'],
  ['non-digit code', { code: '15963x' }, 'invalid_code'],
  ['missing date', { date: undefined }, 'invalid_date'],
  ['non-string date', { date: 20261019 }, 'invalid_date'],
  ['compact date', { date: '20261019' }, 'invalid_date'],
  ['un-padded date', { date: '2026-1-19' }, 'invalid_date'],
  ['impossible date', { date: '2026-02-30' }, 'invalid_date'],
  ['missing net creation', { netCreation: undefined }, 'invalid_net_creation'],
  ['negative net creation', { netCreation: -1 }, 'invalid_net_creation'],
  ['fractional net creation', { netCreation: 9000000.5 }, 'invalid_net_creation'],
  ['unsafe net creation', { netCreation: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_net_creation'],
  ['string net creation', { netCreation: '10000000' }, 'invalid_net_creation'],
  ['missing total limit', { totalLimitShares: undefined }, 'invalid_total_limit_shares'],
  ['zero total limit', { totalLimitShares: 0 }, 'invalid_total_limit_shares'],
  ['negative total limit', { totalLimitShares: -1 }, 'invalid_total_limit_shares'],
  ['fractional total limit', { totalLimitShares: 10000000.5 }, 'invalid_total_limit_shares'],
  ['unsafe total limit', { totalLimitShares: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_total_limit_shares'],
  ['string total limit', { totalLimitShares: '10000000' }, 'invalid_total_limit_shares'],
  ['zero utilization', { netCreation: 0 }, 'ratio_below_0.9'],
  ['forged ratio', { netCreation: 8999999, ratio: 100 }, 'ratio_below_0.9']
]) {
  test(`${name} returns a specific 400 before reading settings or delivering`, async (t) => {
    const { env, messages, reads } = harness(t);
    const response = await handlePcfAtLimit(request(payload(patch)), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, reason });
    assert.deepEqual(reads, []);
    assert.deepEqual(messages, []);
  });
}

test('malformed JSON and non-object bodies are rejected without delivery', async (t) => {
  const { env, messages } = harness(t);
  const malformed = new Request('https://notify.test/', { method: 'POST', body: '{' });
  assert.equal((await handlePcfAtLimit(malformed, env)).status, 400);
  for (const input of [null, [], 1, 'text']) {
    const response = await handlePcfAtLimit(request(input), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).reason, 'invalid_body');
  }
  assert.deepEqual(messages, []);
});

test('uses shared settings and delivery engine, preserving the full notification shape and message', async (t) => {
  const { env, messages, reads } = harness(t);
  const before = Date.now();
  const response = await handlePcfAtLimit(request(), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.delivered.status, 'delivered');
  assert.equal(result.delivered.results[0].channel, 'queue');
  assert.deepEqual(reads, ['notify:settings']);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ownerUserId, 'pcf-test', 'successfully loaded settings override env fallback');
  const notification = messages[0].notification;
  const title = '🔴 159632 华安纳斯达克100ETF 今日申购顶格打满';
  const body = '净申购：1000万份\n总限额：1000万份\n利用率：100%\n日期：2026-10-19\n\n💡 当日净申购已达总限额，新增申购空间耗尽，留意溢价变化';
  assert.deepEqual(notification, {
    eventId: 'pcf-at-limit:159632:2026-10-19', eventType: 'pcf_at_limit', ruleId: 'pcf-at-limit',
    title, body, summary: title, symbol: '159632', createdAt: notification.createdAt,
    body_md: `**${title}**\n\n${body.split('\n').map(line => line ? `- ${line}` : '').join('\n')}`
  });
  assert.ok(Date.parse(notification.createdAt) >= before);
  assert.ok(Date.parse(notification.createdAt) <= Date.now());
});

test('90% boundary and decimal/over-limit utilization come from share counts even with a forged ratio', async (t) => {
  const { env, messages } = harness(t);
  for (const [netCreation, percent] of [[9000000, '90'], [9550000, '95.5'], [12550000, '125.5']]) {
    const response = await handlePcfAtLimit(request(payload({ netCreation, ratio: 0 })), env);
    assert.equal(response.status, 200);
    assert.ok(messages.at(-1).notification.body.includes(`利用率：${percent}%`));
  }
  const small = await handlePcfAtLimit(request(payload({ netCreation: 99, totalLimitShares: 100, ratio: null })), env);
  assert.equal(small.status, 200);
  assert.ok(messages.at(-1).notification.body.includes('净申购：99份\n总限额：100份\n利用率：99%'));
});

test('fund names match relaxation handler mapping, with a code fallback for unknown funds', async (t) => {
  const { env, messages } = harness(t);
  for (const [code, name] of Object.entries({
    '159501': '嘉实纳斯达克100ETF', '159632': '华安纳斯达克100ETF', '159659': '招商纳斯达克100ETF',
    '159660': '汇添富纳斯达克100ETF', '159696': '易方达纳斯达克100ETF', '159941': '广发纳斯达克100ETF',
    '159509': '景顺长城纳斯达克科技ETF', '159513': '大成纳斯达克100ETF', '123456': '123456'
  })) {
    assert.equal((await handlePcfAtLimit(request(payload({ code })), env)).status, 200);
    assert.equal(messages.at(-1).notification.title, `🔴 ${code} ${name} 今日申购顶格打满`);
  }
});

test('settings read failure uses the same null fallback as relaxation notifications', async (t) => {
  const { env, messages } = harness(t);
  env.NOTIFY_STATE.get = async () => { throw Error('KV down'); };
  assert.equal((await handlePcfAtLimit(request(), env)).status, 200);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ownerUserId, 'fallback-owner');
});

test('delivery exceptions return a failed handler response', async (t) => {
  const { env } = harness(t);
  env.NOTIFY_JOBS.send = async () => { throw Error('delivery down'); };
  t.mock.method(console, 'error', () => {});
  const response = await handlePcfAtLimit(request(), env);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, reason: 'delivery down' });
});

test('worker registers the internal POST route alongside the existing relaxation route before account auth', async (t) => {
  const { env, messages } = harness(t);
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal(messages[0].notification.eventType, 'pcf_at_limit');
  const oldResponse = await worker.fetch(request({
    code: '159632', date: '2026-10-19', tier: '5x',
    prev: { kind: 'limited', shares: 1000000 }, cur: { kind: 'limited', shares: 5000000 }, ratio: 5
  }, 'pcf-signal'), env);
  assert.equal(oldResponse.status, 200);
  assert.equal(messages[1].notification.eventType, 'pcf_limit_relaxation');
  assert.equal((await worker.fetch(new Request('https://notify.test/api/notify/internal/pcf-at-limit'), env)).status, 404);
});
