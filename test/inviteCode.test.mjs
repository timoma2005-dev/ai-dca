import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { captureInviteFromUrl, clearPendingInvite, inviteLink, normalizeInviteCode, pendingInviteCode } from '../src/app/inviteCode.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test('invite code from ?invite= is remembered for 30 days and cleared after use', () => {
  const storage = memoryStorage();
  assert.equal(captureInviteFromUrl('https://fast.freebacktrack.tech/?invite=ab-c234', storage, 1000), 'ABC234');
  assert.equal(pendingInviteCode(storage, 2000), 'ABC234');
  assert.equal(pendingInviteCode(storage, 1000 + 31 * 86400000), '');
  clearPendingInvite(storage);
  assert.equal(pendingInviteCode(storage, 2000), '');
  assert.equal(captureInviteFromUrl('https://fast.freebacktrack.tech/', storage), '');
});

test('invite link carries the code and utm source; register form sends it', () => {
  assert.equal(normalizeInviteCode(' x<y>z9 '), 'XYZ9');
  assert.equal(inviteLink('abc234'), 'https://fast.freebacktrack.tech/?invite=ABC234&utm_source=invite');
  const client = fs.readFileSync('src/app/authClient.js', 'utf8');
  assert.match(client, /inviteCode: normalizeInviteCode\(inviteCode\) \|\| pendingInviteCode\(\) \|\| undefined/);
  const menu = fs.readFileSync('src/components/account-menu.jsx', 'utf8');
  assert.match(menu, /邀请码（选填）/);
  assert.match(menu, /<InvitePanel session=\{session\} \/>/);
});
