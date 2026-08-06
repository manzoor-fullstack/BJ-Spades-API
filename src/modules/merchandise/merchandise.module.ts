import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';

import { MerchandiseController } from './merchandise.controller';
import { MerchandiseService } from './merchandise.service';
import { MerchandiseRepository } from './repositories/merchandise.repository';

@Module({
  // Product photos. Nothing here names LocalDiskStorageService — see ADR-003.
  imports: [StorageModule],
  controllers: [MerchandiseController],
  providers: [MerchandiseService, MerchandiseRepository],
  exports: [MerchandiseService, MerchandiseRepository],
})
export class MerchandiseModule {}
