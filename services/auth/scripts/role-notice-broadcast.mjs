#!/usr/bin/env node
// 给当前有效的 VIP / SVIP 用户补发一次「已开通」站内信（已配渠道的同时推送）。
// 默认只预览：node services/auth/scripts/role-notice-broadcast.mjs
// 正式发送：  ... --send [--notice-id welcome-20261030] [--user 用户名] [--inbox-only]
import { DatabaseSync } from 'node:sqlite';
import { roleNoticeUrl } from '../src/roleNotice.js';

const args = process.argv.slice(2);
const opt = (name, fallback = '') => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const send = args.includes('--send');
const inboxOnly = args.includes('--inbox-only');
const noticeId = opt('--notice-id', 'welcome-20261030');
const onlyUser = opt('--user', '').toLowerCase();
const db = new DatabaseSync(process.env.AUTH_DB_PATH || '/var/lib/ai-dca-auth/auth.sqlite', { readOnly: true });
const now = new Date().toISOString();
const rows = db.prepare(`SELECT r.user_id, u.username, r.role_code, r.expires_at FROM user_roles r JOIN users u ON u.id = r.user_id
  WHERE r.role_code IN ('vip', 'svip') AND (r.expires_at IS NULL OR r.expires_at > ?)`).all(now);
const best = new Map();
for (const r of rows) {
  const cur = best.get(r.user_id);
  if (!cur || (r.role_code === 'svip' && cur.role_code !== 'svip')) best.set(r.user_id, r);
}
let list = [...best.values()];
if (onlyUser) list = list.filter((r) => String(r.username).toLowerCase() === onlyUser);
const count = list.reduce((m, r) => ({ ...m, [r.role_code]: (m[r.role_code] || 0) + 1 }), {});
console.log(JSON.stringify({ mode: send ? 'send' : 'dry-run', noticeId, inboxOnly, users: list.length, byRole: count }));
if (!send) process.exit(0);
const stats = {};
for (const r of list) {
  const res = await fetch(roleNoticeUrl(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: r.user_id, username: r.username, role: r.role_code, expiresAt: r.expires_at, noticeId, inboxOnly })
  }).then((x) => x.json()).catch((e) => ({ message: String(e?.message || e) }));
  const key = res.skipped || res.status || res.message || 'unknown';
  stats[key] = (stats[key] || 0) + 1;
  for (const c of res.channels || []) if (c.channel !== 'pc' && c.status === 'delivered') stats[`push:${c.channel}`] = (stats[`push:${c.channel}`] || 0) + 1;
}
console.log(JSON.stringify(stats));
