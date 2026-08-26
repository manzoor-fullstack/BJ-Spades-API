import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import {
  hashToken,
  safeCompareHex,
} from '../../../common/crypto/token-hash.util';

/**
 * `Bearer <token>`, with the scheme matched case-insensitively.
 *
 * RFC 7235 makes the scheme case-insensitive and senders take that literally.
 * Matching only the exact string `Bearer ` turned a spec-valid `bearer <token>`
 * into a 401 that read as a wrong token — the worst kind of wrong answer,
 * because it sends the integrator looking at the value instead of the case.
 */
const BEARER_PATTERN = /^Bearer[ \t]+(\S.*)$/i;

/**
 * Fallback header, for senders that reserve `Authorization` for their own auth
 * configuration and drop or overwrite anything placed there.
 */
const TOKEN_HEADER = 'x-bjs-token';

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;

  return first?.trim() || undefined;
}

/** The presented token, or undefined when no recognisable one was sent. */
function extractToken(request: Request): string | undefined {
  const authorization = headerValue(request.headers.authorization);

  if (authorization !== undefined) {
    const match = BEARER_PATTERN.exec(authorization);

    // A present-but-unparseable Authorization is treated as absent rather than
    // falling through to the other header: mixing the two would let a
    // malformed value be silently rescued and hide the real mistake.
    return match?.[1]?.trim() || undefined;
  }

  return headerValue(request.headers[TOKEN_HEADER]);
}

/**
 * Static bearer-token auth for the GoHighLevel registration endpoint.
 *
 * GHL workflows can only send static values and merge fields, so they cannot
 * produce the per-request HMAC the signed endpoint requires. A shared token is
 * the weaker trade this buys: there is no replay window and no body integrity,
 * only proof that the caller holds the token. The duplicate check on
 * `contactId` absorbs most of the replay risk, and the endpoint must be served
 * over TLS — over plain HTTP a sniffed token is permanent access, where a
 * sniffed signature was worthless after 300 seconds.
 *
 * Throws rather than returning false: Nest turns a `false` into 403, and the
 * contract for a rejected webhook is 401.
 *
 * `GHL_WEBHOOK_AUTH_DISABLED=true` switches the check off entirely — an escape
 * hatch for the window where a sender cannot be made to send the header at all.
 * It is an env flag rather than a code change so turning auth back on is a
 * restart rather than a redeploy, and every admitted request is logged as a
 * warning: an endpoint that creates users must not sit open quietly.
 */
@Injectable()
export class GhlTokenGuard implements CanActivate {
  private readonly logger = new Logger(GhlTokenGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.get<boolean>('ghl.authDisabled')) {
      this.logger.warn(
        'GHL webhook auth is DISABLED — admitting an unauthenticated request. ' +
          'Unset GHL_WEBHOOK_AUTH_DISABLED to close this.',
      );

      return true;
    }

    const configured = this.config.get<string>('ghl.webhookToken');

    // Fails closed. The variable is optional at boot so existing deployments
    // keep starting; an endpoint nobody configured must refuse everything
    // rather than wave everything through.
    if (!configured) {
      throw new UnauthorizedException('Webhook token is not configured.');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = extractToken(request);

    if (provided === undefined) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    // Digests, not the raw strings: safeCompareHex needs hex of equal length,
    // and hashing first makes it work for any token format while giving away
    // nothing about the real token's length.
    if (!safeCompareHex(hashToken(provided), hashToken(configured))) {
      throw new UnauthorizedException('Invalid bearer token.');
    }

    return true;
  }
}
