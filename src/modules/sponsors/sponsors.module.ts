import { Module } from '@nestjs/common';

import { SponsorsRepository } from './repositories/sponsors.repository';
import { SponsorsController } from './sponsors.controller';
import { SponsorsService } from './sponsors.service';

/** PrismaModule and ActivityModule are `@Global()`, so nothing to import. */
@Module({
  controllers: [SponsorsController],
  providers: [SponsorsService, SponsorsRepository],
  exports: [SponsorsService],
})
export class SponsorsModule {}
