import { Module } from '@nestjs/common';

import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { ClaimsRepository } from './repositories/claims.repository';

/**
 * PrismaModule and ActivityModule are `@Global()`, so nothing needs importing
 * here — the audit trail is written by the interceptor behind `@AuditLog`.
 */
@Module({
  controllers: [ClaimsController],
  providers: [ClaimsService, ClaimsRepository],
  exports: [ClaimsService],
})
export class ClaimsModule {}
