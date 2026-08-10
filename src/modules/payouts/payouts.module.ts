import { Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';
import { StripeModule } from '../stripe/stripe.module';

import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { PayoutsRepository } from './repositories/payouts.repository';

/**
 * PrismaModule, ActivityModule and TransactionsModule are all `@Global()`, so
 * only the Stripe gateway needs importing here. Nothing in this module names
 * `StripeService` — it injects `STRIPE_GATEWAY` (ADR-003).
 */
@Module({
  imports: [StripeModule, SettingsModule],
  controllers: [PayoutsController],
  providers: [PayoutsService, PayoutsRepository],
  exports: [PayoutsService, PayoutsRepository],
})
export class PayoutsModule {}
