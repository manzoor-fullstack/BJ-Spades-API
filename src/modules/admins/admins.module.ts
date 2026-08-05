import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RolesModule } from '../roles/roles.module';
import { AdminsService } from './admins.service';
import { AdminsController } from './admins.controller';
import { AdminsRepository } from './repositories/admins.repository';

@Module({
  // AuthModule is imported for PermissionsGuard: a role change must evict the
  // cache held by the guard instance APP_GUARD uses, not a second copy of it.
  imports: [RolesModule, AuthModule],

  controllers: [AdminsController],

  providers: [AdminsService, AdminsRepository],

  exports: [AdminsService],
})
export class AdminsModule {}
