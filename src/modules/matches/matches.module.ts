import { Module } from '@nestjs/common';

import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';

@Module({
  imports: [PlayerAuthModule],
  controllers: [MatchesController],
  providers: [MatchesService],
  exports: [MatchesService],
})
export class MatchesModule {}
