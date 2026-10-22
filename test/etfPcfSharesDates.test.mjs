import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventKey, runEtfPcfEvents } from '../workers/etf-shares/src/etfPcfEvents.js';
import { buildEtfPcfCacheKey, parseEtfPcf } from '../workers/etf-shares/src/etfPcfLimit.js';
import { sharesKey, validateSharesProjection } from '../workers/etf-shares/src/etfPcfSharesProjection.js';

const CACHE_TTL_SECONDS = 400 * 86400;
const today = '2026-10-14';
const at = '2026-10-14T01:00:00.000Z';
const code = '159941';
const text = new TextDecoder('gbk').decode(
  readFileSync(new URL('./fixtures/etf-pcf/ETF15994120261013.gbk.txt', import.meta.url))
);
const dateEvidence = { source: 'szse_fund_report', column: '日期', type: 'iso_date' };
const row = (date, shares) => ({ code, date, shares, unit: '份', dateEvidence });
const datedSource = (records) => ({ ok: true, source: 'szse_fund_report', fetchedAt: at, records });
function pcf(date = today, overrides = {}) {
  const source =
    date === today ? text.replaceAll('20261013', '20261014').replaceAll('2026-10-13', today) : text;
  const fetchedAt = `${date}T01:00:00.000Z`;
  return {
    ...parseEtfPcf(source, { code, date }),
    fetchedAt,
    expiresAt: new Date(Date.parse(fetchedAt) + CACHE_TTL_SECONDS * 1000).toISOString(),
    totalSubscribeLimitKind: 'limited',
    totalSubscribeLimitShares: 10000000,
    subscriptionAllowed: true,
    redemptionAllowed: true,
    ...overrides
  };
}
function kv() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    }
  };
}
async function run(store, sharesFetch, pcfs = [pcf()]) {
  const result = await runEtfPcfEvents({
    env: { FUND_LIMIT_KV: store },
    scheduledTime: Date.parse(at),
    detectedAt: at,
    pcfs,
    sharesFetch
  });
  assert.equal(result.ok, true);
  return result;
}
function projection(store, date = today) {
  const data = JSON.parse(store.values.get(sharesKey(date)));
  assert.equal(validateSharesProjection(data), true);
  return { data, record: data.records.find((r) => r.code === code) };
}

test('dated same-day shares survive collection and projection; same-day limits and creation status align', async () => {
  const store = kv();
  store.values.set(
    eventKey('2026-10-13', 'limits'),
    JSON.stringify({
      schemaVersion: 1,
      source: 'szse_pcf',
      date: '2026-10-13',
      fetchedAt: at,
      records: [
        {
          code,
          date: '2026-10-13',
          total: { kind: 'limited', shares: 50000000 },
          net: { kind: 'unlimited', shares: null },
          subscriptionAllowed: false
        }
      ]
    })
  );
  let calls = 0;
  await run(store, async () => {
    calls++;
    return datedSource([row(today, 21000000), row('2026-10-13', 11000000), row('2026-10-15', 31000000)]);
  });
  assert.equal(calls, 1);
  const { data, record } = projection(store);
  assert.equal(data.date, today);
  assert.equal(data.prevDate, '2026-10-13');
  assert.equal(data.availableOn, today);
  assert.equal(data.records.length, 13);
  assert.equal(record.deltaShares, 10000000);
  assert.equal(record.totalLimitShares, 10000000);
  assert.equal(record.limitDate, today);
  assert.equal(record.atLimit, true);
  assert.equal(record.creationShares, 10000000);
  assert.equal(record.creationSharesKind, 'estimate');
  assert.equal(JSON.parse(store.values.get('etf-pcf-shares:latest')).date, today);
  assert.equal(store.values.has(eventKey(today, 'shares')), true);
  assert.equal(store.values.has(sharesKey('2026-10-15')), false);
  const log = JSON.parse(store.values.get(eventKey(today)));
  assert.ok(log.events.some((e) => e.signal_type === 'net_creation_near_total_limit' && e.code === code));
  assert.ok(log.checks.some((c) => c.signal_type === 'limit_relaxation' && c.code === code));
});

test('shares collection does not depend on a current PCF or historical ceiling baseline', async () => {
  const store = kv();
  await run(store, async () => datedSource([row(today, 200), row('2026-10-13', 100)]), []);
  const { record } = projection(store);
  assert.equal(record.deltaShares, 100);
  assert.equal(record.totalLimitKind, 'unknown');
  assert.equal(record.creationShares, null);
  assert.equal(record.atLimit, null);
});

test('cached prior sessions cannot suppress fallback; historical request includes today and refreshed prior shares win', async () => {
  const store = kv();
  for (const date of ['2026-10-12', '2026-10-13']) {
    store.values.set(
      eventKey(date, 'shares'),
      JSON.stringify({
        schemaVersion: 1,
        source: 'szse_fund_report',
        date,
        fetchedAt: at,
        records: [row(date, 100)]
      })
    );
  }
  const urls = [];
  await run(store, async ({ url }) => {
    urls.push(url);
    return urls.length === 1
      ? { ok: false, reason: 'missing_report_date' }
      : datedSource([row(today, 250), row('2026-10-13', 150)]);
  });
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]).searchParams.get('txtEnd'), today);
  const { record } = projection(store);
  assert.equal(record.prevShares, 150);
  assert.equal(record.deltaShares, 100);
});

test('T-1 report keeps its real date and uses matching historical PCF even after its live TTL', async () => {
  const store = kv();
  store.values.set(
    buildEtfPcfCacheKey(code, '2026-10-13'),
    JSON.stringify(
      pcf('2026-10-13', {
        expiresAt: '2026-10-14T00:00:00.000Z',
        totalSubscribeLimitShares: 5000000
      })
    )
  );
  await run(store, async () => datedSource([row('2026-10-13', 15000000), row('2026-10-12', 10000000)]), [
    pcf(today, { subscriptionAllowed: false })
  ]);
  const { data, record } = projection(store, '2026-10-13');
  assert.equal(data.availableOn, today);
  assert.equal(data.date, '2026-10-13');
  assert.equal(record.limitDate, '2026-10-13');
  assert.equal(record.totalLimitShares, 5000000);
  assert.equal(record.creationShares, 5000000);
  assert.equal(record.creationSharesKind, 'estimate');
  assert.equal(record.atLimit, true);
  assert.equal(store.values.has(sharesKey(today)), false);
});

test('wrong-source and wrong-date cached PCFs never lend their limits or subscription state to an old report', async () => {
  for (const invalid of [{ source: 'sse_pcf' }, { date: today }]) {
    const store = kv();
    store.values.set(buildEtfPcfCacheKey(code, '2026-10-13'), JSON.stringify(pcf('2026-10-13', invalid)));
    await run(store, async () => datedSource([row('2026-10-13', 200), row('2026-10-12', 100)]), [
      pcf(today, { subscriptionAllowed: false })
    ]);
    const { record } = projection(store, '2026-10-13');
    assert.equal(record.totalLimitKind, 'unknown');
    assert.equal(record.limitDate, null);
    assert.equal(record.creationShares, null);
  }
});

test('same-day shares without the confirmed prior session cannot manufacture a delta', async () => {
  const store = kv();
  await run(store, async () => datedSource([row(today, 200), row('2026-10-12', 100)]), [
    pcf(today, { totalSubscribeLimitShares: 100 })
  ]);
  const { record } = projection(store);
  assert.equal(record.shares, 200);
  assert.equal(record.prevShares, null);
  assert.equal(record.deltaShares, null);
  assert.equal(record.creationShares, null);
  assert.equal(record.atLimit, null);
  const log = JSON.parse(store.values.get(eventKey(today)));
  assert.equal(
    log.events.some((event) => event.code === code && event.signal_type === 'net_creation_near_total_limit'),
    false
  );
});

test('a current report with a missing adjacent session still fetches the historical comparison', async () => {
  const store = kv();
  let calls = 0;
  await run(store, async () => {
    calls++;
    return datedSource(calls === 1 ? [row(today, 200)] : [row(today, 200), row('2026-10-13', 100)]);
  });
  assert.equal(calls, 2);
  assert.equal(projection(store).record.deltaShares, 100);
});
