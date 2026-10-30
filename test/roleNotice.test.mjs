import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleNotice, formatExpiry } from '../services/cn-data/src/notify/roleNotice.js';
import { shouldSendRoleNotice, roleNoticeUrl } from '../services/auth/src/roleNotice.js';

test('vip notice lists vip features and links to notify', () => {
  const n = buildRoleNotice({ userId: 'usr_1', username: 'amy', role: 'vip', expiresAt: '2026-11-30T15:59:59.000Z' });
  assert.equal(n.title, '🎉 VIP 已开通');
  assert.match(n.body, /amy，你的账号已开通 VIP，有效期至 2026年11月30日/);
  assert.match(n.body, /基金切换/);
  assert.doesNotMatch(n.body, /竞价看板/);
  assert.match(n.url, /tab=notify$/);
  assert.equal(n.eventType, 'account-notice');
});

test('svip notice is permanent and includes svip features', () => {
  const n = buildRoleNotice({ userId: 'usr_2', role: 'svip', noticeId: 'welcome-20261030' });
  assert.match(n.body, /长期有效/);
  assert.match(n.body, /竞价看板/);
  assert.equal(n.eventId, 'role-notice-svip-usr_2-welcome-20261030');
});

test('only vip/svip', () => {
  assert.equal(buildRoleNotice({ userId: 'u', role: 'admin' }), null);
  assert.equal(shouldSendRoleNotice('vip', {}), true);
  assert.equal(shouldSendRoleNotice('admin', {}), false);
  assert.equal(shouldSendRoleNotice('vip', { AUTH_ROLE_NOTICE: '0' }), false);
  assert.equal(roleNoticeUrl({}), 'http://127.0.0.1:8081/internal/role-notice');
  assert.equal(formatExpiry(null), '长期有效');
});
