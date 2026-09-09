import { Module } from '@nestjs/common';

import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { PlayerOverviewController } from './player-overview.controller';
import { PlayerOverviewRepository } from './player-overview.repository';
import { PlayerOverviewService } from './player-overview.service';

@Module({
  imports: [PlayerAuthModule],
  controllers: [PlayerOverviewController],
  providers: [PlayerOverviewService, PlayerOverviewRepository],
})
export class PlayerOverviewModule {}
