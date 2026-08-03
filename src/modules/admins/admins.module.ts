import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { AdminsService } from './admins.service';
import { AdminsController } from './admins.controller';
import { AdminsRepository } from './repositories/admins.repository';

@Module({
  imports: [RolesModule],

  controllers: [AdminsController],

  providers: [AdminsService, AdminsRepository],

  exports: [AdminsService],
})
export class AdminsModule {}
