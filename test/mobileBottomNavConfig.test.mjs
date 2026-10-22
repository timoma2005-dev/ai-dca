import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MOBILE_BOTTOM_NAV_ITEMS,
  MOBILE_BOTTOM_NAV_MAX_TABS,
  resolveMobileBottomNavItems,
  splitMobileBottomNavItems,
} from '../src/components/mobile-bottom-nav-config.js';

test('mobile bottom nav keeps cn tab order', () => {
  assert.deepEqual(
    MOBILE_BOTTOM_NAV_ITEMS.map((item) => item.key),
    ['home', 'markets', 'holdings', 'tradePlans', 'shares', 'fundSwitch', 'notify', 'articles', 'adminQuant', 'adminRadar', 'adminAuction'],
  );
});

test('mobile bottom nav filters hidden tabs by visible list', () => {
  const items = resolveMobileBottomNavItems(['markets', 'tradePlans', 'notify']);
  assert.deepEqual(items.map((item) => item.key), ['markets', 'tradePlans', 'notify']);
});

test('mobile bottom nav ignores unknown visible tab keys', () => {
  const items = resolveMobileBottomNavItems(['unknown', 'holdings']);
  assert.deepEqual(items.map((item) => item.key), ['holdings']);
});

test('mobile bottom nav hides admin tabs for non-admin users', () => {
  const items = resolveMobileBottomNavItems(
    ['home', 'shares', 'adminQuant', 'adminRadar', 'adminAuction'],
    false,
  );
  assert.deepEqual(items.map((item) => item.key), ['home', 'shares']);
});

test('mobile bottom nav shows admin tabs for admin users', () => {
  const items = resolveMobileBottomNavItems(
    ['home', 'shares', 'adminQuant', 'adminRadar', 'adminAuction'],
    true,
  );
  assert.deepEqual(items.map((item) => item.key), ['home', 'shares', 'adminQuant', 'adminRadar', 'adminAuction']);
});

test('mobile bottom nav reserves fifth slot for overflow', () => {
  const { directItems, overflowItems } = splitMobileBottomNavItems();
  assert.equal(MOBILE_BOTTOM_NAV_MAX_TABS, 5);
  assert.deepEqual(directItems.map((item) => item.key), ['home', 'markets', 'holdings', 'tradePlans']);
  assert.deepEqual(overflowItems.map((item) => item.key), ['shares', 'fundSwitch', 'notify', 'articles']);
  assert.equal(directItems.length + 1, MOBILE_BOTTOM_NAV_MAX_TABS);
});

test('mobile bottom nav overflow includes admin tabs for admin users', () => {
  const { directItems, overflowItems } = splitMobileBottomNavItems(null, undefined, true);
  assert.deepEqual(directItems.map((item) => item.key), ['home', 'markets', 'holdings', 'tradePlans']);
  assert.deepEqual(
    overflowItems.map((item) => item.key),
    ['shares', 'fundSwitch', 'notify', 'articles', 'adminQuant', 'adminRadar', 'adminAuction'],
  );
});

test('mobile bottom nav does not show overflow when five or fewer tabs are visible', () => {
  const { directItems, overflowItems } = splitMobileBottomNavItems([
    'home', 'markets', 'holdings', 'tradePlans', 'notify',
  ]);
  assert.equal(directItems.length, 5);
  assert.deepEqual(overflowItems, []);
});
