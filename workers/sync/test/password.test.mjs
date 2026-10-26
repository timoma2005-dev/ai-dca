import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  isPbkdf2Hash,
  legacyPasswordHash,
  PBKDF2_ITERATIONS,
  PBKDF2_KEYLEN,
  PBKDF2_SALT_BYTES,
} from '../src/password.js';
// 跨运行时互验：Node 端实现（node:crypto pbkdf2Sync）。
import {
  hashPassword as nodeHashPassword,
  verifyPassword as nodeVerifyPassword,
  PBKDF2_ITERATIONS as NODE_ITERATIONS,
  PBKDF2_KEYLEN as NODE_KEYLEN,
  PBKDF2_SALT_BYTES as NODE_SALT_BYTES,
} from '../../../services/auth/src/password.js';

const CLIENT_HASH = 'a'.repeat(64);

test('worker 密码模块：PHC 格式与常量', async () => {
  const phc = await hashPassword(CLIENT_HASH);
  assert.match(phc, /^\$pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  const [, alg, iterations, salt, hash] = phc.split('$');
  assert.equal(alg, 'pbkdf2-sha256');
  assert.equal(Number(iterations), PBKDF2_ITERATIONS);
  assert.equal(Buffer.from(salt, 'base64url').length, PBKDF2_SALT_BYTES);
  assert.equal(Buffer.from(hash, 'base64url').length, PBKDF2_KEYLEN);
  assert.ok(isPbkdf2Hash(phc));

  // 两端参数必须逐一对齐，否则 D1 灾备副本无法互验。
  assert.equal(PBKDF2_ITERATIONS, NODE_ITERATIONS);
  assert.equal(PBKDF2_KEYLEN, NODE_KEYLEN);
  assert.equal(PBKDF2_SALT_BYTES, NODE_SALT_BYTES);
});

test('worker 密码模块：随机盐、正确/错误密码验证', async () => {
  const h1 = await hashPassword(CLIENT_HASH);
  const h2 = await hashPassword(CLIENT_HASH);
  assert.notEqual(h1, h2);
  assert.equal(await verifyPassword(CLIENT_HASH, h1), true);
  assert.equal(await verifyPassword(CLIENT_HASH, h2), true);
  assert.equal(await verifyPassword('b'.repeat(64), h1), false);
});

test('worker 密码模块：legacy SHA-256 存量凭证可验证', async () => {
  const salt = 'pwd_legacy_1';
  const stored = await legacyPasswordHash(CLIENT_HASH, salt);
  assert.equal(isPbkdf2Hash(stored), false);
  assert.equal(await verifyPassword(CLIENT_HASH, stored, salt), true);
  assert.equal(await verifyPassword('b'.repeat(64), stored, salt), false);
  assert.equal(await verifyPassword(CLIENT_HASH, stored, 'wrong-salt'), false);
});

test('worker 密码模块：畸形 PHC 与空输入一律 false，不抛异常', async () => {
  const good = await hashPassword(CLIENT_HASH);
  const cases = [
    good.slice(0, -2),
    '$pbkdf2-sha256$310000$AA$',
    '$pbkdf2-sha256$0$AA$' + good.split('$')[4],
    '$pbkdf2-sha256$abc$xx$yy',
    '$pbkdf2-sha256$310000$',
    '',
  ];
  for (const value of cases) {
    assert.equal(await verifyPassword(CLIENT_HASH, value), false, `应拒绝: ${value}`);
  }
  assert.equal(await verifyPassword('', good), false);
});

test('跨端互验：Worker 派生的 PHC 能被 Node 端验证，反之亦然', async () => {
  const workerPhc = await hashPassword(CLIENT_HASH);
  assert.equal(nodeVerifyPassword(CLIENT_HASH, workerPhc), true, 'Node 必须能验 Worker 产出的 PHC');
  assert.equal(nodeVerifyPassword('b'.repeat(64), workerPhc), false);

  const nodePhc = nodeHashPassword(CLIENT_HASH);
  assert.equal(await verifyPassword(CLIENT_HASH, nodePhc), true, 'Worker 必须能验 Node 产出的 PHC');
  assert.equal(await verifyPassword('b'.repeat(64), nodePhc), false);

  // legacy 公式两端一致。
  const workerLegacy = await legacyPasswordHash(CLIENT_HASH, 'salt-x');
  assert.equal(nodeVerifyPassword(CLIENT_HASH, workerLegacy, 'salt-x'), true);
});
