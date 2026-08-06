import { Module } from '@nestjs/common';

import { STRIPE_GATEWAY } from './stripe.interface';
import { StripeService } from './stripe.service';

/**
 * Nothing outside this module names `StripeService` — consumers inject
 * `STRIPE_GATEWAY` and see only the interface (ADR-003). That is what lets the
 * integration suite swap in a fake with `overrideProvider(STRIPE_GATEWAY)` and
 * guarantees no test ever reaches api.stripe.com.
 */
@Module({
  providers: [
    StripeService,
    { provide: STRIPE_GATEWAY, useExisting: StripeService },
  ],
  exports: [STRIPE_GATEWAY],
})
export class StripeModule {}
