import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNotificationAction,
  buildNotificationLinks
} from '../workers/notify/src/notificationLinks.js';
import { buildMergedHoldingAlertNotification } from '../workers/notify/src/holdingAlertNotification.js';

test('buildNotificationLinks defaults to freebacktrack web links and reserves app targets', () => {
  const links = buildNotificationLinks({}, 'fundSwitch', {
    code: '513100',
    trigger: 'switch-threshold'
  });

  assert.equal(links.target, 'fundSwitch');
  assert.equal(links.web, 'https://freebacktrack.tech/index.html?tab=fundSwitch&source=notification&code=513100&trigger=switch-threshold');
  assert.equal(links.app, '');
  assert.equal(links.miniProgram, '');
});

test('buildNotificationAction allows worker env web override', () => {
  const action = buildNotificationAction({
    NOTIFICATION_WEB_BASE_URL: 'https://example.test/app/'
  }, 'holdings', {
    code: '513100'
  });

  assert.equal(action.detailUrl, 'https://example.test/index.html?tab=holdings&source=notification&code=513100');
  assert.equal(action.url, action.detailUrl);
  assert.equal(action.links.web, action.detailUrl);
  assert.equal(action.links.app, '');
  assert.equal(action.links.miniProgram, '');
  assert.equal(action.params.code, '513100');
});

test('merged holding alert links open the holdings page without selecting an individual holding', async () => {
  const notification = await buildMergedHoldingAlertNotification({
    NOTIFICATION_WEB_BASE_URL: 'https://example.test/app/'
  }, {
    alertType: 'gain',
    clientId: 'web:links-test',
    nowMs: 1760000000000,
    alerts: [{
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
    }]
  });

  const expectedUrl = 'https://example.test/index.html?tab=holdings&source=notification&trigger=holding-alert&alertType=gain';
  assert.equal(notification.detailUrl, expectedUrl);
  assert.equal(notification.url, expectedUrl);
  assert.equal(notification.links.web, expectedUrl);
  assert.equal(notification.target, 'holdings');
  assert.deepEqual(notification.params, { trigger: 'holding-alert', alertType: 'gain' });
  assert.ok(!('code' in notification.params), '合并通知不应携带单只持仓 code');
  assert.ok(!('ruleId' in notification.params), '合并通知不应携带单条规则 ruleId');
});

test('merged holding alert loss links carry the loss alertType', async () => {
  const notification = await buildMergedHoldingAlertNotification({}, {
    alertType: 'loss',
    clientId: 'web:links-test',
    nowMs: 1760000000000,
    alerts: [{
      ruleId: 'holding-alert:preset:loss:006479',
      symbol: '006479',
      name: '示例持仓',
      fundKind: 'qdii',
      alertType: 'loss',
      threshold: 2,
      actualValue: -5.64,
      currentPrice: 0.9436,
      holdingCost: 1,
      cooldownHours: 24
    }]
  });

  assert.equal(notification.params.alertType, 'loss');
  assert.equal(notification.links.web, 'https://freebacktrack.tech/index.html?tab=holdings&source=notification&trigger=holding-alert&alertType=loss');
});
