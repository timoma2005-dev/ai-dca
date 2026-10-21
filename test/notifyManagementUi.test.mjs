import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath) => fs.readFileSync(path.resolve(testDir, '..', relativePath), 'utf8');

const configSource = readSource('src/pages/NotifyConfigCard.jsx');
const rulesSource = readSource('src/pages/NotifyRulesCard.jsx');
const actionsSource = readSource('src/pages/NotifySyncAndTestCard.jsx');
const historySource = readSource('src/pages/NotifyHistoryCard.jsx');
const testDialogSource = readSource('src/pages/NotifyTestDialog.jsx');
const experienceSource = readSource('src/pages/NotifyExperience.jsx');

test('notification channel management exposes a status-first channel picker', () => {
  assert.match(configSource, /const channelCards = platformTabs\.map/);
  assert.match(configSource, /可用渠道/);
  assert.match(configSource, /role="tablist" aria-label="通知渠道"/);
  assert.match(configSource, /setConfigCollapsed\?\.\(false\)/);
  assert.match(configSource, /section === 'config'/);
  assert.match(configSource, /登录后配置会归属到账号/);
});

test('daily holdings return rule remains manageable while disabled', () => {
  assert.match(rulesSource, /const holdingsRuleCount = 1/);
  assert.match(rulesSource, /持仓每日收益/);
  assert.match(rulesSource, /\{holdingsEnabled \? '已开启' : '未开启'\}/);
  assert.match(rulesSource, /onToggleHoldingsRule\?\.\(event\.target\.checked\)/);
  assert.doesNotMatch(rulesSource, /\{holdingsEnabled && \(/);
  assert.match(rulesSource, /section === 'rules'/);
});

test('sync, test, and history refresh actions stay available without opening details', () => {
  const syncAction = actionsSource.indexOf('onClick={onSyncRules}');
  const actionsDisclosure = actionsSource.indexOf('{expanded ? (');
  const historyRefresh = historySource.indexOf('onClick={refreshNotifyEvents}');
  const historyDisclosure = historySource.indexOf('{expanded ? (');

  assert.ok(syncAction >= 0 && syncAction < actionsDisclosure);
  assert.ok(historyRefresh >= 0 && historyRefresh < historyDisclosure);
  assert.match(actionsSource, /发送测试/);
  assert.match(historySource, /最近：/);
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
