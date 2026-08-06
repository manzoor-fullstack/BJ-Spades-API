import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';

import { RewardsRepository } from './repositories/rewards.repository';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

@Module({
  // Icon uploads. Nothing here names LocalDiskStorageService — see ADR-003.
  imports: [StorageModule],
  controllers: [RewardsController],
  providers: [RewardsService, RewardsRepository],
  exports: [RewardsService, RewardsRepository],
})
export class RewardsModule {}
