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
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { PlayerWithdrawalsService } from './player-withdrawals.service';

@ApiTags('player-withdrawals')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1/me')
export class PlayerWithdrawalsController {
  constructor(private readonly service: PlayerWithdrawalsService) {}

  @Get('payout-destinations')
  destinations(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.destinations(player.id);
  }

  @Post('payout-destinations/stripe/onboarding')
  @UseGuards(PlayerCsrfGuard)
  @HttpCode(HttpStatus.OK)
  onboarding(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.onboarding(player.id);
  }

  @Get('withdrawals')
  list(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.list(player.id);
  }

  @Get('withdrawals/:id')
  findOne(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.findOne(player.id, id);
  }

  @Post('withdrawals')
  @UseGuards(PlayerCsrfGuard)
  create(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() input: CreateWithdrawalDto,
  ) {
    return this.service.create(player.id, input);
  }

  @Post('withdrawals/:id/cancel')
  @UseGuards(PlayerCsrfGuard)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.cancel(player.id, id);
  }
}
