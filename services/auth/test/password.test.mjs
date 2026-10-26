import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  isPbkdf2Hash,
  legacyPasswordHash,
  PBKDF2_ITERATIONS,
  PBKDF2_KEYLEN,
  PBKDF2_SALT_BYTES,
} from '../src/password.js';
import { hashPasswordCredential, sha256Hex } from '../src/auth.js';

const CLIENT_HASH = 'a'.repeat(64); // 浏览器端 SHA-256 产出的 64 位 hex

describe('password: PHC 格式与参数', () => {
  it('产出 $pbkdf2-sha256$ 前缀的自描述字符串，盐内嵌', () => {
    const phc = hashPassword(CLIENT_HASH);
    assert.match(phc, /^\$pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    const [, alg, iterations, salt, hash] = phc.split('$');
    assert.equal(alg, 'pbkdf2-sha256');
    assert.equal(Number(iterations), PBKDF2_ITERATIONS);
    assert.equal(Buffer.from(salt, 'base64url').length, PBKDF2_SALT_BYTES);
    assert.equal(Buffer.from(hash, 'base64url').length, PBKDF2_KEYLEN);
    assert.ok(isPbkdf2Hash(phc));
  });

  it('同一输入每次使用不同随机盐，哈希不同但都能验证通过', () => {
    const h1 = hashPassword(CLIENT_HASH);
    const h2 = hashPassword(CLIENT_HASH);
    assert.notEqual(h1, h2);
    assert.equal(verifyPassword(CLIENT_HASH, h1), true);
    assert.equal(verifyPassword(CLIENT_HASH, h2), true);
  });

  it('错误密码验证失败', () => {
    const phc = hashPassword(CLIENT_HASH);
    assert.equal(verifyPassword('b'.repeat(64), phc), false);
  });

  it('PHC 内嵌哈希与裸 pbkdf2Sync 派生结果一致（格式可被外部实现复算）', () => {
    const phc = hashPassword(CLIENT_HASH);
    const [, , iterations, saltB64, hashB64] = phc.split('$');
    const expected = pbkdf2Sync(
      CLIENT_HASH,
      Buffer.from(saltB64, 'base64url'),
      Number(iterations),
      PBKDF2_KEYLEN,
      'sha256'
    ).toString('base64url');
    assert.equal(hashB64, expected);
  });
});

describe('password: 存量 legacy SHA-256 兼容', () => {
  it('legacyPasswordHash 与旧 auth.js 派生公式一致', () => {
    assert.equal(legacyPasswordHash('ch', 's'), sha256Hex('s:ch'));
    assert.equal(hashPasswordCredential('ch', 's'), sha256Hex('s:ch'));
  });

  it('旧 64 位 hex + 独立盐列可验证，且不被识别为 PHC', () => {
    const salt = 'pwd_legacy_1';
    const stored = legacyPasswordHash(CLIENT_HASH, salt);
    assert.equal(isPbkdf2Hash(stored), false);
    assert.equal(verifyPassword(CLIENT_HASH, stored, salt), true);
    assert.equal(verifyPassword('b'.repeat(64), stored, salt), false);
    assert.equal(verifyPassword(CLIENT_HASH, stored, 'wrong-salt'), false);
  });
});

describe('password: 异常输入不抛异常', () => {
  it('截断/缺段/非法迭代数的 PHC 一律返回 false', () => {
    const good = hashPassword(CLIENT_HASH);
    const tampered = [
      good.slice(0, -2), // 截断
      '$pbkdf2-sha256$310000$AA$', // 空哈希
      '$pbkdf2-sha256$0$AA$' + good.split('$')[4], // 非法迭代数
      '$pbkdf2-sha256$abc$xx$yy', // 非数字迭代数
      '$pbkdf2-sha256$310000$', // 缺段
      '', // 空存储
    ];
    for (const value of tampered) {
      assert.equal(verifyPassword(CLIENT_HASH, value), false, `应拒绝: ${value}`);
    }
  });

  it('空 clientHash 不会误通过', () => {
    const phc = hashPassword(CLIENT_HASH);
    assert.equal(verifyPassword('', phc), false);
  });
});
