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
import { CreatePlayerTournamentDto } from './dto/create-player-tournament.dto';
import { PlayerTournamentsService } from './player-tournaments.service';

@ApiTags('player-tournaments')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1')
export class PlayerTournamentsController {
  constructor(private readonly service: PlayerTournamentsService) {}

  @Get('tournaments/dashboard')
  dashboard(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.dashboard(player.id);
  }

  @Get('me/tournaments')
  mine(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.mine(player.id);
  }

  @Get('me/hosted-tournaments')
  hosted(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.hosted(player.id);
  }

  @Get('tournaments/:id')
  findOne(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.findOne(player.id, id);
  }

  @Post('tournaments')
  @UseGuards(PlayerCsrfGuard)
  create(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() input: CreatePlayerTournamentDto,
  ) {
    return this.service.create(player.id, input);
  }

  @Post('tournaments/:id/registrations')
  @UseGuards(PlayerCsrfGuard)
  join(@CurrentPlayer() player: AuthenticatedPlayer, @Param('id') id: string) {
    return this.service.join(player.id, id);
  }

  @Post('tournaments/:id/registrations/cancel')
  @UseGuards(PlayerCsrfGuard)
  @HttpCode(HttpStatus.OK)
  cancelRegistration(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.cancelRegistration(player.id, id);
  }

  @Post('tournaments/:id/cancel')
  @UseGuards(PlayerCsrfGuard)
  @HttpCode(HttpStatus.OK)
  cancelHosted(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.cancelHosted(player.id, id);
  }
}
