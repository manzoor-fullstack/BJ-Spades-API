import { Module } from '@nestjs/common';

import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardRepository } from './leaderboard.repository';
import { LeaderboardService } from './leaderboard.service';

@Module({
  imports: [PlayerAuthModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardRepository, LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
