import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const componentSource = fs.readFileSync(path.resolve(testDir, '../src/components/brand-preview-bar.jsx'), 'utf8');

test('brand preview bar preserves existing public props and callbacks', () => {
  for (const prop of ['currentPageLabel', 'onJoinGroup', 'onShowDisclaimer', 'onOpenNav']) {
    assert.match(componentSource, new RegExp(`\\b${prop}\\b`));
  }
  assert.match(componentSource, /onClick=\{onOpenNav\}/);
});

test('brand preview bar uses cn dependencies and does not import test-only header features', () => {
  assert.match(componentSource, /from 'lucide-react'/);
  for (const forbidden of ['@tabler/icons-react', 'NAV_GROUPS', 'NAV_UTILITY_ITEMS', 'NavDropdown', "from 'gsap'"]) {
    assert.doesNotMatch(componentSource, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('brand preview bar no longer hosts the account button (moved to mobile more sheet)', () => {
  assert.doesNotMatch(componentSource, /aria-label="账户"/);
  assert.doesNotMatch(componentSource, /account-menu/);
});
