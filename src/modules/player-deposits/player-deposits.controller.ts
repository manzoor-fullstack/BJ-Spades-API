import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { PlayerDepositsService } from './player-deposits.service';

@ApiTags('player-deposits')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1/me')
export class PlayerDepositsController {
  constructor(private readonly service: PlayerDepositsService) {}

  @Post('deposits')
  @UseGuards(PlayerCsrfGuard)
  create(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() input: CreateDepositDto,
  ) {
    return this.service.create(player.id, input);
  }

  @Get('deposits')
  list(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.list(player.id);
  }

  @Get('deposits/:id')
  findOne(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.findOne(player.id, id);
  }

  @Post('deposits/:id/cancel')
  @UseGuards(PlayerCsrfGuard)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.cancel(player.id, id);
  }

  @Get('payment-methods')
  paymentMethods(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.paymentMethods(player.id);
  }
}
