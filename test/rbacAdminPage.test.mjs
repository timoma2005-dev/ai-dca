import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const users = read('pages/rbac/RbacUsersPanel.jsx');
const guests = read('pages/rbac/RbacGuestsPanel.jsx');
const page = read('pages/AdminRbacExperience.jsx');
const api = read('app/rbac/rbacAdminApi.js');

test('users panel loads the empty query on mount and reuses a directly callable search', () => {
  assert.match(users, /const search = useCallback\(async \(searchQuery = ''\) =>/);
  assert.match(users, /useEffect\(\(\) => \{\s*search\(''\);[\s\S]*?\}, \[search\]\)/);
  assert.match(users, /onSubmit=\{\(event\) => \{ event\.preventDefault\(\); search\(query\); \}\}/);
  assert.equal((users.match(/await search\(query\)/g) || []).length, 2, 'grant and revoke retain the current query');
  assert.match(users, /pendingSearches\.current\.get\(searchQuery\)/);
  assert.match(users, /requestId === latestSearch\.current/);
  assert.match(users, /留空列出全部用户/);
});

test('users show formatted last activity or never; the client requests 200 users', () => {
  assert.match(users, /最后活跃 \{user\.lastActiveAt \? formatTime\(user\.lastActiveAt\) : '从未'\}/);
  assert.match(api, /searchUsers:.*limit=200/);
  assert.match(api, /listGuests: \(\) => request\('GET', '\/guests'\)/);
});

test('guest panel loads once, renders aggregated rows, and preserves full visitor IDs in titles', () => {
  assert.match(guests, /useEffect\(\(\) => \{[\s\S]*?request\.current \|\|= rbacAdminApi\.listGuests\(\);[\s\S]*?\}, \[\]\)/);
  assert.match(guests, /if \(!cancelled\) setData\(result\)/);
  assert.match(guests, /<Panel title="游客（未注册访客）"/);
  for (const label of ['访客标识', '首次访问', '最近活跃', '活跃天数']) assert.ok(guests.includes(label));
  assert.match(guests, /guests\.map\(\(guest\) =>/);
  assert.match(guests, /data-testid="rbac-guest-row"/);
  assert.match(guests, /title=\{guest\.visitorId\}/);
  assert.match(guests, /guest\.visitorId\.length > 18 \? `\$\{guest\.visitorId\.slice\(0, 18\)\}…` : guest\.visitorId/);
  for (const field of ['firstSeenDate', 'lastActiveDate', 'activeDays']) assert.ok(guests.includes(`{guest.${field}}`));
});

test('guest loading, empty and unavailable states are distinct; guests follow users in the users tab', () => {
  assert.match(guests, /loading \? <p[^>]*>正在加载游客…/);
  assert.match(guests, /!loading && data\?\.available === false \? <p[^>]*>暂无游客数据（分析库不可用）/);
  assert.match(guests, /!loading && data\?\.available && !guests\.length \? <p[^>]*>暂无游客访问记录。/);
  assert.match(page, /section === 'users' \? \([\s\S]*?<RbacUsersPanel[^>]*\/>\s*<RbacGuestsPanel \/>/);
});
