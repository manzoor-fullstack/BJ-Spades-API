import { Module } from '@nestjs/common';

import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { StorageModule } from '../storage/storage.module';
import { PlayerProfileController } from './player-profile.controller';
import { PlayerProfileService } from './player-profile.service';
import { PlayerProfileRepository } from './repositories/player-profile.repository';

@Module({
  imports: [PlayerAuthModule, StorageModule],
  controllers: [PlayerProfileController],
  providers: [PlayerProfileService, PlayerProfileRepository],
})
export class PlayerProfileModule {}
