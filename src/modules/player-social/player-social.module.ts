import { Module } from '@nestjs/common';

import { MatchesModule } from '../matches/matches.module';
import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { PlayerSocialController } from './player-social.controller';
import { PlayerSocialService } from './player-social.service';

@Module({
  imports: [PlayerAuthModule, MatchesModule],
  controllers: [PlayerSocialController],
  providers: [PlayerSocialService],
})
export class PlayerSocialModule {}
