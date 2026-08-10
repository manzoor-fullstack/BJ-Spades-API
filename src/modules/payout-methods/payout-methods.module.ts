import { Module } from '@nestjs/common';

import { PayoutMethodsController } from './payout-methods.controller';
import { PayoutMethodsService } from './payout-methods.service';
import { PayoutMethodsRepository } from './repositories/payout-methods.repository';

/** PrismaModule is `@Global()`, so nothing needs importing here. */
@Module({
  controllers: [PayoutMethodsController],
  providers: [PayoutMethodsService, PayoutMethodsRepository],
  exports: [PayoutMethodsService],
})
export class PayoutMethodsModule {}
