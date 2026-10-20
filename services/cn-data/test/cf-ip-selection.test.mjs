// Tests for the CF Worker IPv4 selection transport (docs/plan-cf-ip-selection.md
// section 7, Node cases). Everything runs against fake dns/probe/request impls;
// no real sockets and no cross-border network are touched.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCfWorkerTransport } from '../src/cfIpSelection.js';
import { openDb, closeDb } from '../src/db.js';
import { enqueueEvent, outboxStats } from '../src/outbox.js';
import { processOnce, daemonConfig } from '../src/syncDaemon.js';

const SYNC_HOST = 'api.freebacktrack.tech';
const SYNC_URL = `https://${SYNC_HOST}/api/sync/internal/sync-backup`;

function fakeClock(startMs = 1000) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFakeIncomingMessage({ status = 200, statusMessage = 'OK', headers = {} } = {}) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.statusMessage = statusMessage;
  res.headers = headers;
  res.destroy = (err) => {
    res.emit('error', err || new Error('destroyed'));
  };
  return res;
}

// Fake https.request: records each call and runs a per-call script on a later
// tick, because the real client never emits socket/response events synchronously.
function makeFakeRequest(script) {
  const calls = [];
  const impl = (opts, onResponse) => {
    const req = new EventEmitter();
    const call = { opts, req, endedBody: undefined, destroyedWith: undefined, hadEndListener: false };
    req.end = (body) => {
      call.endedBody = body === undefined ? null : Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    };
    req.destroy = (err) => {
      call.destroyedWith = err;
      if (err) req.emit('error', err);
      else req.emit('close');
    };
    calls.push(call);
    setImmediate(() => script(call, onResponse));
    return req;
  };
  impl.calls = calls;
  return impl;
}

// Fresh TLS socket + full success response.
function respondSuccess({ status = 200, statusMessage = 'OK', headers = {}, body = '{"ok":true}' } = {}) {
  return (call, onResponse) => {
    const sock = new EventEmitter();
    call.req.emit('socket', sock);
    sock.emit('secureConnect');
    setImmediate(() => {
      const res = makeFakeIncomingMessage({ status, statusMessage, headers, body });
      onResponse(res);
      setImmediate(() => {
        res.emit('data', Buffer.from(body));
        // emit() returns true only when somebody consumed the event, which
        // proves the transport drains bodies even when nobody reads them.
        call.hadEndListener = res.emit('end');
      });
    });
  };
}

// Connection dies before the TLS handshake: the request was never written.
function respondConnectFailure(code = 'ECONNREFUSED') {
  return (call) => {
    const sock = new EventEmitter();
    call.req.emit('socket', sock);
    setImmediate(() => {
      const err = new Error(`connect ${code} ${call.opts.hostname}`);
      err.code = code;
      call.req.emit('error', err);
    });
  };
}

// TLS established, request written, then the connection breaks: result
// unknown, the POST must not be transparently resent.
function respondAfterWriteFailure() {
  return (call) => {
    const sock = new EventEmitter();
    call.req.emit('socket', sock);
    sock.emit('secureConnect');
    setImmediate(() => {
      const err = new Error('read ECONNRESET');
      err.code = 'ECONNRESET';
      call.req.emit('error', err);
    });
  };
}

// The request reaches the server but no response ever arrives (for abort tests).
function respondNothing() {
  return (call) => {
    const sock = new EventEmitter();
    call.req.emit('socket', sock);
    sock.emit('secureConnect');
  };
}

// Resolve what the pinned agent's custom lookup would dial for `hostname`.
function pinnedIpOf(call, hostname = SYNC_HOST) {
  const lookup = call.opts.agent?.options?.lookup;
  assert.ok(lookup, 'pinned agent must install a custom lookup');
  return new Promise((resolve, reject) => {
    lookup(hostname, { family: 4 }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses[0]?.address);
    });
  });
}

function createHarness({ env, dns = [], latencies = {}, clock, script } = {}) {
  const clockImpl = clock ?? fakeClock();
  const dnsCalls = [];
  const probeCalls = [];
  const requestImpl = makeFakeRequest(script ?? respondSuccess());
  const transport = createCfWorkerTransport({
    env: { CF_UPSTREAM_IP_SELECTION_ENABLED: '1', ...env },
    dnsLookup: async (host) => {
      dnsCalls.push(host);
      return typeof dns === 'function' ? dns(host) : dns;
    },
    probe: async (ip, ctx) => {
      probeCalls.push({ ip, host: ctx?.host, signal: ctx?.signal });
      return typeof latencies === 'function' ? latencies(ip, ctx) : (latencies[ip] ?? null);
    },
    requestImpl,
    clock: clockImpl,
  });
  return { transport, clock: clockImpl, dnsCalls, probeCalls, requestImpl, requestCalls: requestImpl.calls };
}

async function withGlobalFetchStub(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

describe('cfIpSelection: switch and routing', () => {
  it('disabled switch delegates to the original fetch without any probing', async () => {
    const h = createHarness({ env: { CF_UPSTREAM_IP_SELECTION_ENABLED: '0' } });
    await withGlobalFetchStub(async () => new Response('{}', { status: 200 }), async (fetchCalls) => {
      const res = await h.transport.fetch(SYNC_URL, { method: 'POST', body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, SYNC_URL);
      assert.equal(fetchCalls[0].init.body, '{}');
      await h.transport.prepare([SYNC_URL]);
      assert.equal(h.dnsCalls.length, 0);
      assert.equal(h.probeCalls.length, 0);
      assert.equal(h.requestCalls.length, 0);
    });
  });

  it('unset switch behaves exactly like disabled', async () => {
    const h = createHarness({ env: { CF_UPSTREAM_IP_SELECTION_ENABLED: undefined } });
    await withGlobalFetchStub(async () => new Response('{}', { status: 200 }), async (fetchCalls) => {
      await h.transport.fetch(SYNC_URL, {});
      assert.equal(fetchCalls.length, 1);
      assert.equal(h.probeCalls.length, 0);
    });
  });

  it('HTTP, non-allowed hosts, IP literals and credential URLs stay on the original client', async () => {
    const h = createHarness({});
    await withGlobalFetchStub(async () => new Response('{}', { status: 200 }), async (fetchCalls) => {
      await h.transport.fetch('http://api.freebacktrack.tech/api/sync/internal/sync-backup', {});
      await h.transport.fetch('https://other.example/x', {});
      await h.transport.fetch('https://104.21.38.17/x', {});
      await h.transport.fetch('https://user:pass@api.freebacktrack.tech/x', {});
      assert.equal(fetchCalls.length, 4);
      assert.equal(h.dnsCalls.length, 0);
      assert.equal(h.probeCalls.length, 0);
      assert.equal(h.requestCalls.length, 0);
    });
  });

  it('non-replayable bodies and unsupported methods stay on the original client', async () => {
    const h = createHarness({});
    await withGlobalFetchStub(async () => new Response('{}', { status: 200 }), async (fetchCalls) => {
      await h.transport.fetch(SYNC_URL, { method: 'POST', body: { opaque: true } });
      await h.transport.fetch(SYNC_URL, { method: 'PUT', body: 'x' });
      assert.equal(fetchCalls.length, 2);
      assert.equal(h.requestCalls.length, 0);
    });
  });
});

describe('cfIpSelection: candidate pool', () => {
  it('puts live A records first, then the static pool, deduped and IPv4-only', async () => {
    const h = createHarness({
      dns: ['203.0.113.9', '104.21.38.17', '2001:db8::1'],
      latencies: { '203.0.113.9': 40, '104.21.38.17': 20, '172.67.217.77': 60 },
    });
    const res = await h.transport.fetch(SYNC_URL, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.deepEqual(h.probeCalls.map((c) => c.ip), ['203.0.113.9', '104.21.38.17', '172.67.217.77']);
    assert.equal(await pinnedIpOf(h.requestCalls[0]), '104.21.38.17'); // fastest wins
  });

  it('filters invalid static pool entries and keeps valid IPv4', async () => {
    const h = createHarness({
      env: { CF_UPSTREAM_IPS: 'not-an-ip,::1,1.2.3.4.5, 104.21.38.17 ,,172.67.217.77' },
      dns: [],
      latencies: { '172.67.217.77': 30 },
    });
    await h.transport.fetch(SYNC_URL, {});
    assert.deepEqual(h.probeCalls.map((c) => c.ip), ['104.21.38.17', '172.67.217.77']);
  });

  it('falls back to the static pool when DNS fails', async () => {
    const h = createHarness({
      dns: async () => {
        throw new Error('query A ENOTFOUND api.freebacktrack.tech');
      },
      latencies: { '172.67.217.77': 30 },
    });
    const res = await h.transport.fetch(SYNC_URL, {});
    assert.equal(res.status, 200);
    assert.equal(await pinnedIpOf(h.requestCalls[0]), '172.67.217.77');
  });

  it('keeps the first candidate (degraded) when every probe fails', async () => {
    const h = createHarness({ dns: [], latencies: {} });
    await h.transport.fetch(SYNC_URL, {});
    assert.equal(await pinnedIpOf(h.requestCalls[0]), '104.21.38.17');
  });

  it('empty candidate pool skips pinning entirely and uses plain DNS', async () => {
    const h = createHarness({ env: { CF_UPSTREAM_IPS: '' }, dns: [] });
    await withGlobalFetchStub(async () => new Response('{}', { status: 200 }), async (fetchCalls) => {
      const res = await h.transport.fetch(SYNC_URL, { method: 'POST', body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, SYNC_URL);
      assert.equal(fetchCalls[0].init.body, '{}');
      assert.equal(h.probeCalls.length, 0);
      assert.equal(h.requestCalls.length, 0);
    });
  });

  it('keeps defaults and warns once on invalid config values', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const clock = fakeClock();
      const h = createHarness({
        env: { CF_UPSTREAM_PROBE_TIMEOUT: 'abc', CF_UPSTREAM_RESELECT_INTERVAL: '-5' },
        clock,
        dns: ['203.0.113.9'],
      });
      await h.transport.fetch(SYNC_URL, {});
      clock.advance(299_000);
      await h.transport.fetch(SYNC_URL, {});
      assert.equal(h.requestCalls.length, 2);
      assert.equal(h.probeCalls.length, 3); // default 300s TTL still in effect
      assert.ok(errors.some((line) => line.includes('CF_UPSTREAM_PROBE_TIMEOUT')));
      assert.ok(errors.some((line) => line.includes('CF_UPSTREAM_RESELECT_INTERVAL')));
      const warnings = errors.filter((line) => line.includes('config warning'));
      assert.equal(warnings.length, 2); // warn once per bad value
    } finally {
      console.error = originalError;
    }
  });
});

describe('cfIpSelection: per-origin cache and TTL', () => {
  it('reuses a fresh selection within the TTL and re-probes after expiry', async () => {
    const clock = fakeClock();
    const h = createHarness({ dns: ['203.0.113.9'], latencies: { '203.0.113.9': 10 }, clock });
    await h.transport.fetch(SYNC_URL, {});
    assert.equal(h.probeCalls.length, 3);
    clock.advance(299_000);
    await h.transport.fetch(SYNC_URL, {});
    await h.transport.prepare([SYNC_URL]);
    assert.equal(h.probeCalls.length, 3); // TTL hit: no new round
    clock.advance(2_000);
    await h.transport.fetch(SYNC_URL, {});
    assert.equal(h.probeCalls.length, 6); // TTL expired: re-probe
    assert.equal(h.dnsCalls.length, 2);
  });

  it('probes an origin only once for concurrent fetches (singleflight)', async () => {
    const h = createHarness({ dns: ['203.0.113.9'] });
    const results = await Promise.all([
      h.transport.fetch(SYNC_URL, {}),
      h.transport.fetch(SYNC_URL, {}),
      h.transport.fetch(SYNC_URL, {}),
    ]);
    assert.equal(results.length, 3);
    assert.equal(h.dnsCalls.length, 1);
    assert.deepEqual(h.probeCalls.map((c) => c.ip), ['203.0.113.9', '104.21.38.17', '172.67.217.77']);
    assert.equal(h.requestCalls.length, 3);
  });

  it('isolates selections per origin', async () => {
    const h = createHarness({
      dns: (host) => (host === 'fast.freebacktrack.tech' ? ['198.51.100.7'] : ['203.0.113.9']),
      latencies: (ip) => (ip === '203.0.113.9' || ip === '198.51.100.7' ? 5 : 50),
    });
    await h.transport.prepare(['https://api.freebacktrack.tech/a', 'https://fast.freebacktrack.tech/b']);
    assert.deepEqual([...h.dnsCalls].sort(), ['api.freebacktrack.tech', 'fast.freebacktrack.tech']);
    assert.equal(h.probeCalls.filter((c) => c.host === 'api.freebacktrack.tech').length, 3);
    assert.equal(h.probeCalls.filter((c) => c.host === 'fast.freebacktrack.tech').length, 3);
    await h.transport.fetch('https://api.freebacktrack.tech/a', {});
    await h.transport.fetch('https://fast.freebacktrack.tech/b', {});
    assert.equal(await pinnedIpOf(h.requestCalls[0]), '203.0.113.9');
    assert.equal(await pinnedIpOf(h.requestCalls[1], 'fast.freebacktrack.tech'), '198.51.100.7');
  });
});

describe('cfIpSelection: connection failure and retry', () => {
  it('excludes the failed IP, reselects and retries exactly once with the same body', async () => {
    let callIndex = 0;
    const h = createHarness({
      dns: ['203.0.113.10'],
      latencies: { '203.0.113.10': 5, '104.21.38.17': 50, '172.67.217.77': 60 },
      script: (call, onResponse) => {
        callIndex += 1;
        if (callIndex === 1) respondConnectFailure()(call, onResponse);
        else respondSuccess()(call, onResponse);
      },
    });
    const res = await h.transport.fetch(SYNC_URL, { method: 'POST', body: '{"eventId":"evt_1"}' });
    assert.equal(res.status, 200);
    assert.equal(h.requestCalls.length, 2);
    assert.equal(await pinnedIpOf(h.requestCalls[0]), '203.0.113.10');
    assert.equal(await pinnedIpOf(h.requestCalls[1]), '104.21.38.17');
    const retryRound = h.probeCalls.slice(3).map((c) => c.ip);
    assert.deepEqual([...retryRound].sort(), ['104.21.38.17', '172.67.217.77']); // failed IP excluded
    assert.equal(h.requestCalls[0].endedBody, '{"eventId":"evt_1"}');
    assert.equal(h.requestCalls[1].endedBody, '{"eventId":"evt_1"}'); // replayed verbatim
  });

  it('single-candidate pool: the second attempt goes through plain DNS', async () => {
    const h = createHarness({
      env: { CF_UPSTREAM_IPS: '104.21.38.17' },
      dns: [],
      script: respondConnectFailure(),
    });
    await withGlobalFetchStub(async () => new Response('{"via":"dns"}', { status: 200 }), async (fetchCalls) => {
      const res = await h.transport.fetch(SYNC_URL, { method: 'POST', body: '{}' });
      assert.equal(res.status, 200);
      assert.ok(res.ok);
      assert.equal(h.requestCalls.length, 1); // exactly one pinned attempt
      assert.equal(fetchCalls.length, 1); // then plain DNS
      assert.equal(fetchCalls[0].url, SYNC_URL);
      assert.equal(fetchCalls[0].init.body, '{}');
      await res.text();
    });
  });

  it('does not transparently resend a POST that broke after it was written', async () => {
    const h = createHarness({ dns: [], script: respondAfterWriteFailure() });
    await withGlobalFetchStub(async () => new Response('{}', { status: 200 }), async (fetchCalls) => {
      await assert.rejects(
        h.transport.fetch(SYNC_URL, { method: 'POST', body: '{"eventId":"evt_2"}' }),
        (err) => err.code === 'ECONNRESET'
      );
      assert.equal(h.requestCalls.length, 1); // exactly one attempt, no resend
      assert.equal(fetchCalls.length, 0); // and no hidden DNS fallback either
    });
  });

  it('abort during the request destroys it with an AbortError', async () => {
    const controller = new AbortController();
    const h = createHarness({ dns: [], script: respondNothing() });
    const pending = h.transport.fetch(SYNC_URL, { method: 'POST', body: '{}', signal: controller.signal });
    await tick(); // let the fake request establish TLS and hang
    controller.abort();
    await assert.rejects(pending, (err) => err.name === 'AbortError');
    assert.equal(h.requestCalls[0].destroyedWith?.name, 'AbortError');
  });

  it('abort during probing cancels the round and propagates AbortError', async () => {
    const controller = new AbortController();
    const h = createHarness({ dns: [], latencies: () => new Promise(() => {}) });
    const pending = h.transport.fetch(SYNC_URL, { signal: controller.signal });
    await tick(); // probes started and hanging
    assert.ok(h.probeCalls.length > 0);
    controller.abort();
    await assert.rejects(pending, (err) => err.name === 'AbortError');
    assert.equal(h.probeCalls[0].signal.aborted, true); // probes got the cancel signal
    assert.equal(h.requestCalls.length, 0);
  });

  it('an already-aborted signal rejects without any probing', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = createHarness({ dns: ['203.0.113.9'] });
    await assert.rejects(h.transport.fetch(SYNC_URL, { signal: controller.signal }), (err) => err.name === 'AbortError');
    assert.equal(h.dnsCalls.length, 0);
    assert.equal(h.probeCalls.length, 0);
    assert.equal(h.requestCalls.length, 0);
  });

  it('bounds the DNS wait by the round budget (deadline ignores late A records)', async () => {
    const h = createHarness({
      env: { CF_UPSTREAM_PROBE_TIMEOUT: '0.05' },
      dns: () => new Promise(() => {}), // DNS never answers
      latencies: { '104.21.38.17': 10 },
    });
    const res = await h.transport.fetch(SYNC_URL, {});
    assert.equal(res.status, 200);
    assert.equal(h.probeCalls.length, 0); // budget spent in DNS: probes skipped
    assert.equal(await pinnedIpOf(h.requestCalls[0]), '104.21.38.17'); // first static, degraded
  });
});

describe('cfIpSelection: pinned request fidelity', () => {
  it('keeps real hostname SNI/Host, pins the IP and never weakens certificate validation', async () => {
    const h = createHarness({ dns: ['203.0.113.9'], latencies: { '203.0.113.9': 8 } });
    const body = JSON.stringify({ eventId: 'evt_3', eventType: 'upsert', payload: { user_id: 'dudu' } });
    const res = await h.transport.fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
      body,
    });
    assert.equal(res.status, 200);
    const opts = h.requestCalls[0].opts;
    assert.equal(opts.hostname, SYNC_HOST);
    assert.equal(opts.servername, SYNC_HOST); // SNI/cert validation on the real domain
    assert.equal(opts.headers.Host, SYNC_HOST); // Host from the real URL
    assert.notEqual(opts.rejectUnauthorized, false); // validation never disabled
    assert.equal(opts.method, 'POST');
    assert.equal(opts.path, '/api/sync/internal/sync-backup');
    assert.equal(opts.headers.Authorization, 'Bearer secret-token');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.equal(h.requestCalls[0].endedBody, body);
    assert.equal(await pinnedIpOf(h.requestCalls[0]), '203.0.113.9');
    assert.equal(opts.agent?.options?.keepAlive, true);
  });

  it('includes the port in Host for non-default ports', async () => {
    const h = createHarness({ dns: ['203.0.113.9'] });
    await h.transport.fetch('https://api.freebacktrack.tech:8443/api/x', { method: 'POST', body: 'x' });
    const opts = h.requestCalls[0].opts;
    assert.equal(opts.port, 8443);
    assert.equal(opts.headers.Host, 'api.freebacktrack.tech:8443');
  });

  it('exposes the fetch-like response contract the daemon needs', async () => {
    const h = createHarness({
      dns: [],
      script: respondSuccess({ status: 503, statusMessage: 'Service Unavailable', headers: { 'retry-after': '120' }, body: 'slow down' }),
    });
    const res = await h.transport.fetch(SYNC_URL, {});
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(res.statusText, 'Service Unavailable');
    assert.equal(res.headers.get('Retry-After'), '120'); // case-insensitive
    assert.equal(res.headers.get('missing-header'), null);
    assert.equal(await res.text(), 'slow down');
  });

  it('drains and releases success responses nobody reads', async () => {
    const h = createHarness({ dns: [] });
    const res = await h.transport.fetch(SYNC_URL, {});
    await tick();
    await tick();
    assert.equal(h.requestCalls[0].hadEndListener, true); // stream was consumed to the end
    assert.equal(await res.text(), '{"ok":true}'); // a late read still works
  });

  it('body.cancel() aborts an unread body', async () => {
    const h = createHarness({ dns: [], script: respondSuccess({ body: 'x'.repeat(64) }) });
    const res = await h.transport.fetch(SYNC_URL, {});
    res.body.cancel();
    await assert.rejects(res.text(), (err) => err.name === 'AbortError');
  });
});

describe('cfIpSelection: agent reuse and cleanup', () => {
  it('reuses one agent per (origin, ip) and retires old idle sockets on IP change', async () => {
    const clock = fakeClock();
    const latencyMap = { '203.0.113.9': 10, '104.21.38.17': 50, '172.67.217.77': 60 };
    const h = createHarness({ dns: ['203.0.113.9'], latencies: (ip) => latencyMap[ip], clock });
    await h.transport.fetch(SYNC_URL, {});
    await h.transport.fetch(SYNC_URL, {});
    const firstAgent = h.requestCalls[0].opts.agent;
    assert.equal(h.requestCalls[1].opts.agent, firstAgent); // keep-alive agent reused
    // Simulate an idle pooled socket on the old agent, then reselect a new IP.
    const idleSocket = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    firstAgent.freeSockets['api.freebacktrack.tech:443::'] = [idleSocket];
    clock.advance(301_000); // TTL expired
    latencyMap['203.0.113.9'] = 500; // next round has a different winner
    await h.transport.fetch(SYNC_URL, {});
    const newAgent = h.requestCalls[2].opts.agent;
    assert.notEqual(newAgent, firstAgent);
    assert.equal(idleSocket.destroyed, true); // old idle connection retired
    assert.equal(await pinnedIpOf(h.requestCalls[2]), '104.21.38.17');
  });

  it('close() destroys pooled sockets and clears state', async () => {
    const h = createHarness({ dns: [] });
    await h.transport.fetch(SYNC_URL, {});
    const agent = h.requestCalls[0].opts.agent;
    const idleSocket = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    agent.freeSockets['api.freebacktrack.tech:443::'] = [idleSocket];
    h.transport.close();
    assert.equal(idleSocket.destroyed, true);
  });
});

describe('cfIpSelection: controlled copy', () => {
  it('stays byte-identical to services/auth/src/cfIpSelection.js', () => {
    // The two services deploy as independent /opt copies, so the module is a
    // controlled copy rather than a shared package (plan section 3); this
    // check forces the copies to be re-synced in the same change if one drifts.
    const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.equal(read('../src/cfIpSelection.js'), read('../../auth/src/cfIpSelection.js'));
  });
});

describe('syncDaemon: cf transport integration', () => {
  const TOKEN = 'secret-token';
  const sameHostBases = {
    notify: 'https://api.freebacktrack.tech',
    account: 'https://api.freebacktrack.tech',
    sync: 'https://api.freebacktrack.tech',
  };
  const configOn = (bases) =>
    daemonConfig({
      INTERNAL_SYNC_TOKEN: TOKEN,
      SYNC_DAEMON_NOTIFY_URL: bases.notify,
      SYNC_DAEMON_ACCOUNT_URL: bases.account,
      SYNC_DAEMON_SYNC_URL: bases.sync,
    });

  it('probes a shared origin only once for a batch of three targets', async () => {
    const config = configOn(sameHostBases);
    // Endpoint construction from the bases is unchanged.
    assert.equal(config.urls.notify, 'https://api.freebacktrack.tech/api/notify/internal/sync-rules');
    assert.equal(config.urls.account, 'https://api.freebacktrack.tech/api/account/internal/sync');
    assert.equal(config.urls.sync, 'https://api.freebacktrack.tech/api/sync/internal/sync-backup');
    const h = createHarness({ dns: ['203.0.113.9'], latencies: { '203.0.113.9': 10 } });
    const db = openDb(':memory:');
    try {
      const ids = ['notify', 'account', 'sync'].map((target) => enqueueEvent(db, target, 'upsert', { user_id: 'u' }));
      const result = await processOnce(db, { config, cfTransport: h.transport });
      assert.deepEqual(result, { processed: 3, failed: 0, dead: 0 });
      assert.equal(outboxStats(db).pending, 0);
      assert.equal(h.dnsCalls.length, 1); // three targets, one origin: one round
      assert.deepEqual(h.probeCalls.map((c) => c.ip), ['203.0.113.9', '104.21.38.17', '172.67.217.77']);
      assert.equal(h.requestCalls.length, 3);
      const bodies = new Map();
      for (const call of h.requestCalls) {
        assert.equal(call.opts.hostname, 'api.freebacktrack.tech');
        assert.equal(call.opts.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(await pinnedIpOf(call), '203.0.113.9');
        bodies.set(call.opts.path, JSON.parse(call.endedBody));
      }
      assert.deepEqual([...bodies.keys()].sort(), [
        '/api/account/internal/sync',
        '/api/notify/internal/sync-rules',
        '/api/sync/internal/sync-backup',
      ]);
      // Selection must not change the eventId/eventType/payload of any target.
      assert.equal(bodies.get('/api/notify/internal/sync-rules').eventId, ids[0]);
      assert.equal(bodies.get('/api/account/internal/sync').eventId, ids[1]);
      assert.equal(bodies.get('/api/sync/internal/sync-backup').eventId, ids[2]);
      assert.equal(bodies.get('/api/notify/internal/sync-rules').eventType, 'upsert');
      assert.deepEqual(bodies.get('/api/notify/internal/sync-rules').payload, { user_id: 'u' });
    } finally {
      closeDb(db);
    }
  });

  it('isolates selections per origin when the three targets use different origins', async () => {
    const config = configOn({
      notify: 'https://api.freebacktrack.tech',
      account: 'https://fast.freebacktrack.tech',
      sync: 'https://api.freebacktrack.tech:8443', // same host, different port: its own origin
    });
    const h = createHarness({
      dns: (host) => (host === 'fast.freebacktrack.tech' ? ['198.51.100.7'] : ['203.0.113.9']),
      latencies: (ip) => (ip === '203.0.113.9' || ip === '198.51.100.7' ? 10 : 60),
    });
    const db = openDb(':memory:');
    try {
      for (const target of ['notify', 'account', 'sync']) enqueueEvent(db, target, 'upsert', {});
      const result = await processOnce(db, { config, cfTransport: h.transport });
      assert.deepEqual(result, { processed: 3, failed: 0, dead: 0 });
      assert.equal(h.dnsCalls.length, 3); // one round per origin
      assert.deepEqual([...h.dnsCalls].sort(), ['api.freebacktrack.tech', 'api.freebacktrack.tech', 'fast.freebacktrack.tech']);
      assert.equal(h.probeCalls.filter((c) => c.host === 'api.freebacktrack.tech').length, 6);
      assert.equal(h.probeCalls.filter((c) => c.host === 'fast.freebacktrack.tech').length, 3);
      const pinned = new Map();
      for (const call of h.requestCalls) pinned.set(call.opts.path, await pinnedIpOf(call, call.opts.hostname));
      assert.equal(pinned.get('/api/notify/internal/sync-rules'), '203.0.113.9');
      assert.equal(pinned.get('/api/account/internal/sync'), '198.51.100.7');
      assert.equal(pinned.get('/api/sync/internal/sync-backup'), '203.0.113.9'); // separate cache per origin
      assert.equal(h.requestCalls.find((c) => c.opts.port === 8443).opts.headers.Host, 'api.freebacktrack.tech:8443');
    } finally {
      closeDb(db);
    }
  });

  it('keeps the fetchImpl injection point ahead of the wrapper without any probing', async () => {
    const config = configOn(sameHostBases); // allowlisted HTTPS host on purpose
    const h = createHarness({ dns: ['203.0.113.9'] });
    const db = openDb(':memory:');
    try {
      enqueueEvent(db, 'notify', 'upsert', {});
      const seen = [];
      const result = await processOnce(db, {
        config,
        cfTransport: h.transport,
        fetchImpl: async (url, init) => {
          seen.push({ url, init });
          return new Response(null, { status: 204 });
        },
      });
      assert.deepEqual(result, { processed: 1, failed: 0, dead: 0 });
      assert.equal(outboxStats(db).pending, 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, config.urls.notify);
      assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(h.dnsCalls.length, 0); // injected client owns the batch: no hidden selection
      assert.equal(h.probeCalls.length, 0);
      assert.equal(h.requestCalls.length, 0);
    } finally {
      closeDb(db);
    }
  });

  it('default switch off: zero probing and the original fetch handles allowlisted HTTPS targets', async () => {
    const config = configOn(sameHostBases);
    const h = createHarness({ env: { CF_UPSTREAM_IP_SELECTION_ENABLED: '0' }, dns: ['203.0.113.9'] });
    const db = openDb(':memory:');
    try {
      for (const target of ['notify', 'account', 'sync']) enqueueEvent(db, target, 'upsert', {});
      await withGlobalFetchStub(async () => new Response(null, { status: 204 }), async (fetchCalls) => {
        const result = await processOnce(db, { config, cfTransport: h.transport });
        assert.deepEqual(result, { processed: 3, failed: 0, dead: 0 });
        assert.deepEqual(fetchCalls.map((c) => c.url).sort(), Object.values(config.urls).sort());
        assert.equal(h.dnsCalls.length, 0);
        assert.equal(h.probeCalls.length, 0);
        assert.equal(h.requestCalls.length, 0);
      });
    } finally {
      closeDb(db);
    }
  });

  it('HTTP bases never probe and stay on the original client', async () => {
    const config = configOn({
      notify: 'http://api.freebacktrack.tech',
      account: 'http://api.freebacktrack.tech',
      sync: 'http://api.freebacktrack.tech',
    });
    const h = createHarness({ dns: ['203.0.113.9'] }); // switch on: HTTP must still not probe
    const db = openDb(':memory:');
    try {
      for (const target of ['notify', 'account', 'sync']) enqueueEvent(db, target, 'upsert', {});
      await withGlobalFetchStub(async () => new Response(null, { status: 204 }), async (fetchCalls) => {
        const result = await processOnce(db, { config, cfTransport: h.transport });
        assert.deepEqual(result, { processed: 3, failed: 0, dead: 0 });
        assert.equal(fetchCalls.length, 3);
        assert.ok(fetchCalls.every((c) => c.url.startsWith('http://')));
        assert.equal(h.dnsCalls.length, 0);
        assert.equal(h.probeCalls.length, 0);
        assert.equal(h.requestCalls.length, 0);
      });
    } finally {
      closeDb(db);
    }
  });
});

describe('syncDaemon: outbox semantics with IP selection enabled', () => {
  let db;
  let realFetch;
  const config = daemonConfig({
    INTERNAL_SYNC_TOKEN: 'secret-token',
    SYNC_DAEMON_NOTIFY_URL: 'https://n.test',
    SYNC_DAEMON_ACCOUNT_URL: 'https://a.test',
    SYNC_DAEMON_SYNC_URL: 'https://s.test',
  });
  beforeEach(() => {
    db = openDb(':memory:');
    realFetch = globalThis.fetch;
    process.env.CF_UPSTREAM_IP_SELECTION_ENABLED = '1';
    // The batch hosts are deliberately NOT allowlisted: the default wrapper
    // delegates to global fetch (mocked below), so outbox semantics are
    // exercised with the switch on but without any real network.
    process.env.CF_UPSTREAM_HOSTS = 'other.example';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CF_UPSTREAM_IP_SELECTION_ENABLED;
    delete process.env.CF_UPSTREAM_HOSTS;
    closeDb(db);
  });

  it('delivers all three targets unchanged when enabled but the host is not allowlisted', async () => {
    const ids = ['notify', 'account', 'sync'].map((target) => enqueueEvent(db, target, 'upsert', { user_id: 'dudu' }));
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    };
    const result = await processOnce(db, { config });
    assert.deepEqual(result, { processed: 3, failed: 0, dead: 0 });
    assert.equal(outboxStats(db).pending, 0);
    assert.deepEqual(seen.map((s) => s.url).sort(), Object.values(config.urls).sort());
    const bodies = new Map(seen.map((s) => [s.url, JSON.parse(s.init.body)]));
    assert.equal(bodies.get(config.urls.notify).eventId, ids[0]); // selection must not change the eventId
    assert.equal(bodies.get(config.urls.account).eventId, ids[1]);
    assert.equal(bodies.get(config.urls.sync).eventId, ids[2]);
    for (const s of seen) {
      assert.equal(s.init.headers.Authorization, 'Bearer secret-token');
      assert.equal(s.init.headers['Content-Type'], 'application/json');
      assert.equal(s.init.redirect, 'error');
    }
  });

  it('keeps 429 Retry-After, 5xx retry and other-4xx dead-letter behavior', async () => {
    // 429 -> failed with the next attempt pushed by Retry-After
    enqueueEvent(db, 'sync', 'x', {});
    globalThis.fetch = async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } });
    const before = Date.now();
    await processOnce(db, { config });
    let row = db.prepare('SELECT retry_count, status, next_attempt_at FROM sync_outbox').get();
    assert.equal(row.retry_count, 1);
    assert.equal(row.status, 'pending');
    assert.ok(Date.parse(row.next_attempt_at) - before >= 115000);

    // 5xx -> failed (still retryable)
    enqueueEvent(db, 'sync', 'x', {});
    globalThis.fetch = async () => new Response('err', { status: 500 });
    assert.deepEqual(await processOnce(db, { config }), { processed: 1, failed: 1, dead: 0 });

    // Other 4xx -> dead letter
    enqueueEvent(db, 'sync', 'x', {});
    globalThis.fetch = async () => new Response('bad request', { status: 400 });
    assert.deepEqual(await processOnce(db, { config }), { processed: 1, failed: 0, dead: 1 });

    assert.deepEqual(outboxStats(db), { pending: 2, processing: 0, dead: 1 });
  });

  it('network timeouts still record "timeout" through the wrapper', async () => {
    enqueueEvent(db, 'sync', 'x', {});
    globalThis.fetch = (_, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    assert.deepEqual(await processOnce(db, { config, timeoutMs: 5 }), { processed: 1, failed: 1, dead: 0 });
    assert.equal(db.prepare('SELECT last_error FROM sync_outbox').get().last_error, 'timeout');
  });
});
