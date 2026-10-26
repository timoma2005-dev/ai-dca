// 登录口令哈希（Node 端）。与 workers/sync/src/password.js 的 PHC 格式、迭代次数、
// 盐长度、派生长度必须完全一致，两端才能互验同一份凭证（D1 灾备副本可直接登录）。
//
// 威胁模型：浏览器已先做一轮 SHA-256（clientHash，64 位 hex），原始密码不离开设备；
// 服务端把 clientHash 当作密码输入再做 PBKDF2 慢哈希，使拖库后的 GPU 离线爆破成本
// 从单轮 SHA-256 的每秒上亿次降低到每秒个位数。
import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

export const PBKDF2_ALGORITHM = 'pbkdf2-sha256';
export const PBKDF2_ITERATIONS = 310000;
export const PBKDF2_KEYLEN = 32;
export const PBKDF2_SALT_BYTES = 16;

const PHC_PREFIX = `$${PBKDF2_ALGORITHM}$`;

function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromBase64Url(text) {
  return Buffer.from(String(text), 'base64url');
}

/**
 * 旧版单轮 SHA-256 凭证：sha256(salt + ':' + clientHash)。
 * 仅用于验证升级前注册的存量用户，新注册一律走 PBKDF2。
 */
export function legacyPasswordHash(clientPasswordHash, salt) {
  return createHash('sha256')
    .update(`${salt}:${clientPasswordHash}`, 'utf8')
    .digest('hex');
}

export function isPbkdf2Hash(stored = '') {
  return String(stored || '').startsWith(PHC_PREFIX);
}

/**
 * 生成自描述 PHC 字符串：
 *   $pbkdf2-sha256$<iterations>$<saltB64url>$<hashB64url>
 * 盐内嵌在串内，password_salt 列留空，无需 schema 迁移；旧值是不含 '$' 的
 * 64 位 hex，登录时按前缀分派新老验证器。
 */
export function hashPassword(clientPasswordHash) {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const derived = pbkdf2Sync(
    String(clientPasswordHash),
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    'sha256'
  );
  return `${PHC_PREFIX}${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

function safeEqualBuffer(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function safeEqualText(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) {
    // 长度不同也消耗一次比较，保持时序均匀。
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * 验证登录凭证：PHC 走 PBKDF2（按串内参数派生），旧 hex 走 legacy SHA-256。
 * 任何格式错误都返回 false（由调用方统一回 401），绝不抛异常。
 */
export function verifyPassword(clientPasswordHash, stored, storedSalt = '') {
  const storedText = String(stored || '');
  try {
    if (isPbkdf2Hash(storedText)) {
      const parts = storedText.split('$');
      // ['', 'pbkdf2-sha256', iterations, salt, hash]
      if (parts.length !== 5) return false;
      const iterations = Number(parts[2]);
      if (!Number.isInteger(iterations) || iterations <= 0) return false;
      const salt = fromBase64Url(parts[3]);
      const expected = fromBase64Url(parts[4]);
      // 严格长度：截断/伪造的 PHC 不得通过（避免按存储长度派生后前缀匹配）。
      if (salt.length !== PBKDF2_SALT_BYTES || expected.length !== PBKDF2_KEYLEN) return false;
      const derived = pbkdf2Sync(
        String(clientPasswordHash),
        salt,
        iterations,
        expected.length,
        'sha256'
      );
      return safeEqualBuffer(derived, expected);
    }
    // 存量格式：不含 '$' 的 64 位 hex，盐在独立的 password_salt 列。
    if (!storedText) return false;
    return safeEqualText(storedText, legacyPasswordHash(clientPasswordHash, storedSalt || ''));
  } catch {
    return false;
  }
}
