// Shared receive-only sync protocol. Security matches internalAuthSync.js.
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
export function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
export function required(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) invalid(`Invalid ${name}`);
  return value.trim();
}
export function dataOf(payload, name) {
  if (Object.hasOwn(payload, name)) return payload[name];
  if (Object.hasOwn(payload, 'payload')) return payload.payload;
  invalid(`Missing ${name}`);
}
export function validateEvent(body, types) {
  const eventId = required(body?.eventId ?? body?.event_id, 'eventId');
  const eventType = body?.eventType ?? body?.event_type;
  if (!types.includes(eventType)) invalid('Unknown eventType');
  const payload = body?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('Invalid payload');
  required(payload.user_id, 'user_id');
  return { eventId, eventType, payload };
}
export async function receiveSync(request, env, binding, types, apply, origin = '*') {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': origin } });
  const configuredToken = String(env?.INTERNAL_SYNC_TOKEN || '');
  if (!configuredToken) return json({ error: '内部同步接口未启用' }, 503);
  const auth = request.headers.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!provided || !timingSafeEqual(provided, configuredToken)) return json({ error: '未授权' }, 401);
  try {
    let body;
    try { body = await request.json(); } catch { invalid('Invalid JSON'); }
    const event = validateEvent(body, types);
    const hash = await sha256Hex(canonicalJson(event.payload));
    const db = env[binding];
    if (!db) return json({ error: 'Missing D1 binding' }, 503);
    await db.prepare('CREATE TABLE IF NOT EXISTS sync_events (event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, applied_at TEXT NOT NULL)').run();
    const read = () => db.prepare('SELECT payload_hash FROM sync_events WHERE event_id = ?').bind(event.eventId).first();
    const recorded = await read();
    if (recorded) return recorded.payload_hash === hash ? json({ ok: true, deduplicated: true }) : json({ error: '事件 payload 冲突' }, 409);
    // Build all D1 writes before recording the event; batch commits atomically.
    const result = await apply(event, env);
    // KV cannot share a D1 transaction. Write it first so failures remain retryable.
    if (result.beforeCommit) await result.beforeCommit();
    try {
      await db.batch([
        db.prepare('INSERT INTO sync_events (event_id, payload_hash, applied_at) VALUES (?, ?, ?)').bind(event.eventId, hash, new Date().toISOString()),
        ...(result.statements || []),
      ]);
    } catch (error) {
      if (!String(error?.message || '').includes('UNIQUE constraint failed')) throw error;
      const raced = await read();
      if (!raced) throw error;
      return raced.payload_hash === hash ? json({ ok: true, deduplicated: true }) : json({ error: '事件应用冲突' }, 409);
    }
    return json({ ok: true });
  } catch (error) {
    return json({ error: error.status === 400 ? error.message : 'Internal sync failed' }, error.status || 500);
  }
}
// Existing storage writers can build their schema-compatible statements without
// committing them independently from the event receipt.
export function collectWrites(db) {
  const statements = [];
  const proxy = { prepare(sql) {
    const wrap = statement => ({ bind: (...args) => wrap(statement.bind(...args)), first: (...args) => statement.first(...args), all: (...args) => statement.all(...args), run: async () => { statements.push(statement); return { success: true }; } });
    return wrap(db.prepare(sql));
  }, async batch(batch) { for (const statement of batch) await statement.run(); } };
  return { db: proxy, statements };
}
