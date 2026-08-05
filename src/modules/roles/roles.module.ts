import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { RolesRepository } from './repositories/roles.repository';

@Module({
  // For PermissionsGuard: replacing a role's permissions must evict the cache
  // held by the guard instance APP_GUARD uses, not a second copy of it.
  imports: [AuthModule],

  controllers: [RolesController],

  providers: [RolesService, RolesRepository],

  exports: [RolesService],
})
export class RolesModule {}
