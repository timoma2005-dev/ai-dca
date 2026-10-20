// CF Worker IPv4 selection transport for the sync worker (docs/plan-cf-ip-selection.md).
//
// Cross-border TLS to Cloudflare anycast drifts 3~8s per first connect. Like
// services/etf-mirror, we merge the live A records of the target host with a
// static IPv4 pool, concurrently probe candidates with TCP+TLS handshakes and
// pin requests to the fastest IP while hostname, SNI, Host header and
// certificate validation keep pointing at the real domain.
//
// Everything is behind CF_UPSTREAM_IP_SELECTION_ENABLED (default off): when
// off we resolve no candidates, probe nothing and delegate to the original
// global fetch untouched.

import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { resolve4 } from 'node:dns';
import { connect as tlsConnect } from 'node:tls';
import { isIPv4 } from 'node:net';
import { performance } from 'node:perf_hooks';

const DEFAULT_STATIC_IPS = '104.21.38.17,172.67.217.77';
const DEFAULT_HOSTS = 'api.freebacktrack.tech,fast.freebacktrack.tech';
const DEFAULT_PROBE_TIMEOUT_S = 6;
const DEFAULT_RESELECT_INTERVAL_S = 300;

// Bounded probing and caching (plan section 5).
const MAX_CANDIDATES = 16; // pool cap; live A records keep priority
const MAX_CONCURRENT_PROBES = 8;
// Safety cap while draining bodies nobody reads (plan section 3).
const MAX_UNREAD_BODY_BYTES = 2 * 1024 * 1024;
const PINNABLE_METHODS = new Set(['GET', 'POST', 'HEAD']);

// Marks failures that happened before the request could be written out
// (fresh TLS socket, handshake never completed): only those are replayable.
const kConnectPhase = Symbol('cfConnectPhase');

function abortError() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function portOf(u) {
  return u.port ? Number(u.port) : 443;
}

function resolve4Async(hostname) {
  return new Promise((resolve, reject) => {
    resolve4(hostname, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

// Reject as soon as `signal` aborts; the underlying promise keeps its own
// handlers so a late rejection is never unhandled.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

// Default probe: one TCP+TLS handshake against the candidate IP. servername
// stays the real hostname so certificate validation is exercised exactly like
// a real request. Resolves with the handshake latency in ms, null when the
// candidate is unreachable; the socket is always released.
function defaultProbe(ip, { host, port, timeoutMs, signal, clock }) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let timer = null;
    const onAbort = () => finish(null);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const startedAt = clock.now();
    if (signal?.aborted) {
      finish(null);
      return;
    }
    try {
      socket = tlsConnect({ host: ip, port, servername: host, rejectUnauthorized: true });
    } catch {
      finish(null);
      return;
    }
    socket.once('secureConnect', () => finish(clock.now() - startedAt));
    socket.once('error', () => finish(null));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Build the shared CF Worker transport. All collaborators are injectable so
 * tests can run with fake dns/probe/request without touching the network.
 *
 * Returns `{ prepare(urls, {signal}), fetch(url, init), close() }`. The plain
 * DNS path delegates to the original global fetch (looked up at call time so
 * tests can keep stubbing `globalThis.fetch`).
 */
export function createCfWorkerTransport({
  env = process.env,
  dnsLookup = resolve4Async,
  probe = defaultProbe,
  requestImpl = httpsRequest,
  clock = { now: () => performance.now() },
} = {}) {
  const warnedValues = new Set();
  const agents = new Map(); // `${origin}|${ip}` -> https.Agent
  const originStates = new Map(); // origin -> { selection, inflight }

  function warnOnce(raw, message) {
    const key = String(raw);
    if (warnedValues.has(key)) return;
    warnedValues.add(key);
    console.error(`[cf-ip] config warning: ${message}`);
  }

  function parseSecondsMs(raw, name, defaultSeconds) {
    if (raw === undefined || raw === '') return defaultSeconds * 1000;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      warnOnce(raw, `${name}=${raw} is not a positive number, keeping default ${defaultSeconds}s`);
      return defaultSeconds * 1000;
    }
    return seconds * 1000;
  }

  // Config is read live from `env` on every operation, so tests (and ops) can
  // flip CF_UPSTREAM_IP_SELECTION_ENABLED without re-importing the module.
  function readConfig() {
    const rawIps = env.CF_UPSTREAM_IPS;
    const staticIps = [];
    if (rawIps === undefined) {
      staticIps.push(...DEFAULT_STATIC_IPS.split(','));
    } else {
      for (const token of rawIps.split(',')) {
        const ip = token.trim();
        if (!ip) continue;
        if (!isIPv4(ip)) {
          warnOnce(token, `CF_UPSTREAM_IPS entry "${ip}" is not a valid IPv4, ignoring it`);
          continue;
        }
        if (!staticIps.includes(ip)) staticIps.push(ip);
      }
    }
    const rawHosts = env.CF_UPSTREAM_HOSTS;
    const hosts = (rawHosts === undefined ? DEFAULT_HOSTS : rawHosts)
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    return {
      enabled: env.CF_UPSTREAM_IP_SELECTION_ENABLED === '1',
      hosts,
      staticIps,
      probeTimeoutMs: parseSecondsMs(env.CF_UPSTREAM_PROBE_TIMEOUT, 'CF_UPSTREAM_PROBE_TIMEOUT', DEFAULT_PROBE_TIMEOUT_S),
      reselectIntervalMs: parseSecondsMs(
        env.CF_UPSTREAM_RESELECT_INTERVAL,
        'CF_UPSTREAM_RESELECT_INTERVAL',
        DEFAULT_RESELECT_INTERVAL_S
      ),
    };
  }

  function getOriginState(origin) {
    let state = originStates.get(origin);
    if (!state) {
      state = { selection: null, inflight: null };
      originStates.set(origin, state);
    }
    return state;
  }

  function abortToNull(signal) {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  // One selection round: merge candidates, probe them concurrently and rank by
  // handshake latency. The whole round (DNS wait included) is bounded by the
  // probe timeout, and an external `signal` abort cancels the round. Never
  // throws: network/config problems degrade to the static pool or to plain DNS.
  async function selectRound(host, port, cfg, signal, exclude) {
    const roundCtl = new AbortController();
    const abortRound = () => roundCtl.abort();
    if (signal?.aborted) roundCtl.abort();
    else signal?.addEventListener('abort', abortRound, { once: true });
    const roundTimer = setTimeout(() => roundCtl.abort(), cfg.probeTimeoutMs);
    try {
      let aRecords = [];
      if (!roundCtl.signal.aborted) {
        const dnsPromise = Promise.resolve(dnsLookup(host));
        dnsPromise.catch(() => {});
        try {
          const raw = await Promise.race([dnsPromise, abortToNull(roundCtl.signal)]);
          if (Array.isArray(raw)) aRecords = raw.filter(isIPv4);
        } catch {
          // DNS failure still leaves the static pool.
        }
      }
      // Live A records first, then the static pool; deduped, IPv4 only, capped.
      const seen = new Set();
      const candidates = [];
      for (const ip of [...aRecords, ...cfg.staticIps]) {
        if (exclude === ip || seen.has(ip)) continue;
        seen.add(ip);
        candidates.push(ip);
        if (candidates.length >= MAX_CANDIDATES) break;
      }
      if (candidates.length === 0) {
        return { ip: null, candidates, degraded: false, probeSummary: 'no-candidates' };
      }
      const results = [];
      const queue = [...candidates];
      const probeNext = async () => {
        while (queue.length > 0 && !roundCtl.signal.aborted) {
          const ip = queue.shift();
          const probePromise = Promise.resolve(
            probe(ip, { host, port, timeoutMs: cfg.probeTimeoutMs, signal: roundCtl.signal, clock })
          );
          probePromise.catch(() => {});
          let latency = null;
          try {
            latency = await Promise.race([probePromise, abortToNull(roundCtl.signal)]);
          } catch {
            latency = null;
          }
          if (typeof latency === 'number' && Number.isFinite(latency) && latency >= 0) {
            results.push({ ip, latency });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, candidates.length) }, () => probeNext()));
      if (signal?.aborted) return null; // caller cancelled: cache nothing
      const ranked = results.sort((a, b) => a.latency - b.latency);
      const degraded = ranked.length === 0;
      const ip = degraded ? candidates[0] : ranked[0].ip;
      const probeSummary = ranked.length
        ? ranked.map((r) => `${r.ip}=${Math.round(r.latency)}ms`).join(', ')
        : 'all-unreachable';
      return { ip, candidates, degraded, probeSummary };
    } finally {
      clearTimeout(roundTimer);
      signal?.removeEventListener('abort', abortRound);
    }
  }

  async function runRound(origin, host, port, cfg, signal, exclude = null) {
    const startedAt = clock.now();
    try {
      const round = await selectRound(host, port, cfg, signal, exclude);
      if (round === null || signal?.aborted) return { aborted: true };
      const selection = {
        origin,
        ip: round.ip,
        candidates: round.candidates,
        degraded: round.degraded,
        probeSummary: round.probeSummary,
        selectedAt: clock.now(),
        roundMs: clock.now() - startedAt,
      };
      const previous = getOriginState(origin).selection;
      if (selection.ip && previous?.ip !== selection.ip) {
        console.log(`[cf-ip] ${origin} selected ${selection.ip} (${selection.probeSummary}${selection.degraded ? ', degraded' : ''})`);
      }
      return { selection };
    } catch (err) {
      // Unexpected internal errors must never block the sync batch.
      console.error(`[cf-ip] selection round error for ${origin}: ${err?.message || err}`);
      return {
        selection: {
          origin,
          ip: null,
          candidates: [],
          degraded: false,
          probeSummary: 'selection-error',
          selectedAt: clock.now(),
          roundMs: clock.now() - startedAt,
        },
      };
    }
  }

  // Singleflight per origin: concurrent callers join the in-flight round
  // instead of probing again. The round is tied to the initiator's signal; if
  // that initiator aborts, other callers simply start their own round.
  async function ensureFreshSelection(origin, host, port, cfg, signal) {
    const state = getOriginState(origin);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (state.selection && clock.now() - state.selection.selectedAt < cfg.reselectIntervalMs) {
        return state.selection;
      }
      if (!state.inflight) {
        const task = runRound(origin, host, port, cfg, signal).then((result) => {
          if (!result.aborted) state.selection = result.selection;
          return result;
        });
        state.inflight = task;
        task.then(
          () => {
            if (state.inflight === task) state.inflight = null;
          },
          () => {
            if (state.inflight === task) state.inflight = null;
          }
        );
      }
      const result = await raceAbort(state.inflight, signal);
      if (!result.aborted) continue; // round cached: re-check TTL below
      if (!signal?.aborted) continue; // initiator aborted: start our own round
      throw abortError();
    }
    return state.selection; // unreachable in practice; a stale route beats none
  }

  // Immediate reselect after a pinned connect failure, excluding the failed IP.
  // Returns null when the remaining candidates hold no trusted alternative:
  // the second attempt then goes through plain DNS.
  async function reselectForRetry(origin, host, port, cfg, failedIp, signal) {
    const result = await raceAbort(runRound(origin, host, port, cfg, signal, failedIp), signal);
    if (result.aborted) throw abortError();
    const selection = result.selection;
    if (!selection.ip || selection.degraded) {
      console.error(`[cf-ip] ${origin} no trusted alternative after excluding ${failedIp}, second attempt uses plain DNS`);
      return null;
    }
    getOriginState(origin).selection = selection;
    return selection;
  }

  function destroyFreeSockets(agent) {
    for (const pool of Object.values(agent.freeSockets || {})) {
      for (const socket of pool) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    }
  }

  function busySocketCount(agent) {
    let count = 0;
    for (const pool of Object.values(agent.sockets || {})) count += pool.length;
    return count;
  }

  // A new (origin, ip) pair retires the idle sockets of previous IPs for that
  // origin; requests still in flight on an old agent finish undisturbed and
  // get swept on a later selection.
  function retireIdleAgents(origin, keepKey) {
    for (const [key, agent] of agents) {
      if (key === keepKey || !key.startsWith(`${origin}|`)) continue;
      destroyFreeSockets(agent);
      if (busySocketCount(agent) === 0) {
        agent.destroy();
        agents.delete(key);
      }
    }
  }

  function getAgent(origin, ip) {
    const key = `${origin}|${ip}`;
    let agent = agents.get(key);
    if (!agent) {
      agent = new HttpsAgent({
        keepAlive: true,
        maxSockets: 8,
        maxFreeSockets: 2,
        // Pin every connection of this agent to the selected IPv4; hostname
        // and servername still point at the real domain.
        lookup: (hostname, options, callback) => {
          callback(null, [{ address: ip, family: 4 }]);
        },
      });
      agents.set(key, agent);
      retireIdleAgents(origin, key);
    }
    return agent;
  }

  function flattenHeaders(input) {
    const headers = {};
    if (!input) return headers;
    if (typeof input.entries === 'function' && typeof input.forEach === 'function') {
      for (const [key, value] of input.entries()) headers[key] = value;
      return headers;
    }
    if (Array.isArray(input)) {
      for (const [key, value] of input) headers[key] = value;
      return headers;
    }
    for (const [key, value] of Object.entries(input)) headers[key] = value;
    return headers;
  }

  function isReplayableBody(body) {
    return (
      body == null ||
      typeof body === 'string' ||
      Buffer.isBuffer(body) ||
      body instanceof ArrayBuffer ||
      ArrayBuffer.isView(body)
    );
  }

  function toBodyBuffer(body) {
    if (body == null) return null;
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return undefined; // not replayable: caller routes to the original fetch
  }

  // Minimal fetch-like response for the pinned path. The body is drained in
  // the background even when nobody reads it (the auth success branch ignores
  // bodies): an undrained stream would keep the keep-alive connection out of
  // the pool forever.
  function toFetchLikeResponse(raw) {
    const status = raw.statusCode;
    let bodyRequested = false;
    let buffered = 0;
    const drained = new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const settle = (fn, value) => {
        if (!settled) {
          settled = true;
          fn(value);
        }
      };
      raw.on('data', (chunk) => {
        buffered += chunk.length;
        if (!bodyRequested && buffered > MAX_UNREAD_BODY_BYTES) {
          raw.destroy(new Error('cf-ip: unread response body exceeded safety cap'));
          return;
        }
        chunks.push(chunk);
      });
      raw.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')));
      raw.on('aborted', () => settle(reject, new Error('cf-ip: response aborted before completion')));
      raw.on('error', (err) => settle(reject, err));
      raw.on('close', () => settle(reject, new Error('cf-ip: response closed before completion')));
    });
    drained.catch(() => {}); // no reader: swallow drain failures silently
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: raw.statusMessage || '',
      headers: {
        get(name) {
          if (name == null) return null;
          const value = raw.headers?.[String(name).toLowerCase()];
          if (value === undefined) return null;
          return Array.isArray(value) ? value.join(', ') : String(value);
        },
      },
      text() {
        bodyRequested = true;
        return drained;
      },
      body: {
        cancel() {
          try {
            raw.destroy(abortError());
          } catch {
            /* ignore */
          }
        },
      },
    };
  }

  function requestPinned(u, init, ip, signal) {
    return new Promise((resolve, reject) => {
      const headers = flattenHeaders(init.headers);
      // Host always comes from the real URL (port included when non-default),
      // exactly like fetch; caller-supplied host/content-length never survive.
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'host' || lower === 'content-length') delete headers[key];
      }
      headers.Host = u.host;
      const options = {
        hostname: u.hostname,
        port: portOf(u),
        path: `${u.pathname}${u.search}`,
        method: String(init.method || 'GET').toUpperCase(),
        headers,
        // Explicit servername keeps SNI and certificate verification on the
        // real hostname even though the socket dials the pinned IP.
        servername: u.hostname,
        agent: getAgent(u.origin, ip),
      };
      let secured = false;
      const req = requestImpl(options, (res) => {
        resolve(toFetchLikeResponse(res));
      });
      // A POST may only be replayed when it provably never left the client.
      // On a fresh TLS socket no byte is written before 'secureConnect'; a
      // reused keep-alive socket may already have taken our bytes, so any
      // failure there is "result unknown" and is never resent.
      req.on('socket', (socket) => {
        if (socket?.authorized === true) {
          secured = true;
          return;
        }
        socket?.once?.('secureConnect', () => {
          secured = true;
        });
      });
      req.on('error', (err) => {
        if (!secured) err[kConnectPhase] = true;
        reject(err);
      });
      let onAbort = null;
      if (signal) {
        if (signal.aborted) {
          const err = abortError();
          try {
            req.destroy(err);
          } catch {
            /* ignore */
          }
          reject(err);
          return;
        }
        onAbort = () => {
          try {
            req.destroy(abortError());
          } catch {
            /* ignore */
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        req.once('close', () => signal.removeEventListener('abort', onAbort));
      }
      const body = toBodyBuffer(init.body);
      if (body) req.end(body);
      else req.end();
    });
  }

  function isPinnable(u, init) {
    if (u.protocol !== 'https:') return false; // HTTP stays on the original client
    if (isIPv4(u.hostname)) return false; // IP-literal URLs never get the pool
    if (u.username || u.password) return false; // fetch itself rejects these
    const method = String(init.method || 'GET').toUpperCase();
    if (!PINNABLE_METHODS.has(method)) return false;
    if ((method === 'GET' || method === 'HEAD') && init.body != null) return false; // fetch rejects this
    return isReplayableBody(init.body);
  }

  async function fetchLike(url, init = {}) {
    const cfg = readConfig();
    if (!cfg.enabled) return globalThis.fetch(url, init);
    let u;
    try {
      u = new URL(url);
    } catch {
      return globalThis.fetch(url, init); // keep the original fetch's TypeError semantics
    }
    if (!cfg.hosts.includes(u.hostname) || !isPinnable(u, init)) {
      return globalThis.fetch(url, init);
    }
    const signal = init.signal;
    if (signal?.aborted) throw abortError();
    const selection = await ensureFreshSelection(u.origin, u.hostname, portOf(u), cfg, signal);
    if (!selection || !selection.ip) return globalThis.fetch(url, init); // empty pool: plain DNS
    try {
      return await requestPinned(u, init, selection.ip, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!err?.[kConnectPhase]) throw err; // written or response started: result unknown, no resend
      console.error(`[cf-ip] ${u.origin} connect failed on ${selection.ip} (${err?.code || err?.message || err}), retrying once`);
      const retry = await reselectForRetry(u.origin, u.hostname, portOf(u), cfg, selection.ip, signal);
      if (!retry) return globalThis.fetch(url, init); // second attempt: plain DNS
      return requestPinned(u, init, retry.ip, signal);
    }
  }

  // Warm the selection for the given URLs (one round per origin). Idle queues
  // must not probe: the sync worker only calls this with a non-empty batch.
  async function prepare(urls, { signal } = {}) {
    const cfg = readConfig();
    if (!cfg.enabled) return; // switch off: no candidates, no probing at all
    const targets = new Map();
    for (const url of urls ?? []) {
      let u;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (u.protocol !== 'https:' || isIPv4(u.hostname)) continue;
      if (u.username || u.password) continue;
      if (!cfg.hosts.includes(u.hostname)) continue;
      if (!targets.has(u.origin)) targets.set(u.origin, u);
    }
    if (targets.size === 0) return;
    await Promise.all(
      [...targets.values()].map((u) => ensureFreshSelection(u.origin, u.hostname, portOf(u), cfg, signal))
    );
  }

  function close() {
    for (const agent of agents.values()) {
      destroyFreeSockets(agent);
      agent.destroy();
    }
    agents.clear();
    originStates.clear();
  }

  return { prepare, fetch: fetchLike, close };
}
