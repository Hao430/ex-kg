import crypto from 'node:crypto';

/**
 * Spec F5：scrypt 参数提升至 N=2^16 / r=8 / p=1（约 64MB 内存、单次 ≥200ms）。
 * 哈希格式带版本头以支持存量默认参数哈希的向后兼容与登录时透明升级：
 *   新格式：scrypt$65536$8$1$<salt>:<derivedKeyHex>
 *   旧格式：<salt>:<derivedKeyHex>（N=16384/r=8/p=1，Node scrypt 默认值）
 */
const SCRYPT_KEYLEN = 64;
const NEW_PREFIX = 'scrypt$';
const NEW_N = 2 ** 16;
const NEW_r = 8;
const NEW_p = 1;
const LEGACY_N = 16384; // Node crypto.scrypt 默认值
const LEGACY_r = 8;
const LEGACY_p = 1;
// N=2^16,r=8 需要约 64MB；maxmem 设 128MB 留余量
const MAXMEM = 128 * 1024 * 1024;

function derive(password: string, salt: string, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: MAXMEM }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey);
    });
  });
}

/**
 * Hash password with hardened scrypt params. Format: "scrypt$N$r$p$<salt>:<derivedKeyHex>"
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await derive(password, salt, SCRYPT_KEYLEN, NEW_N, NEW_r, NEW_p);
  return `${NEW_PREFIX}${NEW_N}$${NEW_r}$${NEW_p}$${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify password against stored hash（自动识别新/旧格式参数）
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return parseAndVerify(password, storedHash);
}

/**
 * 是否需要透明升级到新参数（旧格式无版本头）
 */
export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith(NEW_PREFIX);
}

function parseAndVerify(password: string, storedHash: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      let N = LEGACY_N;
      let r = LEGACY_r;
      let p = LEGACY_p;
      let rest = storedHash;

      if (storedHash.startsWith(NEW_PREFIX)) {
        const parts = storedHash.slice(NEW_PREFIX.length).split('$');
        if (parts.length !== 4) return resolve(false);
        N = parseInt(parts[0], 10);
        r = parseInt(parts[1], 10);
        p = parseInt(parts[2], 10);
        if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return resolve(false);
        rest = parts[3]; // "salt:key"
      }

      const [salt, key] = rest.split(':');
      if (!salt || !key) return resolve(false);

      derive(password, salt, SCRYPT_KEYLEN, N, r, p)
        .then((derivedKey) => {
          const keyBuffer = Buffer.from(key, 'hex');
          if (keyBuffer.length !== derivedKey.length) return resolve(false);
          resolve(crypto.timingSafeEqual(keyBuffer, derivedKey));
        })
        .catch(() => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Generate a cryptographically secure session token
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Check if account is currently locked due to failed attempts
 */
export function isAccountLocked(lockedUntil: string | Date | null | undefined): boolean {
  if (!lockedUntil) return false;
  return new Date(lockedUntil).getTime() > Date.now();
}

/**
 * Calculate remaining locked minutes
 */
export function getRemainingLockMinutes(lockedUntil: string | Date): number {
  const diffMs = new Date(lockedUntil).getTime() - Date.now();
  if (diffMs <= 0) return 0;
  return Math.max(1, Math.ceil(diffMs / 60000));
}
