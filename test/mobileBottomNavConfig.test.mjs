import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MOBILE_BOTTOM_NAV_ITEMS,
  MOBILE_BOTTOM_NAV_MAX_TABS,
  resolveMobileBottomNavItems,
  splitMobileBottomNavItems,
} from '../src/components/mobile-bottom-nav-config.js';
import { buildGuestFallback, flattenMenus } from '../src/app/rbac/menuModel.js';

const m = (key, locked = false, extra = {}) => ({ key, label: key, locked, ...extra });
const USER_MENUS = ['home', 'markets', 'shares', 'holdings', 'tradePlans', 'fundSwitch', 'notify', 'articles', 'dataRepair'].map((k) => m(k))
  .concat([m('adminQuant', true, { requiredRole: { code: 'svip', name: 'SVIP' } }), m('adminRadar', true), m('adminAuction', true)]);
const ADMIN_MENUS = USER_MENUS.map((item) => ({ ...item, locked: false })).concat([m('adminRbac')]);

test('mobile bottom nav keeps the cn presentation order', () => {
  assert.deepEqual(
    MOBILE_BOTTOM_NAV_ITEMS.map((item) => item.key),
    ['home', 'markets', 'holdings', 'tradePlans', 'shares', 'fundSwitch', 'notify', 'articles', 'adminQuant', 'adminRadar', 'adminAuction', 'adminRbac'],
  );
});

test('only menus returned by the server appear; dataRepair stays desktop-only', () => {
  const items = resolveMobileBottomNavItems(USER_MENUS);
  assert.deepEqual(items.map((item) => item.key), ['home', 'markets', 'holdings', 'tradePlans', 'shares', 'fundSwitch', 'notify', 'articles', 'adminQuant', 'adminRadar', 'adminAuction']);
  assert.deepEqual(items.filter((item) => item.locked).map((item) => item.key), ['adminQuant', 'adminRadar', 'adminAuction']);
  assert.equal(items.find((item) => item.key === 'adminQuant').requiredRole.code, 'svip');
});

test('guest menus: user features are visible but locked, VIP features absent', () => {
  const items = resolveMobileBottomNavItems(flattenMenus(buildGuestFallback().menus));
  assert.deepEqual(items.map((item) => item.key), ['home', 'markets', 'holdings', 'tradePlans', 'shares', 'fundSwitch', 'notify', 'articles']);
  assert.deepEqual(items.filter((item) => item.locked).map((item) => item.key), ['holdings', 'tradePlans', 'fundSwitch', 'notify']);
});

test('scenario visible list still filters known tabs; unknown server menus are appended by sort', () => {
  const items = resolveMobileBottomNavItems([...USER_MENUS, m('labs', false, { sort: 5, label: '实验室' })], ['home', 'markets']);
  assert.deepEqual(items.map((item) => item.key), ['home', 'markets', 'labs']);
});

test('admin sees the RBAC entry in overflow; fifth slot is reserved for “more”', () => {
  const { directItems, overflowItems } = splitMobileBottomNavItems(ADMIN_MENUS);
  assert.equal(MOBILE_BOTTOM_NAV_MAX_TABS, 5);
  assert.deepEqual(directItems.map((item) => item.key), ['home', 'markets', 'holdings', 'tradePlans']);
  assert.deepEqual(overflowItems.map((item) => item.key), ['shares', 'fundSwitch', 'notify', 'articles', 'adminQuant', 'adminRadar', 'adminAuction', 'adminRbac']);
});

test('no overflow when five or fewer menus are visible', () => {
  const { directItems, overflowItems } = splitMobileBottomNavItems(['home', 'markets', 'holdings', 'tradePlans', 'notify'].map((k) => m(k)));
  assert.equal(directItems.length, 5);
  assert.deepEqual(overflowItems, []);
  assert.deepEqual(splitMobileBottomNavItems([]).directItems, []);
});
