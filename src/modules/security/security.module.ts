import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { SecurityRepository } from './repositories/security.repository';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';

@Module({
  // For AuthRepository. Session revocation — and the transaction that revokes
  // the refresh-token chain with it — stays in the module that owns sessions,
  // rather than being reimplemented here where it could drift.
  imports: [AuthModule],
  controllers: [SecurityController],
  providers: [SecurityService, SecurityRepository],
  exports: [SecurityService],
})
export class SecurityModule {}
