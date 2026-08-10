import { Module } from '@nestjs/common';

import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
import { DisputesRepository } from './repositories/disputes.repository';

/** PrismaModule and ActivityModule are `@Global()`, so nothing to import. */
@Module({
  controllers: [DisputesController],
  providers: [DisputesService, DisputesRepository],
  exports: [DisputesService],
})
export class DisputesModule {}
