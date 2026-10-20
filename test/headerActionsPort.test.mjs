import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const componentSource = fs.readFileSync(path.resolve(testDir, '../src/components/brand-preview-bar.jsx'), 'utf8');
const notifySource = fs.readFileSync(path.resolve(testDir, '../src/components/notify-popover.jsx'), 'utf8');

test('mobile header exposes notification and account actions without hamburger nav button', () => {
  assert.match(componentSource, /<NotifyPopover\s*\/>/);
  assert.match(componentSource, /aria-label="账户"/);
  assert.match(componentSource, /className="app-header__utility"/);
  assert.match(componentSource, /dispatchEvent\(new CustomEvent\(ACCOUNT_AUTH_OPEN_EVENT\)\)/);
  assert.doesNotMatch(componentSource, /app-header__menu-button/);
  assert.doesNotMatch(componentSource, /aria-label="打开导航"/);
  assert.doesNotMatch(componentSource, /onOpenNav/);
  assert.doesNotMatch(componentSource, /account-menu/);
});

test('workspace page owns the single controlled account menu wired to the account event', () => {
  const workspaceSource = fs.readFileSync(path.resolve(testDir, '../src/pages/WorkspacePage.jsx'), 'utf8');
  assert.match(workspaceSource, /ACCOUNT_AUTH_OPEN_EVENT/);
  assert.match(workspaceSource, /window\.addEventListener\(ACCOUNT_AUTH_OPEN_EVENT/);
  assert.match(workspaceSource, /<AccountMenu[\s\S]*?open=\{accountMenuOpen\}/);
  assert.match(workspaceSource, /onClose=\{\(\) => setAccountMenuOpen\(false\)\}/);
});

test('mobile bottom nav more sheet exposes account entry', () => {
  const navSource = fs.readFileSync(path.resolve(testDir, '../src/components/mobile-bottom-nav.jsx'), 'utf8');
  assert.match(navSource, /onOpenAccount/);
  assert.match(navSource, /账号/);
});

test('notification popover loads records and keeps links inside cn notification tab', () => {
  assert.match(notifySource, /loadNotifyEvents/);
  assert.match(notifySource, /tab=notify/);
  assert.match(notifySource, /section=config/);
  assert.match(notifySource, /section=rules/);
});
