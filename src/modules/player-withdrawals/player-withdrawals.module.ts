import { Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { PlayerWithdrawalsController } from './player-withdrawals.controller';
import { PlayerWithdrawalsService } from './player-withdrawals.service';
import { PlayerWithdrawalsRepository } from './repositories/player-withdrawals.repository';

@Module({
  imports: [PlayerAuthModule, SettingsModule, PayoutsModule],
  controllers: [PlayerWithdrawalsController],
  providers: [PlayerWithdrawalsService, PlayerWithdrawalsRepository],
  exports: [PlayerWithdrawalsService, PlayerWithdrawalsRepository],
})
export class PlayerWithdrawalsModule {}
