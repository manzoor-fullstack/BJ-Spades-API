import { Module } from '@nestjs/common';

import { GhlTokenGuard } from './guards/ghl-token.guard';
import { WebhooksRepository } from './repositories/webhooks.repository';
import { SignatureService } from './services/signature.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * PrismaModule is @Global and ConfigModule is registered with isGlobal, so
 * neither needs importing here.
 *
 * SignatureService is exported because a second webhook source (Stripe, in a
 * later phase) verifies the same way and must not re-implement it.
 */
@Module({
  controllers: [WebhooksController],

  providers: [
    WebhooksService,
    WebhooksRepository,
    SignatureService,
    GhlTokenGuard,
  ],

  exports: [SignatureService],
})
export class WebhooksModule {}
