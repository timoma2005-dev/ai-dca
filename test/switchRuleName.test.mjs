import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultSwitchRuleName, validateSwitchRuleName } from '../src/pages/switch/switchRuleName.js';

test('default switch rule name is distinguishable (codes + Beijing time)', () => {
  const now = Date.parse('2026-10-26T07:30:00Z');
  assert.equal(buildDefaultSwitchRuleName('159632', '159501', now), '159632→159501 切换方案 10-26 15:30');
  assert.equal(buildDefaultSwitchRuleName('159632', '', now), '159632 切换方案 10-26 15:30');
});

test('name is required after trim', () => {
  assert.equal(validateSwitchRuleName('   '), '请填写方案名称。');
  assert.equal(validateSwitchRuleName(''), '请填写方案名称。');
  assert.equal(validateSwitchRuleName('纳指轮动'), '');
});

test('duplicate names are rejected, except the rule being edited', () => {
  const rules = [{ id: 'r1', name: '纳指轮动' }, { id: 'r2', name: 'B' }];
  assert.match(validateSwitchRuleName(' 纳指轮动 ', rules), /已有同名方案「纳指轮动」/);
  assert.equal(validateSwitchRuleName('纳指轮动', rules, 'r1'), '');
});
