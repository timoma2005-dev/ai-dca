import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(testDir, '..', rel), 'utf8');
const menuSource = read('src/components/account-menu.jsx');
const headerSource = read('src/components/brand-preview-bar.jsx');
const badgeSource = read('src/components/rbac/role-badge.jsx');

test('头像菜单通过 portal + fixed 锚定到顶栏账户按钮，不随 WorkspacePage 末尾容器掉到底部', () => {
  assert.match(headerSource, /className="app-header__utility"\s+data-account-trigger/);
  assert.match(menuSource, /const ACCOUNT_TRIGGER_SELECTOR = '\[data-account-trigger\]';/);
  assert.match(menuSource, /const dropdown = effectiveOpen && loggedIn && typeof document !== 'undefined' \? createPortal\(/);
  assert.match(menuSource, /className="fixed z-\[130\]/);
  assert.doesNotMatch(menuSource, /absolute right-0 top-full/);
});

test('computeAccountMenuAnchor：按钮下方 8px，右侧至少留 12px 边距；按钮不可见时回退到顶部', () => {
  const body = menuSource.match(/export function computeAccountMenuAnchor\(rect, viewportWidth\) \{[\s\S]*?\n\}/)[0];
  const VIEWPORT_GUTTER = 12;
  const fn = new Function('VIEWPORT_GUTTER', `${body.replace('export ', '')}; return computeAccountMenuAnchor;`)(VIEWPORT_GUTTER);
  assert.deepEqual(fn({ left: 340, right: 376, width: 36, bottom: 60 }, 390), { top: 68, right: 14, arrowRight: 12 });
  assert.deepEqual(fn({ left: 380, right: 388, width: 8, bottom: 60 }, 390).right, 12);
  assert.deepEqual(fn({ left: 0, right: 36, width: 36, bottom: -10 }, 390), { top: 12, right: 12, arrowRight: null });
  assert.deepEqual(fn(null, 390), { top: 12, right: 12, arrowRight: null });
});

test('菜单只保留身份、角色、使用统计与退出：同步、导出备份、版本、冲突、权限管理入口已移除', () => {
  for (const removed of [/fetchCloudBackupVersions/, /rollbackCloudBackupVersion/, /fetchAccountEnvelopeExport/, /handleManualSync/, /handleResolveConflict/, /conflictModal/, /previewKeyCount/, /权限管理/, /导出/]) {
    assert.doesNotMatch(menuSource, removed);
  }
  assert.match(menuSource, /<RoleList roles=\{rbac\.roles\} \/>/);
  assert.match(menuSource, /<PrivacyNotice variant="row" \/>/);
  assert.match(menuSource, /退出登录/);
});

test('点外部关闭时忽略头像按钮与隐私说明弹层，受控模式再次点击头像可关闭', () => {
  assert.match(menuSource, /target\?\.closest\?\.\(ACCOUNT_TRIGGER_SELECTOR\) \|\| target\?\.closest\?\.\('\[role="dialog"\]'\)/);
  assert.match(menuSource, /if \(openRef\.current && loadCloudSession\(\)\?\.accessToken && !event\?\.detail\?\.mode\)/);
});

test('describeRoleExpiry：长期有效、普通到期、7 天内标橙、已到期', () => {
  const body = badgeSource.match(/const DAY_MS[\s\S]*?\nexport function describeRoleExpiry[\s\S]*?\n\}/)[0];
  const fn = new Function(`${body.replace(/export /g, '')}; return describeRoleExpiry;`)();
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.deepEqual(fn(null, now), { text: '长期有效', warn: false });
  assert.deepEqual(fn('2026-12-31T00:00:00Z', now), { text: '2026-12-31 到期', warn: false });
  assert.deepEqual(fn('2026-10-26T12:00:00Z', now), { text: '2026-10-26 到期 · 剩 3 天', warn: true });
  assert.deepEqual(fn('2026-10-20T00:00:00Z', now), { text: '2026-10-20 已到期', warn: true });
});
