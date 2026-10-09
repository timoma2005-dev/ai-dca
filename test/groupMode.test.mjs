import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupModeStore, HOLDINGS_GROUP_MODE_KEY, TRANSACTIONS_GROUP_MODE_KEY } from '../src/app/groupModeStore.js';
import { groupTransactionsByCompany } from '../src/app/income/transactionCompanyGroups.js';

test('company grouping merges funds, retains date order and totals, and includes unknown companies', () => {
  const rows = [
    { id: '1', name: '华夏成长', type: 'BUY', amount: 100, date: '2026-10-03' },
    { id: '2', name: '未知产品', type: 'SELL', amount: 50, date: '2026-10-02' },
    { id: '3', name: '华夏沪深300', type: 'SELL', price: 2, shares: 30, date: '2026-10-01' },
    { id: '4', name: '华夏成长', type: 'BUY', amount: 200, date: '2026-09-30' },
  ];
  const groups = groupTransactionsByCompany(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, '华夏基金');
  assert.deepEqual(groups[0].rows.map(tx => tx.id), ['1', '3', '4']);
  assert.equal(groups[0].buyCount, 2);
  assert.equal(groups[0].sellCount, 1);
  assert.equal(groups[0].buyAmount, 300);
  assert.equal(groups[0].sellAmount, 60);
  assert.equal(groups[1].name, '未识别基金公司');
  assert.deepEqual(rows.map(tx => tx.id), ['1', '2', '3', '4']);
  const filtered = groupTransactionsByCompany(rows.filter(tx => tx.type === 'BUY'));
  assert.equal(filtered[0].rows.length, 2);
  assert.equal(filtered[0].sellAmount, 0);
  assert.deepEqual(groupTransactionsByCompany([]), []);
});

test('group mode persists, synchronizes subscribers and keeps preferences separate', () => {
  const values = new Map();
  const events = new Map();
  const win = {
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
  };
  const store = createGroupModeStore(HOLDINGS_GROUP_MODE_KEY, () => win);
  assert.equal(store.getSnapshot(), 'company');
  let desktop, mobile;
  const offDesktop = store.subscribe(() => { desktop = store.getSnapshot(); });
  const offMobile = store.subscribe(() => { mobile = store.getSnapshot(); });
  store.setMode('list');
  assert.equal(desktop, 'list');
  assert.equal(mobile, 'list');
  assert.equal(values.get(HOLDINGS_GROUP_MODE_KEY), 'list');
  assert.equal(createGroupModeStore(HOLDINGS_GROUP_MODE_KEY, () => win).getSnapshot(), 'list');
  assert.equal(createGroupModeStore(TRANSACTIONS_GROUP_MODE_KEY, () => win).getSnapshot(), 'company');
  values.set(HOLDINGS_GROUP_MODE_KEY, 'company');
  events.get('storage')({ key: HOLDINGS_GROUP_MODE_KEY });
  assert.equal(mobile, 'company');
  values.set(HOLDINGS_GROUP_MODE_KEY, 'invalid');
  assert.equal(store.getSnapshot(), 'company');
  offDesktop();
  assert.ok(events.has('storage'));
  offMobile();
  assert.equal(events.size, 0);
});

test('blocked localStorage still allows switching', () => {
  const store = createGroupModeStore('blocked', () => ({
    get localStorage() { throw new Error('blocked'); },
  }));
  assert.equal(store.getSnapshot(), 'company');
  store.setMode('list');
  assert.equal(store.getSnapshot(), 'list');
});
