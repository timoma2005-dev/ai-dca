import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCellState, applyMenuState, computeEffective, createDraft, diffDraft, groupMenus, isRoleLocked,
  menuCellState, nextMenuState, orderRolesByChain, reorderedSorts,
} from '../src/app/rbac/rbacMatrix.js';
import { describeAuditEntry } from '../src/app/rbac/rbacAudit.js';
import { rbacFixture } from './helpers/rbacFixture.mjs';

const { roles, menus } = rbacFixture();
const role = (code) => roles.find((item) => item.code === code);

test('角色列沿继承链排序，侧枝排在主链之后', () => {
  assert.deepEqual(orderRolesByChain(roles).map((item) => item.code), ['guest', 'user', 'vip', 'svip', 'admin', 'superadmin', 'auction_viewer']);
});

test('有效权限 = 本级 ∪ 父链，并记录来源角色', () => {
  const effective = computeEffective(roles, createDraft(roles));
  assert.equal(effective.superadmin.get('menu:home:access'), 'guest');
  assert.equal(effective.svip.get('menu:adminRadar:access'), 'vip');
  assert.equal(effective.auction_viewer.has('menu:adminRadar:access'), false);
  assert.equal(effective.auction_viewer.get('menu:adminAuction:access'), 'auction_viewer');
});

test('单格三态：本级、继承下限与来源', () => {
  const draft = createDraft(roles);
  const effective = computeEffective(roles, draft);
  assert.deepEqual(menuCellState(role('guest'), 'holdings', draft, effective), { state: 'view', floor: 'none', source: null, inherited: false });
  assert.deepEqual(menuCellState(role('user'), 'holdings', draft, effective), { state: 'access', floor: 'view', source: 'guest', inherited: false });
  assert.deepEqual(menuCellState(role('vip'), 'holdings', draft, effective), { state: 'access', floor: 'access', source: 'user', inherited: true });
  assert.deepEqual(menuCellState(role('user'), 'adminRadar', draft, effective).state, 'view');
  assert.deepEqual(menuCellState(role('guest'), 'adminRbac', draft, effective).state, 'none');
});

test('点击循环不低于继承下限', () => {
  assert.equal(nextMenuState('none'), 'view');
  assert.equal(nextMenuState('view'), 'access');
  assert.equal(nextMenuState('access'), 'none');
  assert.equal(nextMenuState('view', 'view'), 'access');
  assert.equal(nextMenuState('access', 'view'), 'view');
  assert.equal(nextMenuState('access', 'access'), 'access');
});

test('applyMenuState 只写本级缺少的权限，diffDraft 统计改动', () => {
  const draft = createDraft(roles);
  const effective = computeEffective(roles, draft);
  draft.vip = applyMenuState(draft.vip, 'adminAuction', 'access', effective.user);
  assert.deepEqual([...draft.vip].sort(), ['api:nasdaq-radar', 'menu:adminAuction:access', 'menu:adminRadar:access']);
  draft.guest = applyMenuState(draft.guest, 'holdings', 'none', new Map());
  const diff = diffDraft(roles, draft);
  assert.equal(diff.count, 2);
  assert.deepEqual(diff.changes.map((item) => [item.code, item.added, item.removed]), [
    ['guest', [], ['menu:holdings:view']],
    ['vip', ['menu:adminAuction:access'], []],
  ]);
  const after = computeEffective(roles, draft);
  assert.equal(menuCellState(role('user'), 'holdings', draft, after).floor, 'none', '父级取消后子级继承下限随草稿变化');
});

test('接口权限格、特权角色只读', () => {
  const draft = createDraft(roles);
  const effective = computeEffective(roles, draft);
  assert.deepEqual(apiCellState(role('svip'), 'api:sync', draft, effective), { on: true, inherited: true, source: 'user' });
  assert.deepEqual(apiCellState(role('vip'), 'api:paper-trade', draft, effective), { on: false, inherited: false, source: null });
  assert.equal(isRoleLocked(role('admin'), false), true);
  assert.equal(isRoleLocked(role('admin'), true), false);
  assert.equal(isRoleLocked(role('vip'), false), false);
});

test('菜单分组与调序编号', () => {
  const groups = groupMenus(menus);
  assert.deepEqual(groups.map((group) => [group.label, group.menus.length]), [['主导航', 9], ['管理', 4]]);
  const admin = groups[1].menus;
  assert.deepEqual(reorderedSorts(admin), []);
  assert.deepEqual(reorderedSorts([admin[1], admin[0], admin[2], admin[3]]), [
    { key: 'adminRadar', sort: 110, previous: 120 },
    { key: 'adminQuant', sort: 120, previous: 110 },
  ]);
});

test('审计人话描述', () => {
  const names = { roleNames: { vip: 'VIP', svip: 'SVIP' }, menuNames: { notify: '通知管理' } };
  assert.equal(describeAuditEntry({ action: 'role.grant', actorUsername: 'lovexl', targetId: 'usr_1', detail: { username: 'lin', role: 'vip', expiresAt: '2026-12-31T15:59:59.000Z' } }, names), 'lovexl 给 lin 授予 VIP，到期 2026-12-31');
  assert.equal(describeAuditEntry({ action: 'role.grant', actorUsername: 'lovexl', detail: { username: 'lin', role: 'svip', expiresAt: null } }, names), 'lovexl 给 lin 授予 SVIP，长期有效');
  assert.equal(describeAuditEntry({ action: 'role.revoke', actorUsername: 'a', detail: { username: 'b', role: 'vip' } }, names), 'a 撤销了 b 的 VIP');
  assert.equal(describeAuditEntry({ action: 'role.permissions', actorUsername: 'a', targetId: 'vip', detail: { added: ['x', 'y'], removed: ['z'] } }, names), 'a 调整 VIP 的权限：新增 2 项，移除 1 项');
  assert.equal(describeAuditEntry({ action: 'menu.update', actorUsername: 'a', targetId: 'notify', detail: { label: '通知管理', enabled: 0 } }, names), 'a 修改菜单 通知管理（已停用）');
  assert.equal(describeAuditEntry({ action: 'rbac.migrate', actorUsername: null, targetId: '002-rbac', detail: {} }, names), '系统完成权限数据迁移 002-rbac');
});
