import { Module } from '@nestjs/common';

import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { PlayerWalletController } from './player-wallet.controller';
import { PlayerWalletService } from './player-wallet.service';
import { PlayerWalletRepository } from './repositories/player-wallet.repository';

@Module({
  imports: [PlayerAuthModule],
  controllers: [PlayerWalletController],
  providers: [PlayerWalletService, PlayerWalletRepository],
})
export class PlayerWalletModule {}
