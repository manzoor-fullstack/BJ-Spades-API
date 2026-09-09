import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { PlayerWalletService } from './player-wallet.service';

@ApiTags('player-wallet')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1/me')
export class PlayerWalletController {
  constructor(private readonly service: PlayerWalletService) {}

  @Get('wallet')
  wallet(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.getWallet(player.id);
  }

  @Get('transactions')
  transactions(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.listTransactions(player.id, query);
  }

  @Get('transactions/:id')
  transaction(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.getTransaction(player.id, id);
  }
}
