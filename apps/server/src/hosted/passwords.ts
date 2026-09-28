import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Account passwords on a hosted server: scrypt with a per-password salt,
 * stored as `scrypt$N$r$p$<salt>$<hash>` (base64url). Hashing runs on the
 * libuv pool so a sign-in does not block other requests.
 */

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...opts, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** A hash no password matches, so unknown emails take as long as wrong passwords. */
export const UNUSABLE_HASH = ['scrypt', N, R, P, Buffer.alloc(16).toString('base64url'), Buffer.alloc(KEY_LEN).toString('base64url')].join('$');

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (n !== N || r !== R || p !== P) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const want = Buffer.from(parts[5]!, 'base64url');
  const got = await derive(password, salt, { N: n, r, p });
  return want.length === got.length && timingSafeEqual(want, got) && stored !== UNUSABLE_HASH;
}
