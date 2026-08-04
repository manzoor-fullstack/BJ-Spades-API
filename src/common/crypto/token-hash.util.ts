import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Hashes a refresh token for storage.
 *
 * SHA-256, not bcrypt, and deliberately so: the token is a JWT with far more
 * entropy than a human password, so it needs no key stretching to resist
 * brute force. Refresh runs on a hot path where a deliberately slow hash would
 * be a self-inflicted bottleneck, and lookup requires a deterministic digest —
 * bcrypt's per-call salt would force a table scan.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Both inputs must be valid hex. `Buffer.from(str, 'hex')` silently truncates
 * at the first invalid character — so without the explicit check, two pieces of
 * non-hex garbage would both decode to an empty buffer and compare **equal**.
 */
export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;

  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');

  // A full decode yields exactly half as many bytes as hex characters.
  if (bufA.length * 2 !== a.length || bufB.length * 2 !== b.length) {
    return false;
  }

  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/** Cryptographically random hex string, for opaque identifiers. */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
