import { Module } from '@nestjs/common';

import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { StripeModule } from '../stripe/stripe.module';
import { PlayerDepositsController } from './player-deposits.controller';
import { PlayerDepositsService } from './player-deposits.service';
import { PlayerDepositsRepository } from './repositories/player-deposits.repository';

@Module({
  imports: [PlayerAuthModule, StripeModule],
  controllers: [PlayerDepositsController],
  providers: [PlayerDepositsService, PlayerDepositsRepository],
  exports: [PlayerDepositsService],
})
export class PlayerDepositsModule {}
