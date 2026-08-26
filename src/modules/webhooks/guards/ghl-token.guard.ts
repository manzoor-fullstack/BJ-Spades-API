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

const BEARER_PREFIX = 'Bearer ';

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
    const header = request.headers.authorization;

    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    const provided = header.slice(BEARER_PREFIX.length).trim();

    // Digests, not the raw strings: safeCompareHex needs hex of equal length,
    // and hashing first makes it work for any token format while giving away
    // nothing about the real token's length.
    if (!safeCompareHex(hashToken(provided), hashToken(configured))) {
      throw new UnauthorizedException('Invalid bearer token.');
    }

    return true;
  }
}
