import { Module } from '@nestjs/common';

import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { PermissionsRepository } from './repositories/permissions.repository';

@Module({
  controllers: [PermissionsController],

  providers: [PermissionsService, PermissionsRepository],

  exports: [PermissionsService],
})
export class PermissionsModule {}
