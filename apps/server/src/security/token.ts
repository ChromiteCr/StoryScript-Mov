import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, base64url — the launch token printed as /#t=<token>. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time string comparison (hashing first hides length differences). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
