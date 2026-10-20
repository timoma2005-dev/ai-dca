import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const navSource = fs.readFileSync(path.resolve(testDir, '../src/components/mobile-bottom-nav.jsx'), 'utf8');

test('mobile bottom nav more popover does not register global bottom sheet state', () => {
  assert.doesNotMatch(navSource, /setMobileBottomSheetOpen/);
  assert.doesNotMatch(navSource, /mobile-nav-more/);
});

test('mobile bottom nav keeps hidden guard and popover close entries', () => {
  assert.match(navSource, /if \(hidden\) setMoreOpen\(false\)/);
  assert.match(navSource, /if \(hidden \|\| \(directItems\.length === 0 && overflowItems\.length === 0\)\) return null;/);
  assert.match(navSource, /aria-label="关闭更多导航"/);
  assert.match(navSource, /Escape/);
  assert.match(navSource, /aria-expanded=\{moreOpen\}/);
});
