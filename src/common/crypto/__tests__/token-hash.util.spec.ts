import { hashToken, randomHex, safeCompareHex } from '../token-hash.util';

describe('hashToken', () => {
  it('produces a 64-character hex SHA-256 digest', () => {
    const digest = hashToken('some.jwt.token');

    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — the same token always hashes identically', () => {
    // Lookup depends on this: a salted hash could not be queried by digest.
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('produces different digests for different tokens', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('never returns the input', () => {
    const token = 'header.payload.signature';
    expect(hashToken(token)).not.toContain(token);
  });

  it('handles an empty string', () => {
    expect(hashToken('')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('safeCompareHex', () => {
  it('returns true for identical digests', () => {
    const digest = hashToken('token');
    expect(safeCompareHex(digest, digest)).toBe(true);
  });

  it('returns false for different digests', () => {
    expect(safeCompareHex(hashToken('a'), hashToken('b'))).toBe(false);
  });

  it('returns false for different lengths rather than throwing', () => {
    // timingSafeEqual throws on length mismatch; the guard must absorb that.
    expect(safeCompareHex('abcd', 'abcdef')).toBe(false);
  });

  it('returns false for non-hex input rather than throwing', () => {
    expect(safeCompareHex('zzzz', 'zzzz')).toBe(false);
  });
});

describe('randomHex', () => {
  it('returns the requested byte length as hex', () => {
    expect(randomHex(16)).toHaveLength(32);
    expect(randomHex(32)).toHaveLength(64);
  });

  it('does not repeat across calls', () => {
    const values = new Set(Array.from({ length: 200 }, () => randomHex(16)));
    expect(values.size).toBe(200);
  });
});
