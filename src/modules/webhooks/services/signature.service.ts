import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { safeCompareHex } from '../../../common/crypto/token-hash.util';

/** Header names, lower-cased because Node normalises inbound headers. */
export const SIGNATURE_HEADER = 'x-bjs-signature';
export const TIMESTAMP_HEADER = 'x-bjs-timestamp';
export const EVENT_ID_HEADER = 'x-bjs-event-id';
export const SOURCE_HEADER = 'x-bjs-source';

/** `X-BJS-Signature: sha256=<hex>` — the algorithm is part of the value. */
export const SIGNATURE_PREFIX = 'sha256=';

/**
 * How long a signed request stays acceptable. Caps the window in which a
 * captured request can be replayed (docs/specs/WEBHOOK-CONTRACT.md).
 */
export const MAX_SIGNATURE_AGE_SECONDS = 300;

/**
 * Tolerance for a sender whose clock runs fast. Without it, a machine a few
 * seconds ahead of ours would be rejected outright; without a bound, a sender
 * could mint a signature that stays valid indefinitely by dating it forward.
 */
export const MAX_CLOCK_SKEW_SECONDS = 60;

export type SignatureFailureReason =
  | 'MISSING_BODY'
  | 'MISSING_SIGNATURE'
  | 'MISSING_TIMESTAMP'
  | 'MALFORMED_TIMESTAMP'
  | 'MALFORMED_SIGNATURE'
  | 'STALE_TIMESTAMP'
  | 'FUTURE_TIMESTAMP'
  | 'SIGNATURE_MISMATCH';

export interface SignatureInput {
  /** The exact bytes received, never a re-serialised object. */
  rawBody: Buffer | undefined;
  /** Raw `X-BJS-Signature` header value. */
  signature: string | undefined;
  /** Raw `X-BJS-Timestamp` header value. */
  timestamp: string | undefined;
}

export type SignatureResult =
  { valid: true } | { valid: false; reason: SignatureFailureReason };

/** Only digits, and short enough that `Number()` stays exact. */
const TIMESTAMP_PATTERN = /^\d{1,15}$/;

@Injectable()
export class SignatureService {
  private readonly secret: string;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('webhook.secret');

    // Joi already requires WEBHOOK_SECRET at boot; failing loudly here too
    // means a misconfigured deployment never silently accepts every request.
    if (!secret) {
      throw new Error('WEBHOOK_SECRET is not configured.');
    }

    this.secret = secret;
  }

  /**
   * HMAC-SHA256 over `{timestamp}.{rawBody}`.
   *
   * Built as bytes rather than through a template literal so the digest is over
   * exactly what arrived on the wire — a template literal would decode the body
   * as UTF-8 and re-encode it, which is the same class of bug as re-serialising
   * the JSON.
   */
  sign(timestamp: string | number, rawBody: Buffer | string): string {
    const body = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody, 'utf8');
    const prefix = Buffer.from(`${timestamp}.`, 'utf8');

    return createHmac('sha256', this.secret)
      .update(Buffer.concat([prefix, body]))
      .digest('hex');
  }

  /**
   * Verifies freshness first, then the signature.
   *
   * The caller must map every failure to the same generic 401. The reason is
   * returned for server-side logging only: telling a caller *which* check
   * failed hands an attacker a free oracle.
   */
  verify(input: SignatureInput): SignatureResult {
    const { rawBody, signature, timestamp } = input;

    if (rawBody === undefined) {
      return { valid: false, reason: 'MISSING_BODY' };
    }

    if (!signature) {
      return { valid: false, reason: 'MISSING_SIGNATURE' };
    }

    if (!timestamp) {
      return { valid: false, reason: 'MISSING_TIMESTAMP' };
    }

    // Matched against the untrimmed header value: the sender signed that exact
    // string, so anything we would have to normalise cannot have been signed.
    if (!TIMESTAMP_PATTERN.test(timestamp)) {
      return { valid: false, reason: 'MALFORMED_TIMESTAMP' };
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - Number(timestamp);

    if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) {
      return { valid: false, reason: 'STALE_TIMESTAMP' };
    }

    if (ageSeconds < -MAX_CLOCK_SKEW_SECONDS) {
      return { valid: false, reason: 'FUTURE_TIMESTAMP' };
    }

    if (!signature.startsWith(SIGNATURE_PREFIX)) {
      return { valid: false, reason: 'MALFORMED_SIGNATURE' };
    }

    const received = signature.slice(SIGNATURE_PREFIX.length);
    const expected = this.sign(timestamp, rawBody);

    // safeCompareHex, never `===`. String comparison short-circuits on the
    // first differing byte and leaks the signature one byte at a time; it also
    // rejects non-hex input rather than treating two pieces of garbage as
    // equal, which a naive Buffer.from(x, 'hex') comparison would do.
    if (!safeCompareHex(received, expected)) {
      return { valid: false, reason: 'SIGNATURE_MISMATCH' };
    }

    return { valid: true };
  }
}
