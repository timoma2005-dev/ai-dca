import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath) => fs.readFileSync(path.resolve(testDir, '..', relativePath), 'utf8');

const configSource = readSource('src/pages/NotifyConfigCard.jsx');
const rulesSource = readSource('src/pages/NotifyRulesCard.jsx');
import { renderNotifyCard, cleanup } from './helpers/renderNotifyCards.mjs';
test.after(cleanup);
const historySource = readSource('src/pages/NotifyHistoryCard.jsx');
const testDialogSource = readSource('src/pages/NotifyTestDialog.jsx');
const experienceSource = readSource('src/pages/NotifyExperience.jsx');

test('notification channel management exposes a status-first channel picker', () => {
  const html = renderNotifyCard('NotifyConfigCard', {
    notifyConfig: {}, pairedWebWsDevices: [], notifyPlatform: 'ios',
    emailDraft: '', emailCode: '', isLoggedIn: false
  });
  assert.match(html, /通知渠道/);
  assert.match(html, /点击渠道卡片进行设置和管理/);
  for (const label of ['iOS', 'Android', 'Email', 'PC']) assert.ok(html.includes(label));
  assert.match(configSource, /onClick=\{\(\) => openChannel\(channel.key\)\}/);
  assert.match(configSource, /setConfigCollapsed\?\.\(false\)/);
  assert.match(configSource, /fieldset disabled=\{!isLoggedIn\}/);
});

test('daily holdings return rule remains manageable while disabled', () => {
  const html = renderNotifyCard('NotifyRulesCard', {
    expanded: true, holdingsRule: { enabled: false }, onToggleHoldingsRule() {}
  });
  assert.match(html, /持仓收益提醒/);
  assert.match(html, /持仓收益提醒状态/);
  assert.match(html, /已关闭/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(rulesSource, /onChange\?\.\(event.target.checked\)/);
  assert.match(rulesSource, /action=\{onToggleHoldingsRule\}/);
  assert.match(rulesSource, /get\('section'\) === 'rules'/);
});

test('sync, test, and history refresh actions stay available without opening details', () => {
  const html = renderNotifyCard('NotifyRulesCard', {
    expanded: false, onSyncRules() {}, onOpenTestDialog() {}
  });
  assert.match(html, /同步规则/);
  assert.match(html, /送达测试/);
  assert.doesNotMatch(html, /规则名称/);
  const historyHtml = renderNotifyCard('NotifyHistoryCard', { expanded: false, events: [] });
  assert.match(historyHtml, /刷新送达记录/);
  assert.match(rulesSource, /onClick=\{onSyncRules\}/);
  assert.match(rulesSource, /onClick=\{onOpenTestDialog\}/);
  assert.match(historySource, /onClick=\{refreshNotifyEvents\}/);
});

test('channel test buttons stay clickable before the channel is configured', () => {
  assert.match(configSource, /onClick=\{handleTestBarkNotify\} disabled=\{isTestingBarkNotify \|\| !hasBarkInput\}/);
  assert.doesNotMatch(configSource, /handleTestBarkNotify\} disabled=\{[^}]*!barkEnabled/);
  assert.doesNotMatch(configSource, /handleTestServerChan3Notify\} disabled=\{[^}]*!serverChan3Enabled/);
});

test('test dialog auto-selects a valid rule and documents every delivery channel', () => {
  assert.match(testDialogSource, /setSelectedId\(currentRules\[0\]\?\.id \|\| ''\)/);
  assert.match(testDialogSource, /role="radiogroup" aria-label="测试规则"/);
  assert.match(testDialogSource, /Bark、Server酱³、Email 和可用的 PC 浏览器通知/);
  assert.match(testDialogSource, /event\.key === 'Escape'/);
  assert.match(testDialogSource, /event\.target === event\.currentTarget/);
});

test('test dialog includes enabled switch rules with the advanced rules wording', () => {
  assert.match(testDialogSource, /switch: \{/);
  assert.match(testDialogSource, /label: '切换规则'/);
  assert.match(testDialogSource, /description: '基金切换提醒'/);
  assert.match(testDialogSource, /icon: Shuffle/);
  assert.match(testDialogSource, /rules: switchConfig\?\.enabled/);
  assert.ok(testDialogSource.includes('Array.isArray(switchConfig?.rules) ? switchConfig.rules : []'));
  assert.ok(testDialogSource.includes('.filter((rule) => (rule?.benchmarkCodes?.length || rule?.enabledCodes?.length))'));
  assert.ok(testDialogSource.includes('rule.enabled !== false'));
  assert.ok(testDialogSource.includes('.filter((rule) => rule.enabled)'));
  assert.ok(testDialogSource.includes('id: rule.id || `switch-${index}`'));
  assert.ok(testDialogSource.includes('label: rule.name || `切换规则 ${index + 1}`'));
  assert.ok(testDialogSource.includes('detail: `持仓基准 ${rule.benchmarkCodes?.length || 0} 只 · 候选 ${rule.enabledCodes?.length || 0} 只`'));
  assert.match(testDialogSource, /type: 'switch'/);
});

test('test delivery receives switch configuration and the selected rule label', () => {
  assert.match(experienceSource, /<NotifyTestDialog\b[\s\S]*?switchConfig=\{switchConfig\}[\s\S]*?onSendTest=\{handleSendTestNotify\}/);
  assert.ok(testDialogSource.includes('currentRules.find((rule) => rule.id === selectedId)'));
  assert.ok(testDialogSource.includes('onSendTest?.(selectedType, selectedId, currentRule?.label)'));
  assert.match(experienceSource, /handleSendTestNotify\(ruleType, ruleId, ruleLabel\)/);
  assert.ok(experienceSource.includes('body: ruleLabel ? `这是「${ruleLabel}」的测试通知` : `这是一条来自"${ruleType}"的测试通知`'));
});

const syncSource = readSource('src/app/notifySync.js');
const parserSource = readSource('src/app/notifyParsers.js');
const { normalizeBarkDeviceKey } = await import('../src/app/notifyParsers.js');

test('channel toggles use channels prefix and both Bark handlers validate input', () => {
  for (const channel of ['bark', 'serverchan3']) {
    for (const action of ['enable', 'disable']) {
      assert.ok(syncSource.includes(`requestNotify('/channels/${channel}/${action}'`));
      assert.ok(!syncSource.includes(`requestNotify('/${channel}/${action}'`));
    }
  }
  assert.equal(experienceSource.match(/normalizeBarkDeviceKey\(notifyConfig.barkDeviceKey\)/g)?.length, 2);
  assert.ok(parserSource.includes('/^[A-Za-z0-9_-]{8,128}$/'));
});

test('Bark normalization accepts links and valid keys and rejects invalid input', () => {
  for (const key of ['a'.repeat(8), 'a'.repeat(128), 'Device_key-123']) {
    assert.equal(normalizeBarkDeviceKey(key), key);
    assert.equal(normalizeBarkDeviceKey(`https://api.day.app/${key}/title/body`), key);
  }
  for (const input of ['', 'short', 'a'.repeat(129), 'invalid/key', 'invalid key', 'invalid.key', 'https://api.day.app/', 'api.day.app/%ZZ']) {
    assert.equal(normalizeBarkDeviceKey(input), '');
  }
});

test('settings reject invalid Bark before writes and allow unrelated saves and removal', async () => {
  const writes = [];
  const start = syncSource.indexOf('export async function saveNotifySettings(');
  const end = syncSource.indexOf('\nexport function loadNotifyEmailStatus', start);
  const makeSave = new Function('normalizeBarkDeviceKey', 'readNotifyClientConfig', 'putAccountResourceItem', 'deleteNotifyChannel', 'normalizeNotifyClientId', 'normalizeNotifyClientLabel', 'serverChanSetup', syncSource.slice(start, end).replace('export ', '') + '\nreturn saveNotifySettings;');
  const save = makeSave(normalizeBarkDeviceKey, () => ({ barkDeviceKey: 'legacy.invalid' }),
    async (...args) => writes.push(args), async (...args) => writes.push(args),
    value => value || '', value => value || '', () => ({}));
  await assert.rejects(save({ barkDeviceKey: 'invalid/key' }), /Bark 链接或 Device Key 格式不正确/);
  assert.equal(writes.length, 0);
  await save({ serverChan3: { uid: 'uid', sendKey: 'key' } });
  assert.equal(writes.length, 1);
  await save({ barkDeviceKey: '' });
  assert.deepEqual(writes[1], ['channel:bark', { barkDeviceKey: '' }]);
  await save(Object.create({ barkDeviceKey: 'invalid/key' }));
  assert.equal(writes.length, 2);
  await save({ barkDeviceKey: 'Device_key-123' });
  assert.deepEqual(writes[2], ['notify/client-config', 'channel:bark', { barkDeviceKey: 'Device_key-123' }]);
});

test('skipped events are labelled as skipped, not queued or processing', () => {
  const dialogSource = readSource('src/pages/NotifyEventDetailDialog.jsx');
  assert.match(historySource, /status === 'skipped'/);
  assert.match(historySource, /skipped \? '已跳过' : '处理中'/);
  assert.match(dialogSource, /status === 'skipped'/);
  assert.match(dialogSource, /已跳过（\$\{skippedDetail\}）/);
});
