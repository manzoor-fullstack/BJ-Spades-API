import { UnauthorizedException } from '@nestjs/common';

import { ErrorCode } from '../../../common/constants/error-codes';

/**
 * The single 401 the webhook endpoint ever returns.
 *
 * One message for a wrong signature, a missing header and a stale timestamp
 * alike: distinguishing them would tell an attacker which check it cleared,
 * turning the endpoint into a free oracle for forging requests.
 */
export class InvalidSignatureException extends UnauthorizedException {
  constructor() {
    super({
      code: ErrorCode.INVALID_SIGNATURE,
      message: 'Signature verification failed',
    });
  }
}
