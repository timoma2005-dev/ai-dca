import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshRadarQuota, NASDAQ_ETFS } from '../workers/notify/src/nasdaqRadar.js';

function memKv(init = {}) {
  const store = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { store, async get(key, type) { const v = store.get(key); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; }, async put(key, value) { store.set(key, value); } };
}
const pcf = (shares) => ({ subscriptionAllowed: true, totalSubscribeLimitKind: 'limited', totalSubscribeLimitShares: shares });

test('早盘份额刷新：当天 PCF 到齐后用当天申购上限重算评分，只成功一次', async () => {
  const codes = NASDAQ_ETFS.map((m) => m.code);
  const etfs = Object.fromEntries(codes.map((code, i) => [code, { code, name: code, premium: 10 + i * 0.5, latestNav: 2, turnover: 50000 }]));
  const latest = { date: '2026-10-23', etfs: [], scoring: { date: '2026-10-23', etfs: {} } };
  const notify = memKv({ 'nasdaq-radar:latest': latest, 'nasdaq-radar:feature-history:v1': [{ date: '2026-10-23', etfs }], 'nasdaq-radar:history': [] });
  const limits = {};
  for (const code of codes) limits[`etf-pcf:${code}:20261023`] = pcf(3750000);
  const fund = memKv(limits);
  const env = { NOTIFY_STATE: notify, FUND_LIMIT_KV: fund };
  assert.equal((await refreshRadarQuota(env, { today: '2026-10-26' })).skipped, 'pcf-pending');
  for (const code of codes) await fund.put(`etf-pcf:${code}:20261026`, JSON.stringify(pcf(code === '513300' ? 750000 : 3750000)));
  const res = await refreshRadarQuota(env, { today: '2026-10-26' });
  assert.equal(res.refreshed, true);
  const next = await notify.get('nasdaq-radar:latest', 'json');
  assert.equal(next.scoring.quotaDate, '2026-10-26');
  assert.equal(next.scoring.etfs['513300'].quota.state, 'tight');
  assert.equal(next.scoring.etfs['159501'].quota.state, 'steady');
  assert.equal((await refreshRadarQuota(env, { today: '2026-10-26' })).skipped, 'already-refreshed');
  assert.equal((await refreshRadarQuota(env, { today: '2026-10-23' })).skipped, 'snapshot-is-today');
});
