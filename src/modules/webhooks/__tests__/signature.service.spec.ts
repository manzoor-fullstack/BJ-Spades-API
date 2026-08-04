import { createHmac } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import {
  MAX_CLOCK_SKEW_SECONDS,
  MAX_SIGNATURE_AGE_SECONDS,
  SignatureService,
} from '../services/signature.service';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

const BODY = JSON.stringify({
  event: 'user.registration',
  data: { fullName: 'David Kim', email: 'david.kim@email.com' },
});

function configWith(secret: string | undefined): ConfigService {
  return {
    get: (key: string): string | undefined =>
      key === 'webhook.secret' ? secret : undefined,
  } as unknown as ConfigService;
}

/** Signs the way the contract tells external senders to sign. */
function signExternally(
  timestamp: number | string,
  body: string,
  secret = SECRET,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('SignatureService', () => {
  let service: SignatureService;

  beforeEach(() => {
    service = new SignatureService(configWith(SECRET));
  });

  it('refuses to construct without a configured secret', () => {
    // A service that silently accepts every request because the secret was
    // missing is worse than one that will not boot.
    expect(() => new SignatureService(configWith(undefined))).toThrow(
      /WEBHOOK_SECRET/,
    );
  });

  it('produces the same digest an external sender would', () => {
    const timestamp = nowSeconds();

    expect(service.sign(timestamp, BODY)).toBe(signExternally(timestamp, BODY));
  });

  it('accepts a correctly signed, fresh request', () => {
    const timestamp = nowSeconds();

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${signExternally(timestamp, BODY)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: true });
  });

  it('rejects a tampered body', () => {
    const timestamp = nowSeconds();
    const signature = `sha256=${signExternally(timestamp, BODY)}`;

    const tampered = BODY.replace('David Kim', 'Mallory Kim');

    const result = service.verify({
      rawBody: Buffer.from(tampered, 'utf8'),
      signature,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects a body that differs only in whitespace', () => {
    // The exact failure the raw-body middleware exists to prevent: a
    // re-serialised object carries the same data and different bytes.
    const timestamp = nowSeconds();
    const reserialised = JSON.stringify(JSON.parse(BODY) as unknown, null, 2);

    const result = service.verify({
      rawBody: Buffer.from(reserialised, 'utf8'),
      signature: `sha256=${signExternally(timestamp, BODY)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects a stale timestamp', () => {
    const timestamp = nowSeconds() - (MAX_SIGNATURE_AGE_SECONDS + 1);

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${signExternally(timestamp, BODY)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'STALE_TIMESTAMP' });
  });

  it('accepts a timestamp right at the edge of the window', () => {
    const timestamp = nowSeconds() - (MAX_SIGNATURE_AGE_SECONDS - 5);

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${signExternally(timestamp, BODY)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: true });
  });

  it('rejects a timestamp far in the future', () => {
    const timestamp = nowSeconds() + MAX_CLOCK_SKEW_SECONDS + 60;

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${signExternally(timestamp, BODY)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'FUTURE_TIMESTAMP' });
  });

  it('tolerates a sender whose clock runs slightly fast', () => {
    const timestamp = nowSeconds() + 5;

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${signExternally(timestamp, BODY)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: true });
  });

  it('rejects a missing signature header', () => {
    const timestamp = nowSeconds();

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: undefined,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'MISSING_SIGNATURE' });
  });

  it('rejects a missing timestamp header', () => {
    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${signExternally(nowSeconds(), BODY)}`,
      timestamp: undefined,
    });

    expect(result).toEqual({ valid: false, reason: 'MISSING_TIMESTAMP' });
  });

  it('rejects a missing body', () => {
    const timestamp = nowSeconds();

    const result = service.verify({
      rawBody: undefined,
      signature: `sha256=${signExternally(timestamp, BODY)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'MISSING_BODY' });
  });

  it('rejects a non-numeric timestamp', () => {
    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${signExternally('now', BODY)}`,
      timestamp: 'now',
    });

    expect(result).toEqual({ valid: false, reason: 'MALFORMED_TIMESTAMP' });
  });

  it('rejects a signature without the sha256= prefix', () => {
    const timestamp = nowSeconds();

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: signExternally(timestamp, BODY),
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'MALFORMED_SIGNATURE' });
  });

  it('rejects a signature made with a different secret', () => {
    const timestamp = nowSeconds();

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${signExternally(timestamp, BODY, OTHER_SECRET)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects non-hex garbage rather than comparing two empty buffers', () => {
    // safeCompareHex, not Buffer.from(x, 'hex'): the latter truncates at the
    // first invalid character, so two pieces of garbage would decode to two
    // empty buffers and compare equal.
    const timestamp = nowSeconds();

    const result = service.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      signature: `sha256=${'z'.repeat(64)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('signs the exact bytes, not a re-encoded string', () => {
    const timestamp = nowSeconds();
    const unicodeBody = JSON.stringify({
      event: 'user.registration',
      data: { fullName: 'Renée Ødegård', email: 'renee@email.com' },
    });

    const result = service.verify({
      rawBody: Buffer.from(unicodeBody, 'utf8'),
      signature: `sha256=${signExternally(timestamp, unicodeBody)}`,
      timestamp: String(timestamp),
    });

    expect(result).toEqual({ valid: true });
  });
});
