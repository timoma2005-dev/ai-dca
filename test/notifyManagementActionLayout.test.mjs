import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotifyCard, cleanup } from './helpers/renderNotifyCards.mjs';
test.after(cleanup);

test('active rules card keeps sync and test controls visible before opening details', () => {
  for (const expanded of [false, true]) {
    const html = renderNotifyCard('NotifyRulesCard', { expanded, onSyncRules() {}, onOpenTestDialog() {} });
    assert.match(html, /同步规则/);
    assert.match(html, /送达测试/);
    assert.equal(html.includes('规则名称'), expanded);
  }
  const busy = renderNotifyCard('NotifyRulesCard', { onSyncRules() {}, isSyncingRules: true });
  assert.match(busy, /disabled=""/);
  assert.match(busy, /同步中/);
});

test('history refresh remains a labelled compact control for collapsed and expanded states', () => {
  for (const expanded of [false, true]) {
    const html = renderNotifyCard('NotifyHistoryCard', { expanded, events: [], refreshNotifyEvents() {} });
    assert.match(html, /aria-label="刷新送达记录"/);
    assert.match(html, /查看最近的通知推送记录/);
    assert.ok(html.includes(expanded ? '收起记录' : '查看全部记录'));
  }
  const busy = renderNotifyCard('NotifyHistoryCard', { events: [], eventsLoading: true });
  assert.match(busy, /disabled=""/);
});
