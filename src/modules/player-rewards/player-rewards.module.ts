import { Module } from '@nestjs/common';

import { PlayerAuthModule } from '../player-auth/player-auth.module';

import {
  PlayerRewardsController,
  RewardFulfilmentController,
} from './player-rewards.controller';
import { PlayerRewardsService } from './player-rewards.service';
import { RewardCodeVault } from './reward-code-vault.service';
import { PlayerRewardsRepository } from './repositories/player-rewards.repository';

@Module({
  imports: [PlayerAuthModule],
  controllers: [PlayerRewardsController, RewardFulfilmentController],
  providers: [PlayerRewardsService, PlayerRewardsRepository, RewardCodeVault],
  exports: [PlayerRewardsService],
})
export class PlayerRewardsModule {}
