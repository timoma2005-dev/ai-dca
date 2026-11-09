import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocalMcpUrl, extractToolPayload, createLocalMcpClient } from '../src/app/localMcpClient.js';
import { listTzzbAccounts, parseTzzbPositions, mergePositionsByCode, buildMcpSyncPlan, planRowsToDrafts, fetchTzzbHoldings } from '../src/app/localMcpHoldings.js';

test('normalizes local mcp url', () => {
  assert.equal(normalizeLocalMcpUrl('127.0.0.1:8765'), 'http://127.0.0.1:8765/mcp');
  assert.equal(normalizeLocalMcpUrl('http://localhost:9000/mcp'), 'http://localhost:9000/mcp');
  assert.equal(normalizeLocalMcpUrl('ftp://x'), '');
});

test('extracts structured / text payload', () => {
  assert.deepEqual(extractToolPayload({ structuredContent: { a: 1 } }), { a: 1 });
  assert.deepEqual(extractToolPayload({ structuredContent: { result: [1] } }), [1]);
  assert.deepEqual(extractToolPayload({ content: [{ type: 'text', text: '{"b":2}' }] }), { b: 2 });
  assert.throws(() => extractToolPayload({ isError: true, content: [{ type: 'text', text: '未登录' }] }), /未登录/);
});

test('parses tzzb accounts and positions', () => {
  const accs = listTzzbAccounts({ common: [{ fund_key: '67091641', brokername: '股票账户*4726' }], manual: [{ manual_id: 2238098, manualname: '广发' }], rzrq: [] });
  assert.deepEqual(accs.map((a) => a.args), [{ fund_key: '67091641' }, { manual_id: '2238098' }]);
  const rows = parseTzzbPositions({ stock: { position: [{ code: '513100', name: '纳指ETF', count: '3,000', price: '1.712' }, { code: 'x', count: '1' }, { code: '159696', count: '100', price: '', value: '145' }] }, fund: { error: 'x' } });
  assert.deepEqual(rows, [{ code: '513100', name: '纳指ETF', shares: 3000, price: 1.712 }, { code: '159696', name: '', shares: 100, price: 1.45 }]);
  assert.equal(mergePositionsByCode([rows, [{ code: '513100', name: '', shares: 500, price: 0 }]])[0].shares, 3500);
});

test('builds sync plan: buy delta, sell delta, clear missing exchange only', () => {
  const plan = buildMcpSyncPlan({
    positions: [{ code: '513100', name: 'A', shares: 3000, price: 1.7 }, { code: '159696', name: 'B', shares: 100, price: 1.4 }, { code: '513300', name: 'C', shares: 200, price: 2 }],
    aggregates: [
      { code: '513100', kind: 'exchange', totalShares: 1000 },
      { code: '159696', kind: 'exchange', totalShares: 300 },
      { code: '513300', kind: 'exchange', totalShares: 200 },
      { code: '513500', kind: 'exchange', totalShares: 50, latestNav: 2.1 },
      { code: '000834', kind: 'otc', totalShares: 99 }
    ],
    date: '2026-11-04',
    clearMissing: true
  });
  const byCode = Object.fromEntries(plan.rows.map((r) => [r.code, r]));
  assert.equal(byCode['513100'].type, 'BUY');
  assert.equal(byCode['513100'].delta, 2000);
  assert.equal(byCode['159696'].type, 'SELL');
  assert.equal(byCode['513300'].type, '');
  assert.equal(byCode['513500'].missingInBroker, true);
  assert.equal(byCode['000834'], undefined);
  assert.equal(plan.changeCount, 3);
  const drafts = planRowsToDrafts(plan.rows, '2026-11-04');
  assert.equal(drafts.length, 3);
  assert.ok(drafts.every((d) => d.kind === 'exchange' && d.tags.includes('mcp-sync')));
  assert.equal(drafts.find((d) => d.code === '159696').shares, '200');
});

test('fetchTzzbHoldings speaks streamable http with session id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, sid: init.headers['Mcp-Session-Id'] || '' });
    const headers = new Headers({ 'content-type': 'application/json', 'mcp-session-id': 's1' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
    let result = {};
    if (body.method === 'tools/call') {
      const name = body.params.name;
      if (name === 'tzzb_login_status') result = { structuredContent: { logged_in: true } };
      if (name === 'tzzb_account_list') result = { structuredContent: { common: [{ fund_key: 'k1', brokername: '银河' }] } };
      if (name === 'tzzb_positions') result = { content: [{ type: 'text', text: JSON.stringify({ stock: { position: [{ code: '513100', count: '10', price: '1.5' }] } }) }] };
    }
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`;
    return new Response(sse, { status: 200, headers: new Headers({ 'content-type': 'text/event-stream', 'mcp-session-id': 's1' }) });
  };
  const data = await fetchTzzbHoldings('http://127.0.0.1:8765/mcp', { fetchImpl });
  assert.deepEqual(data.positions, [{ code: '513100', name: '', shares: 10, price: 1.5 }]);
  assert.equal(calls[0].sid, '');
  assert.ok(calls.slice(1).every((c) => c.sid === 's1'));
  assert.deepEqual(calls.filter((c) => c.method === 'tools/call').length, 3);
  assert.ok(createLocalMcpClient('127.0.0.1:1').url.endsWith('/mcp'));
});

test('local MCP is desktop-only', async () => {
  const { isLocalMcpSupportedDevice } = await import('../src/app/localMcpClient.js');
  const mk = (ua, fine = true, extra = {}) => ({ navigator: { userAgent: ua, ...extra }, matchMedia: () => ({ matches: fine }) });
  assert.equal(isLocalMcpSupportedDevice(mk('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130')), true);
  assert.equal(isLocalMcpSupportedDevice(mk('Mozilla/5.0 (Linux; Android 14) Mobile Safari')), false);
  assert.equal(isLocalMcpSupportedDevice(mk('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)')), false);
  assert.equal(isLocalMcpSupportedDevice(mk('Mozilla/5.0 (Macintosh; Intel Mac OS X)', true, { platform: 'MacIntel', maxTouchPoints: 5 })), false);
  assert.equal(isLocalMcpSupportedDevice(mk('Mozilla/5.0 (X11; Linux x86_64)', false)), false);
  assert.equal(isLocalMcpSupportedDevice(null), false);
});

test('trade history → per-trade drafts with dedupe and residual plan', async () => {
  const m = await import('../src/app/localMcpHoldings.js');
  const payload = { records: [
    { entry_date: '2026-11-05', entry_time: '14:30:16', code: '513100', name: '纳指ETF', op: '1', op_name: '买入', entry_price: '2.233', entry_count: '79500', entry_money: '177523.5', market_code: '2', commission: '0', transfer_fee: '0.0', trans_no: '1722551' },
    { entry_date: '20261105', entry_time: '11:01:52', code: '159696', name: '纳指ETF易方达', op: '2', op_name: '卖出', entry_price: '2.069', entry_count: '50000', entry_money: '103450', market_code: '1', commission: '5', trans_no: '1722001' },
    { entry_date: '2026-11-05', code: '159696', op: '3', op_name: '分红', entry_count: '1' }
  ] };
  const trades = m.parseTzzbTradeHistory(payload, 'common:k1');
  assert.equal(trades.length, 2);
  assert.equal(trades[1].date, '2026-11-05');
  assert.equal(trades[1].fee, 5);
  const existing = [{ id: 'x', date: '2026-11-05', code: '159696', type: 'SELL', shares: 50000, price: 2.069 }];
  const { trades: fresh, duplicate } = m.dedupeTrades(trades, existing);
  assert.equal(duplicate, 1);
  assert.equal(fresh.length, 1);
  assert.equal(m.dedupeTrades(trades, [{ id: fresh[0].id }]).duplicate, 1);
  const drafts = m.tradesToDrafts(fresh);
  assert.equal(drafts[0].id, fresh[0].id);
  assert.equal(drafts[0].kind, 'exchange');
  assert.match(drafts[0].note, /14:30:16/);
  assert.ok(drafts[0].tags.includes('mcp-trade'));
  const plan = m.buildMcpSyncPlan({
    positions: [{ code: '513100', name: '纳指ETF', shares: 100000, price: 2.2 }],
    aggregates: [{ code: '513100', kind: 'exchange', totalShares: 20500 }],
    date: '2026-11-05',
    pendingTrades: fresh
  });
  assert.equal(plan.rows[0].delta, 0);
  assert.deepEqual(m.splitDateRange('2026-10-15', '2026-11-05').map((r) => r.start), ['2026-10-15', '2026-11-01']);
});

test('trade dedupe drops repeats within one batch', async () => {
  const m = await import('../src/app/localMcpHoldings.js');
  const t = { accountKey: 'a', transNo: '9', date: '2026-11-05', time: '10:00:00', code: '513100', type: 'BUY', shares: 100, price: 2 };
  assert.equal(m.dedupeTrades([t, { ...t }], []).trades.length, 1);
});

test('fills sharing one order number stay separate; stale adjustments are replaced; negative ledger gets opening buy', async () => {
  const m = await import('../src/app/localMcpHoldings.js');
  const raw = [
    { entry_date: '2026-11-05', entry_time: '11:01:52', code: '159696', op: '2', entry_price: '2.069', entry_count: '50000', market_code: '1', trans_no: '1135801' },
    { entry_date: '2026-11-05', entry_time: '11:01:55', code: '159696', op: '2', entry_price: '2.069', entry_count: '300', market_code: '1', trans_no: '1135801' },
    { entry_date: '2026-11-05', entry_time: '14:30:16', code: '513100', op: '1', entry_price: '2.233', entry_count: '79500', market_code: '2', trans_no: '1722551' }
  ];
  const trades = m.parseTzzbTradeHistory(raw, 'common:k1');
  const existing = [
    { id: 'adj1', date: '2026-11-05', code: '513100', type: 'BUY', shares: 79500, price: 2.229, tags: ['exchange', 'mcp-sync'] },
    { id: 'old', date: '2026-10-29', code: '513100', type: 'SELL', shares: 100, price: 2, tags: ['exchange'] }
  ];
  const stale = m.findStaleAdjustments(existing, '2026-11-05', '2026-11-05');
  assert.deepEqual(stale.map((t) => t.id), ['adj1']);
  const { trades: fresh } = m.dedupeTrades(trades, existing.filter((t) => t.id !== 'adj1'));
  assert.equal(fresh.length, 3);
  const plan = m.buildMcpSyncPlan({
    positions: [{ code: '513100', shares: 79500, price: 2.24 }],
    aggregates: [{ code: '513100', kind: 'exchange', totalShares: 79500 }],
    date: m.dayBefore('2026-11-05'),
    pendingTrades: fresh,
    removedTransactions: stale
  });
  const byCode = Object.fromEntries(plan.rows.map((r) => [r.code, r]));
  assert.equal(byCode['513100'].delta, 0);
  assert.equal(byCode['159696'].type, 'BUY');
  assert.equal(byCode['159696'].delta, 50300);
  assert.equal(byCode['159696'].price, 2.069);
  assert.equal(plan.date, '2026-11-04');
});

test('findExchangeTransactions picks every exchange record for full re-import, leaves OTC alone', async () => {
  const m = await import('../src/app/localMcpHoldings.js');
  const txs = [
    { id: 'a', code: '513100', kind: 'exchange' },
    { id: 'b', code: '159632', tags: ['exchange'] },
    { id: 'c', code: '159659' },
    { id: 'd', code: '021000', tags: ['otc'] },
    { id: 'e', code: '600000', tags: ['mcp-sync'] }
  ];
  assert.deepEqual(m.findExchangeTransactions(txs, ['159659']).map((t) => t.id), ['a', 'b', 'c', 'e']);
});
