// 登录口令哈希（Cloudflare Worker / Web Crypto 端）。
// 必须与 services/auth/src/password.js 的 PHC 格式、迭代次数、盐长度、派生长度、
// base64url 编码完全一致，D1 灾备副本才能独立验密、与主库互认同一份凭证。
//
// Worker 运行时没有 scrypt/argon2 原生能力，PBKDF2 是两端都原生支持的唯一慢哈希。

export const PBKDF2_ALGORITHM = 'pbkdf2-sha256';
export const PBKDF2_ITERATIONS = 310000;
export const PBKDF2_KEYLEN = 32;
export const PBKDF2_SALT_BYTES = 16;

const PHC_PREFIX = `$${PBKDF2_ALGORITHM}$`;
const TEXT_ENCODER = new TextEncoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : '';
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(text = '') {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(String(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 旧版单轮 SHA-256 凭证，仅用于验证升级前注册的存量用户。 */
export async function legacyPasswordHash(clientPasswordHash, salt) {
  return sha256Hex(`${salt}:${clientPasswordHash}`);
}

export function isPbkdf2Hash(stored = '') {
  return String(stored || '').startsWith(PHC_PREFIX);
}

async function deriveBits(clientPasswordHash, salt, iterations, lengthBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(String(clientPasswordHash)),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial,
      lengthBytes * 8
    )
  );
}

/** 生成自描述 PHC 字符串，盐内嵌在串内（与 Node 端同构）。 */
export async function hashPassword(clientPasswordHash) {
  const salt = new Uint8Array(PBKDF2_SALT_BYTES);
  crypto.getRandomValues(salt);
  const derived = await deriveBits(clientPasswordHash, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN);
  return `${PHC_PREFIX}${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * 验证登录凭证：PHC 走 PBKDF2，旧 hex 走 legacy SHA-256。
 * 任何格式错误都返回 false（调用方统一回 401），绝不抛异常。
 */
export async function verifyPassword(clientPasswordHash, stored, storedSalt = '') {
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
      const derived = await deriveBits(clientPasswordHash, salt, iterations, expected.length);
      return timingSafeEqualBytes(derived, expected);
    }
    if (!storedText) return false;
    const legacy = await legacyPasswordHash(clientPasswordHash, storedSalt || '');
    return timingSafeEqualBytes(
      TEXT_ENCODER.encode(legacy),
      TEXT_ENCODER.encode(storedText)
    );
  } catch {
    return false;
  }
}
