import { Module } from '@nestjs/common';

import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { PlayerMerchandiseController } from './player-merchandise.controller';
import { PlayerMerchandiseService } from './player-merchandise.service';
import { PlayerMerchandiseRepository } from './repositories/player-merchandise.repository';

@Module({
  imports: [PlayerAuthModule],
  controllers: [PlayerMerchandiseController],
  providers: [PlayerMerchandiseService, PlayerMerchandiseRepository],
  exports: [PlayerMerchandiseService],
})
export class PlayerMerchandiseModule {}
