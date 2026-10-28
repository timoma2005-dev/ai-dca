/* global Buffer, setImmediate */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDb, createRadarCache, createHandler, validBody, RADAR_PATH, COMPUTE_PATH } from '../services/radar-cache/server.mjs';

const snap = (date, n = 3) => ({ ok: true, data: { date, computedAt: `${date}T13:35:00Z`, etfs: Array.from({ length: n }, (_, i) => ({ code: `51310${i}`, premium: i })) } });

function setup(responses) {
  let t = 1_000_000;
  const calls = [];
  const db = openDb(DatabaseSync, ':memory:');
  const fetchUpstream = async (method, path) => {
    calls.push(`${method} ${path}`);
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { json: r, status: 200, target: 'dns' };
  };
  const cache = createRadarCache({ db, fetchUpstream, now: () => t, log: { warn() {} } });
  return { db, cache, calls, tick: (ms) => { t += ms; } };
}

test('validBody rejects error payloads and empty snapshots', () => {
  assert.equal(validBody('latest', snap('2026-10-27')), true);
  assert.equal(validBody('latest', { ok: false, error: 'forbidden' }), false);
  assert.equal(validBody('latest', snap('2026-10-27', 1)), false);
  assert.equal(validBody('features', { ok: true, data: [] }), true);
});

test('sync stores latest in SQLite with history; reads hit the local copy without upstream', async () => {
  const { db, cache, calls } = setup([snap('2026-10-27')]);
  assert.equal(await cache.sync('latest'), true);
  const out = await cache.read('latest');
  assert.equal(out.status, 200);
  assert.equal(out.headers['x-radar-cache'], 'hit');
  assert.equal(JSON.parse(out.body).data.date, '2026-10-27');
  assert.deepEqual(calls, [`GET ${RADAR_PATH}`], 'fresh read does not touch upstream');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM radar_history').get().n, 1);
});

test('upstream failure keeps serving the last good snapshot and logs the failure', async () => {
  const { db, cache, tick } = setup([snap('2026-10-27'), new Error('read ECONNRESET'), { ok: false, error: 'forbidden' }]);
  await cache.sync('latest');
  tick(5 * 60 * 1000);
  assert.equal(await cache.sync('latest'), false);
  assert.equal(await cache.sync('latest'), false, 'invalid payload never overwrites');
  const out = await cache.read('latest');
  assert.equal(JSON.parse(out.body).data.date, '2026-10-27');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM radar_sync_log WHERE ok = 0').get().n, 2);
});

test('stale read returns local data immediately and refreshes in background', async () => {
  const { cache, calls, tick } = setup([snap('2026-10-27'), snap('2026-10-28')]);
  await cache.sync('latest');
  tick(3 * 60 * 1000);
  const out = await cache.read('latest');
  assert.equal(JSON.parse(out.body).data.date, '2026-10-27');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse((await cache.read('latest')).body).data.date, '2026-10-28');
});

test('empty cache waits for one sync, then 503 when upstream is down', async () => {
  const a = setup([snap('2026-10-27')]);
  const ok = await a.cache.read('latest');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['x-radar-cache'], 'miss');
  const b = setup([new Error('timeout'), new Error('timeout')]);
  const bad = await b.cache.read('latest');
  assert.equal(bad.status, 503);
  assert.equal(JSON.parse(bad.body).ok, false);
});

test('compute result is written to SQLite right away', async () => {
  const { cache } = setup([snap('2026-10-28')]);
  const out = await cache.compute(Buffer.from('{}'));
  assert.equal(out.status, 200);
  assert.equal(JSON.parse((await cache.read('latest')).body).data.date, '2026-10-28');
  assert.equal(cache.health().latest.source, 'compute');
});

test('http handler routes GET/POST and 404s others', async () => {
  const { cache } = setup([snap('2026-10-27')]);
  const handler = createHandler(cache);
  const run = (method, url) => new Promise((resolve) => {
    const res = { writeHead(s, h) { this.s = s; this.h = h; }, end(b) { resolve({ status: this.s, headers: this.h, body: b }); } };
    const req = { method, url, on(ev, f) { if (ev === 'end') setImmediate(f); } };
    handler(req, res);
  });
  const g = await run('GET', `${RADAR_PATH}?t=1`);
  assert.equal(g.status, 200);
  assert.equal(g.headers['cache-control'], 'no-store');
  assert.equal((await run('GET', '/nope')).status, 404);
  assert.equal((await run('GET', COMPUTE_PATH)).status, 404);
});
